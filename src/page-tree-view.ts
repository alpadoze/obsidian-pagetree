import {
	App,
	FileSystemAdapter,
	FuzzySuggestModal,
	ItemView,
	Menu,
	Modal,
	Notice,
	Platform,
	setIcon,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import {
	canMovePageUnder,
	isPageInsideSubtree,
	physicalParentPagePath,
} from "./core/page-path";
import {
	formatPageReference,
	type PageReferencePathResolver,
	type PageReferenceScope,
} from "./core/page-reference";
import type { PhysicalTreeAudit } from "./core/physical-tree-auditor";
import { projectTree, type ProjectedTreeNode } from "./core/tree-projection";
import { canonicalVaultPath } from "./core/tree-state";
import type { TreeStore } from "./core/tree-store";
import { isPageEffectivelyCollapsed } from "./core/tree-visibility";
import type { PageTreeTranslations } from "./i18n";
import type { TreeLoadSource } from "./persistence/tree-repository";

export const VIEW_TYPE_PAGE_TREE = "page-tree-view";
const PAGE_TREE_DRAG_TYPE = "application/x-page-tree-path";

export interface PageTreeLoadInfo {
	source: TreeLoadSource;
	issueCount: number;
}

export type PageMoveDestination =
	| { type: "inside"; targetParentPath: string }
	| { type: "root" }
	| {
		type: "before" | "after";
		targetPath: string;
		targetParentPath: string | null;
	};

export interface PageTreeViewActions {
	createRootPage(): void;
	createChildPage(parentPath: string): void;
	movePage(sourcePath: string, destination: PageMoveDestination): void;
	deletePage(sourcePath: string): void;
	checkPageTree(): Promise<PhysicalTreeAudit>;
	archiveMissingOrder(records: Array<{ id: string; path: string }>): Promise<boolean>;
	createMissingParentPages(paths: string[]): Promise<boolean>;
	restoreOrderRecord(id: string): Promise<boolean>;
	isCollapsed(pagePath: string): boolean;
	setCollapsed(pagePath: string, collapsed: boolean): void;
}

interface PageRowMoveContext {
	parentPath: string | null;
	previousSiblingPath: string | null;
	nextSiblingPath: string | null;
}

export class PageTreeView extends ItemView {
	private draggedPagePath: string | null = null;
	private readonly suppressedAutoRevealPaths = new Set<string>();
	private pendingRevealFrame: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly treeStore: TreeStore,
		private readonly getLoadInfo: () => PageTreeLoadInfo,
		private readonly actions: PageTreeViewActions,
		private readonly strings: PageTreeTranslations,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_PAGE_TREE;
	}

	getDisplayText(): string {
		return "PageTree";
	}

	getIcon(): string {
		return "list-tree";
	}

	async onOpen(): Promise<void> {
		const refresh = (): void => this.refresh();
		const revealActiveFile = (): void => {
			this.suppressedAutoRevealPaths.clear();
			this.refresh(true);
		};

		this.registerEvent(this.app.vault.on("create", refresh));
		this.registerEvent(this.app.vault.on("rename", refresh));
		this.registerEvent(this.app.vault.on("delete", refresh));
		this.registerEvent(this.app.workspace.on("file-open", revealActiveFile));

		revealActiveFile();
	}

	async onClose(): Promise<void> {
		this.cancelPendingReveal();
	}

	refresh(revealActiveFile = false): void {
		this.cancelPendingReveal();
		const scrollTop = this.contentEl.scrollTop;
		const scrollLeft = this.contentEl.scrollLeft;
		this.clearDragState();
		this.contentEl.empty();
		this.contentEl.addClass("page-tree-view");
		if (Platform.isMobile) this.contentEl.addClass("is-mobile");
		else this.contentEl.removeClass("is-mobile");

		const files = this.app.vault
			.getMarkdownFiles()
			.sort((a, b) => a.path.localeCompare(b.path));
		const filesByPath = new Map(files.map((file) => [file.path, file]));
		const state = this.treeStore.getState();
		const projection = projectTree(state, files.map((file) => file.path));
		const loadInfo = this.getLoadInfo();

		const header = this.contentEl.createDiv({ cls: "page-tree-header" });
		const heading = header.createDiv({ cls: "page-tree-heading" });
		heading.createEl("h4", { text: "PageTree" });
		heading.createDiv({
			cls: "page-tree-count",
			text: this.strings.view.pageCount(projection.pageCount),
		});
		const checkTreeButton = header.createEl("button", {
			cls: "clickable-icon page-tree-icon-button page-tree-header-action",
			attr: {
				"aria-label": this.strings.view.checkTree,
				"data-page-tree-action": "check-tree",
			},
		});
		checkTreeButton.type = "button";
		checkTreeButton.title = this.strings.view.checkTreeTitle;
		setIcon(checkTreeButton, "list-checks");
		checkTreeButton.addEventListener("click", () => {
			void this.checkPageTree(checkTreeButton);
		});
		const createRootButton = header.createEl("button", {
			cls: "clickable-icon page-tree-icon-button page-tree-header-action",
			attr: {
				"aria-label": this.strings.view.createRoot,
				"data-page-tree-action": "create-root",
			},
		});
		createRootButton.type = "button";
		createRootButton.title = this.strings.view.createRootTitle;
		setIcon(createRootButton, "plus");
		createRootButton.addEventListener("click", () => this.actions.createRootPage());

		const noticeText = createNoticeText(
			loadInfo,
			this.strings,
		);
		if (noticeText !== null) {
			const notice = this.contentEl.createDiv({
				cls: loadInfo.source === "degraded"
					? "page-tree-notice is-warning"
					: "page-tree-notice",
			});
			const noticeIcon = notice.createSpan({ cls: "page-tree-notice-icon" });
			setIcon(noticeIcon, loadInfo.source === "degraded" ? "triangle-alert" : "info");
			notice.createSpan({ text: noticeText });
		}

		const list = this.contentEl.createDiv({ cls: "page-tree-list" });
		list.setAttribute("role", "tree");
		list.setAttribute("aria-label", this.strings.view.treeLabel);

		if (files.length === 0) {
			const empty = list.createDiv({ cls: "page-tree-empty" });
			const emptyIcon = empty.createSpan({ cls: "page-tree-empty-icon" });
			setIcon(emptyIcon, "file-plus-2");
			empty.createDiv({ cls: "page-tree-empty-title", text: this.strings.view.emptyTitle });
			empty.createDiv({ cls: "page-tree-empty-description", text: this.strings.view.emptyDescription });
			const emptyAction = empty.createEl("button", { text: this.strings.view.createPage });
			emptyAction.type = "button";
			emptyAction.addEventListener("click", () => this.actions.createRootPage());
			return;
		}

		const activePath = this.app.workspace.getActiveFile()?.path;
		const activeAncestorPaths = findActiveAncestorPaths(projection.roots, activePath);
		for (const [rootIndex, root] of projection.roots.entries()) {
			this.renderBranch(
				root,
				projection.roots,
				rootIndex,
				list,
				filesByPath,
				activePath,
				activeAncestorPaths,
				0,
				null,
			);
		}
		if (!Platform.isMobile) this.renderRootDropZone();

		// Rebuilding the tree must not move the viewport when a branch is toggled.
		this.contentEl.scrollTop = scrollTop;
		this.contentEl.scrollLeft = scrollLeft;
		if (revealActiveFile && activePath !== undefined) {
			this.pendingRevealFrame = this.contentEl.win.requestAnimationFrame(() => {
				this.pendingRevealFrame = null;
				this.revealActivePage();
			});
		}
	}

	private cancelPendingReveal(): void {
		if (this.pendingRevealFrame === null) return;
		this.contentEl.win.cancelAnimationFrame(this.pendingRevealFrame);
		this.pendingRevealFrame = null;
	}

	private revealActivePage(): void {
		const row = this.contentEl.querySelector<HTMLElement>(".page-tree-row.is-active");
		if (!row || this.contentEl.clientHeight === 0) return;
		const viewport = this.contentEl.getBoundingClientRect();
		const header = this.contentEl.querySelector<HTMLElement>(".page-tree-header");
		const visibleTop = Math.max(viewport.top, header?.getBoundingClientRect().bottom ?? viewport.top);
		const bounds = row.getBoundingClientRect();
		// Scroll only the tree, not the surrounding mobile sidebar or document.
		if (bounds.top < visibleTop) this.contentEl.scrollTop += bounds.top - visibleTop;
		else if (bounds.bottom > viewport.bottom) this.contentEl.scrollTop += bounds.bottom - viewport.bottom;
	}

	private async checkPageTree(button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		try {
			const audit = await this.actions.checkPageTree();
			if (audit.issueCount === 0 && audit.orderHistoryRecords.length === 0) {
				new Notice(this.strings.notices.auditHealthy);
				return;
			}
			new PageTreeTreeAuditModal(
				this.app,
				audit,
				this.actions,
				this.strings,
			).open();
		} catch (error) {
			console.error("PageTree failed to check the physical page tree", error);
			new Notice(this.strings.notices.auditFailed);
		} finally {
			button.disabled = false;
		}
	}

	private renderBranch(
		node: ProjectedTreeNode,
		siblings: ProjectedTreeNode[],
		siblingIndex: number,
		container: HTMLElement,
		filesByPath: Map<string, TFile>,
		activePath: string | undefined,
		activeAncestorPaths: Set<string>,
		depth: number,
		parentPath: string | null,
	): void {
		const file = filesByPath.get(node.path);
		if (!file) return;

		const storedCollapsed = this.actions.isCollapsed(node.path);
		const collapsed = isPageEffectivelyCollapsed(
			storedCollapsed,
			activeAncestorPaths.has(node.path),
			this.suppressedAutoRevealPaths.has(canonicalVaultPath(node.path)),
		);
		const nextCollapsed = !collapsed;
		this.renderFile(
			file,
			container,
			file.path === activePath,
			depth,
			node.children.length > 0,
			collapsed,
			nextCollapsed,
			{
				parentPath,
				previousSiblingPath: siblings[siblingIndex - 1]?.path ?? null,
				nextSiblingPath: siblings[siblingIndex + 1]?.path ?? null,
			},
		);
		if (!collapsed) {
			for (const [childIndex, child] of node.children.entries()) {
				this.renderBranch(
					child,
					node.children,
					childIndex,
					container,
					filesByPath,
					activePath,
					activeAncestorPaths,
					depth + 1,
					node.path,
				);
			}
		}
	}

	private renderFile(
		file: TFile,
		container: HTMLElement,
		active: boolean,
		depth: number,
		hasChildren: boolean,
		collapsed: boolean,
		nextCollapsed: boolean,
		moveContext: PageRowMoveContext,
	): void {
		const classes = ["page-tree-row"];
		if (active) classes.push("is-active");
		if (hasChildren) classes.push("has-children");
		const wrapper = container.createDiv({ cls: classes.join(" ") });
		wrapper.style.setProperty("--page-tree-depth", depth.toString());
		wrapper.dataset.pagePath = file.path;
		wrapper.draggable = !Platform.isMobile;
		wrapper.setAttribute("role", "treeitem");
		wrapper.setAttribute("aria-level", (depth + 1).toString());
		if (hasChildren) wrapper.setAttribute("aria-expanded", collapsed ? "false" : "true");
		if (!Platform.isMobile) {
			this.registerPageDragEvents(wrapper, file.path, moveContext.parentPath);
		}

		if (hasChildren) {
			const toggle = wrapper.createEl("button", {
				cls: collapsed
					? "clickable-icon page-tree-icon-button page-tree-toggle"
					: "clickable-icon page-tree-icon-button page-tree-toggle is-expanded",
				attr: {
					"aria-label": collapsed
						? this.strings.view.expand(file.basename)
						: this.strings.view.collapse(file.basename),
					"aria-expanded": collapsed ? "false" : "true",
				},
			});
			toggle.type = "button";
			toggle.title = collapsed
				? this.strings.view.expandTitle
				: this.strings.view.collapseTitle;
			setIcon(toggle, "chevron-right");
			toggle.addEventListener("click", () => {
				const canonicalPath = canonicalVaultPath(file.path);
				if (nextCollapsed) this.suppressedAutoRevealPaths.add(canonicalPath);
				else this.suppressedAutoRevealPaths.delete(canonicalPath);
				this.actions.setCollapsed(file.path, nextCollapsed);
			});
		} else {
			wrapper.createSpan({ cls: "page-tree-branch-spacer", attr: { "aria-hidden": "true" } });
		}

		const pageIcon = wrapper.createSpan({
			cls: "page-tree-page-icon",
			attr: { "aria-hidden": "true" },
		});
		setIcon(pageIcon, "file-text");

		const pageButton = wrapper.createDiv({
			cls: "page-tree-item",
			text: file.basename,
			attr: { role: "button", tabindex: "0" },
		});
		pageButton.title = file.path;
		if (active) pageButton.setAttribute("aria-current", "page");
		const openPage = (): void => {
			void this.app.workspace.getLeaf(false).openFile(file);
		};
		pageButton.addEventListener("click", openPage);
		pageButton.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			openPage();
		});
		wrapper.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			this.createPageActionsMenu(file, hasChildren, moveContext)
				.showAtMouseEvent(event);
		});

		const createChildButton = wrapper.createEl("button", {
			cls: "clickable-icon page-tree-icon-button page-tree-add-child",
			attr: { "aria-label": this.strings.view.createChild(file.basename) },
		});
		createChildButton.type = "button";
		createChildButton.title = this.strings.view.createChildTitle;
		setIcon(createChildButton, "plus");
		createChildButton.addEventListener("click", () => {
			this.actions.createChildPage(file.path);
		});

		const actionsButton = wrapper.createEl("button", {
			cls: "clickable-icon page-tree-icon-button page-tree-row-action",
			attr: { "aria-label": this.strings.view.pageActions(file.basename) },
		});
		actionsButton.type = "button";
		actionsButton.title = this.strings.view.pageActions(file.basename);
		setIcon(actionsButton, "ellipsis");
		actionsButton.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			const bounds = actionsButton.getBoundingClientRect();
			this.createPageActionsMenu(file, hasChildren, moveContext).showAtPosition({
				x: bounds.right,
				y: bounds.bottom,
				left: true,
			});
		});
	}

	private createPageActionsMenu(
		file: TFile,
		hasChildren: boolean,
		moveContext: PageRowMoveContext,
	): Menu {
		const menu = new Menu();
		if (this.addCopyActions(menu, file, hasChildren)) menu.addSeparator();
		const previousSiblingPath = moveContext.previousSiblingPath;
		if (previousSiblingPath !== null) {
			menu.addItem((item) => item
				.setTitle(this.strings.movement.up)
				.setIcon("arrow-up")
				.onClick(() => this.actions.movePage(file.path, {
					type: "before",
					targetPath: previousSiblingPath,
					targetParentPath: moveContext.parentPath,
				})));
		}
		const nextSiblingPath = moveContext.nextSiblingPath;
		if (nextSiblingPath !== null) {
			menu.addItem((item) => item
				.setTitle(this.strings.movement.down)
				.setIcon("arrow-down")
				.onClick(() => this.actions.movePage(file.path, {
					type: "after",
					targetPath: nextSiblingPath,
					targetParentPath: moveContext.parentPath,
				})));
		}
		menu.addItem((item) => item
			.setTitle(this.strings.movement.under)
			.setIcon("corner-down-right")
			.onClick(() => this.openMoveParentModal(file)));
		if (moveContext.parentPath !== null) {
			menu.addItem((item) => item
				.setTitle(this.strings.movement.root)
				.setIcon("corner-up-left")
				.onClick(() => this.actions.movePage(file.path, { type: "root" })));
		}
		menu.addSeparator();
		menu.addItem((item) => item
			.setTitle(this.strings.deletion.menu)
			.setIcon("trash-2")
			.setWarning(true)
			.onClick(() => this.openDeleteModal(file, hasChildren)));
		return menu;
	}

	private addCopyActions(menu: Menu, file: TFile, hasChildren: boolean): boolean {
		if (Platform.isMobile || !(this.app.vault.adapter instanceof FileSystemAdapter)) {
			return false;
		}
		const fileSystemAdapter = this.app.vault.adapter;

		this.addCopyAction(
			menu,
			this.strings.copy.pageAbsolute,
			file.path,
			"page",
			(path) => fileSystemAdapter.getFullPath(path),
		);

		if (hasChildren) {
			this.addCopyAction(
				menu,
				this.strings.copy.subtreeAbsolute,
				file.path,
				"subtree",
				(path) => fileSystemAdapter.getFullPath(path),
			);
		}
		return true;
	}

	private addCopyAction(
		menu: Menu,
		title: string,
		pagePath: string,
		scope: PageReferenceScope,
		resolvePath: PageReferencePathResolver,
	): void {
		menu.addItem((item) => item
			.setTitle(title)
			.setIcon("copy")
			.onClick(() => {
				void this.copyPageReference(pagePath, scope, resolvePath);
			}));
	}

	private async copyPageReference(
		pagePath: string,
		scope: PageReferenceScope,
		resolvePath: PageReferencePathResolver,
	): Promise<void> {
		try {
			if (navigator.clipboard === undefined) throw new Error("Clipboard API is unavailable");
			const text = formatPageReference(pagePath, scope, resolvePath, {
				rootPage: this.strings.copy.rootPage,
				childPages: this.strings.copy.childPages,
			});
			await navigator.clipboard.writeText(text);
			new Notice(
				scope === "page"
					? this.strings.copy.pageCopied
					: this.strings.copy.subtreeCopied,
			);
		} catch (error) {
			console.error("PageTree failed to copy a page reference", error);
			new Notice(this.strings.copy.failed);
		}
	}

	private openMoveParentModal(file: TFile): void {
		const currentParentPath = physicalParentPagePath(file.path);
		const candidates = this.app.vault.getMarkdownFiles()
			.filter((candidate) => canMovePageUnder(file.path, candidate.path))
			.filter((candidate) => (
				currentParentPath === null
				|| canonicalVaultPath(candidate.path) !== canonicalVaultPath(currentParentPath)
			))
			.sort((left, right) => left.path.localeCompare(right.path));
		if (candidates.length === 0) {
			new Notice(this.strings.movement.noAvailableParent);
			return;
		}
		new PageTreeMoveParentModal(
			this.app,
			candidates,
			(targetParentPath) => this.actions.movePage(file.path, {
				type: "inside",
				targetParentPath,
			}),
			this.strings,
		).open();
	}

	private openDeleteModal(file: TFile, hasChildren: boolean): void {
		new PageTreeDeleteConfirmModal(
			this.app,
			file.basename,
			hasChildren,
			() => this.actions.deletePage(file.path),
			this.strings,
		).open();
	}

	private registerPageDragEvents(
		wrapper: HTMLElement,
		pagePath: string,
		parentPath: string | null,
	): void {
		wrapper.addEventListener("dragstart", (event) => {
			this.draggedPagePath = pagePath;
			if (event.dataTransfer !== null) {
				event.dataTransfer.effectAllowed = "move";
				event.dataTransfer.setData(PAGE_TREE_DRAG_TYPE, pagePath);
				event.dataTransfer.setData("text/plain", pagePath);
			}
			this.contentEl.addClass("is-dragging-page");
			this.contentEl.querySelector<HTMLElement>(".page-tree-root-drop-zone")
				?.setAttribute("aria-hidden", "false");
			requestAnimationFrame(() => wrapper.addClass("is-dragging"));
		});

		wrapper.addEventListener("dragover", (event) => {
			const sourcePath = this.getDraggedPagePath(event);
			const position = resolvePageDropPosition(event, wrapper);
			if (!canDropPage(sourcePath, pagePath, parentPath, position)) return;
			event.preventDefault();
			event.stopPropagation();
			if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
			this.clearDropTargets();
			wrapper.addClass(
				position === "inside"
					? "is-drop-target"
					: position === "before"
						? "is-drop-before"
						: "is-drop-after",
			);
		});

		wrapper.addEventListener("dragleave", (event) => {
			if (event.relatedTarget instanceof Node && wrapper.contains(event.relatedTarget)) return;
			wrapper.removeClass("is-drop-target", "is-drop-before", "is-drop-after");
		});

		wrapper.addEventListener("drop", (event) => {
			const sourcePath = this.getDraggedPagePath(event);
			const position = resolvePageDropPosition(event, wrapper);
			if (!canDropPage(sourcePath, pagePath, parentPath, position)) return;
			event.preventDefault();
			event.stopPropagation();
			this.clearDragState();
			this.actions.movePage(
				sourcePath,
				position === "inside"
					? { type: "inside", targetParentPath: pagePath }
					: {
						type: position,
						targetPath: pagePath,
						targetParentPath: parentPath,
					},
			);
		});

		wrapper.addEventListener("dragend", () => this.clearDragState());
	}

	private renderRootDropZone(): void {
		const dropZone = this.contentEl.createDiv({
			cls: "page-tree-root-drop-zone",
			attr: {
				role: "button",
				"aria-label": this.strings.view.moveToRoot,
				"aria-hidden": "true",
			},
		});
		const icon = dropZone.createSpan({ cls: "page-tree-root-drop-icon" });
		setIcon(icon, "corner-up-left");
		dropZone.createSpan({ text: this.strings.view.moveToRoot });

		dropZone.addEventListener("dragover", (event) => {
			const sourcePath = this.getDraggedPagePath(event);
			if (sourcePath === null || physicalParentPagePath(sourcePath) === null) return;
			event.preventDefault();
			if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
			this.clearDropTargets();
			dropZone.addClass("is-drop-target");
		});
		dropZone.addEventListener("dragleave", (event) => {
			if (event.relatedTarget instanceof Node && dropZone.contains(event.relatedTarget)) return;
			dropZone.removeClass("is-drop-target");
		});
		dropZone.addEventListener("drop", (event) => {
			const sourcePath = this.getDraggedPagePath(event);
			if (sourcePath === null || physicalParentPagePath(sourcePath) === null) return;
			event.preventDefault();
			this.clearDragState();
			this.actions.movePage(sourcePath, { type: "root" });
		});
	}

	private getDraggedPagePath(event: DragEvent): string | null {
		if (this.draggedPagePath !== null) return this.draggedPagePath;
		const transferredPath = event.dataTransfer?.getData(PAGE_TREE_DRAG_TYPE) ?? "";
		return transferredPath.length > 0 ? transferredPath : null;
	}

	private clearDropTargets(): void {
		this.contentEl
			.querySelectorAll<HTMLElement>(".is-drop-target, .is-drop-before, .is-drop-after")
			.forEach((target) => {
				target.removeClass("is-drop-target", "is-drop-before", "is-drop-after");
		});
	}

	private clearDragState(): void {
		this.draggedPagePath = null;
		this.contentEl.removeClass("is-dragging-page");
		this.contentEl.querySelector<HTMLElement>(".page-tree-root-drop-zone")
			?.setAttribute("aria-hidden", "true");
		this.contentEl
			.querySelectorAll<HTMLElement>(
				".is-dragging, .is-drop-target, .is-drop-before, .is-drop-after",
			)
			.forEach((target) => {
				target.removeClass(
					"is-dragging",
					"is-drop-target",
					"is-drop-before",
					"is-drop-after",
				);
			});
	}
}

type PageDropPosition = "before" | "inside" | "after";

function resolvePageDropPosition(event: DragEvent, wrapper: HTMLElement): PageDropPosition {
	const bounds = wrapper.getBoundingClientRect();
	const relativeY = bounds.height <= 0 ? 0.5 : (event.clientY - bounds.top) / bounds.height;
	if (relativeY < 0.25) return "before";
	if (relativeY > 0.75) return "after";
	return "inside";
}

function canDropPage(
	sourcePath: string | null,
	targetPath: string,
	targetParentPath: string | null,
	position: PageDropPosition,
): sourcePath is string {
	if (sourcePath === null) return false;
	if (canonicalVaultPath(sourcePath) === canonicalVaultPath(targetPath)) return false;
	const effectiveParentPath = position === "inside" ? targetPath : targetParentPath;
	if (effectiveParentPath === null) return true;
	if (canonicalVaultPath(sourcePath) === canonicalVaultPath(effectiveParentPath)) return false;
	return !isPageInsideSubtree(effectiveParentPath, sourcePath);
}

class PageTreeMoveParentModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly candidates: TFile[],
		private readonly onChooseParent: (path: string) => void,
		private readonly strings: PageTreeTranslations,
	) {
		super(app);
		this.setPlaceholder(this.strings.movement.chooseParent);
		this.emptyStateText = this.strings.movement.noAvailableParent;
	}

	getItems(): TFile[] {
		return this.candidates;
	}

	getItemText(file: TFile): string {
		return file.path.replace(/\.md$/i, "");
	}

	onChooseItem(file: TFile): void {
		this.onChooseParent(file.path);
	}
}

class PageTreeDeleteConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly pageTitle: string,
		private readonly hasChildren: boolean,
		private readonly onConfirm: () => void,
		private readonly strings: PageTreeTranslations,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("page-tree-delete-confirm-modal");
		this.titleEl.setText(this.strings.deletion.title(this.pageTitle));
		this.contentEl.createEl("p", {
			cls: "page-tree-delete-description",
			text: this.strings.deletion.description,
		});
		if (this.hasChildren) {
			this.contentEl.createEl("p", {
				cls: "page-tree-delete-confirm-warning",
				text: this.strings.deletion.childWarning,
			});
		}

		const actions = this.contentEl.createDiv({ cls: "page-tree-delete-actions" });
		const cancelButton = actions.createEl("button", { text: this.strings.deletion.cancel });
		cancelButton.type = "button";
		cancelButton.addEventListener("click", () => this.close());
		const confirmButton = actions.createEl("button", {
			cls: "mod-warning page-tree-delete-confirm",
			text: this.strings.deletion.confirm,
		});
		confirmButton.type = "button";
		confirmButton.addEventListener("click", () => {
			this.onConfirm();
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class PageTreeTreeAuditModal extends Modal {
	constructor(
		app: App,
		private readonly audit: PhysicalTreeAudit,
		private readonly actions: PageTreeViewActions,
		private readonly strings: PageTreeTranslations,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("page-tree-audit-modal");
		this.titleEl.setText(this.strings.audit.title);
		this.contentEl.createEl("p", {
			cls: "page-tree-audit-description",
			text: this.strings.audit.summary(this.audit.issueCount),
		});

		const stalePaths = this.audit.staleMetadataNodes.map((node) => node.path);
		const staleGroup = this.addIssueGroup(
			this.strings.audit.extraOrder,
			stalePaths,
		);
		if (staleGroup !== null) {
			staleGroup.createEl("p", { text: this.strings.audit.archiveOrderNote });
			this.addAction(staleGroup, "archive-missing-order", this.strings.audit.archiveOrder, () => {
				this.confirmPaths({
					title: this.strings.audit.archiveOrder,
					note: this.strings.audit.archiveOrderNote,
					paths: [...stalePaths],
					actionId: "confirm-archive-missing-order",
					confirmLabel: this.strings.audit.archiveOrderConfirm,
					failureMessage: this.strings.notices.orderMaintenanceFailed,
					onConfirm: (paths) => this.actions.archiveMissingOrder(
						this.audit.staleMetadataNodes.filter((node) => paths.includes(node.path)).map((node) => ({ ...node })),
					),
				});
			});
		}
		const parentGroup = this.addIssueGroup(this.strings.audit.missingParents, this.audit.missingPageBodyPaths);
		if (parentGroup !== null) {
			this.addAction(parentGroup, "create-missing-parent-pages", this.strings.audit.createParents, () => {
				this.confirmPaths({
					title: this.strings.audit.createParents,
					note: this.strings.audit.createParentsNote,
					paths: [...this.audit.missingPageBodyPaths],
					actionId: "confirm-create-parent-pages",
					confirmLabel: this.strings.audit.createParentsConfirm,
					failureMessage: this.strings.notices.parentPagesCreateFailed,
					onConfirm: (paths) => this.actions.createMissingParentPages(paths),
				});
			});
		}
		this.addIssueGroup(
			this.strings.audit.pathConflicts,
			this.audit.conflicts.map((conflict) => (
				conflict.type === "page-body-blocked"
					? this.strings.audit.pageBodyBlocked(conflict.path)
					: this.strings.audit.pairedFolderBlocked(conflict.path, conflict.relatedPath)
			)),
		);

		if (this.audit.conflicts.length > 0) {
			this.contentEl.createEl("p", {
				cls: "page-tree-audit-warning",
				text: this.strings.audit.conflictWarning(this.audit.conflicts.length),
			});
		}
		this.addOrderHistory();

		const actions = this.contentEl.createDiv({ cls: "page-tree-audit-actions" });
		const cancelButton = actions.createEl("button", {
			text: this.strings.audit.close,
			attr: { "data-page-tree-action": "close-audit" },
		});
		cancelButton.type = "button";
		cancelButton.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private addIssueGroup(title: string, paths: string[]): HTMLDivElement | null {
		if (paths.length === 0) return null;
		const group = this.contentEl.createDiv({ cls: "page-tree-audit-group" });
		group.createDiv({
			cls: "page-tree-audit-group-title",
			text: `${title} (${paths.length})`,
		});
		const list = group.createEl("ul", { cls: "page-tree-audit-list" });
		for (const path of paths) list.createEl("li", { text: path });
		return group;
	}

	private addAction(container: HTMLElement, actionId: string, label: string, onClick: () => void): HTMLButtonElement {
		const button = container.createEl("button", {
			text: label,
			attr: { "data-page-tree-action": actionId },
		});
		button.type = "button";
		button.addEventListener("click", onClick);
		return button;
	}

	private confirmPaths(confirmation: PageTreeAuditConfirmation): void {
		new PageTreeAuditConfirmModal(this.app, {
			...confirmation,
			onConfirm: async (paths) => {
				const completed = await confirmation.onConfirm(paths);
				if (completed) this.close();
				return completed;
			},
		}, this.strings).open();
	}

	private addOrderHistory(): void {
		if (this.audit.orderHistoryRecords.length === 0) return;
		const group = this.contentEl.createDiv({ cls: "page-tree-audit-group page-tree-order-history" });
		group.createDiv({
			cls: "page-tree-audit-group-title",
			text: `${this.strings.audit.orderHistory} (${this.audit.orderHistoryRecords.length})`,
		});
		group.createEl("p", { text: this.strings.audit.historyNote });
		const list = group.createEl("ul", { cls: "page-tree-audit-list" });
		for (const record of this.audit.orderHistoryRecords) {
			const item = list.createEl("li", { attr: { "data-order-record-id": record.id } });
			item.createDiv({ text: record.path });
			item.createDiv({ text: record.reason === "deleted" ? this.strings.audit.historyDeleted : this.strings.audit.historyMissing });
			item.createDiv({ text: this.strings.audit.historyArchivedAt(new Date(record.archivedAt).toLocaleString()) });
			if (!record.canRestore) {
				item.createDiv({
					text: record.restoreBlockedReason === "missing-file"
						? this.strings.audit.historyFileMissing
						: this.strings.audit.historyActiveRecord,
				});
			}
			const restoreLabel = record.reason === "missing" ? this.strings.audit.undoOrderCleanup : this.strings.audit.restoreOrder;
			const restoreButton = this.addAction(item, "restore-order-record", restoreLabel, () => {
				void this.restoreOrder(record.id);
			});
			restoreButton.setAttribute("data-order-record-id", record.id);
			restoreButton.disabled = !record.canRestore;
		}
	}

	private async restoreOrder(id: string): Promise<void> {
		const buttons = Array.from(this.contentEl.querySelectorAll<HTMLButtonElement>("button"));
		const previousDisabled = buttons.map((button) => button.disabled);
		for (const button of buttons) button.disabled = true;
		try {
			if (await this.actions.restoreOrderRecord(id)) this.close();
		} catch (error) {
			console.error("PageTree failed to restore an order record", error);
			new Notice(this.strings.notices.orderMaintenanceFailed);
		} finally {
			buttons.forEach((button, index) => { button.disabled = previousDisabled[index] ?? false; });
		}
	}
}

interface PageTreeAuditConfirmation {
	title: string;
	note: string;
	paths: string[];
	actionId: string;
	confirmLabel: string;
	failureMessage: string;
	onConfirm(paths: string[]): Promise<boolean>;
}

class PageTreeAuditConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly confirmation: PageTreeAuditConfirmation,
		private readonly strings: PageTreeTranslations,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("page-tree-audit-confirm-modal");
		this.titleEl.setText(this.confirmation.title);
		this.contentEl.createEl("p", { text: this.confirmation.note });
		const list = this.contentEl.createEl("ul", { cls: "page-tree-audit-list" });
		for (const path of this.confirmation.paths) {
			list.createEl("li", { text: path, attr: { "data-page-path": path } });
		}
		const actions = this.contentEl.createDiv({ cls: "page-tree-audit-actions" });
		const cancel = actions.createEl("button", {
			text: this.strings.audit.cancel,
			attr: { "data-page-tree-action": "cancel-audit-confirmation" },
		});
		cancel.type = "button";
		cancel.addEventListener("click", () => this.close());
		const confirm = actions.createEl("button", {
			cls: "mod-cta",
			text: this.confirmation.confirmLabel,
			attr: { "data-page-tree-action": this.confirmation.actionId },
		});
		confirm.type = "button";
		confirm.addEventListener("click", () => { void this.submit(cancel, confirm); });
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async submit(cancel: HTMLButtonElement, confirm: HTMLButtonElement): Promise<void> {
		cancel.disabled = true;
		confirm.disabled = true;
		confirm.setText(this.strings.audit.actionPending);
		try {
			// Pass exactly the previewed paths, even if the vault changed while open.
			if (await this.confirmation.onConfirm([...this.confirmation.paths])) this.close();
		} catch (error) {
			console.error("PageTree maintenance action failed", error);
			new Notice(this.confirmation.failureMessage);
		} finally {
			cancel.disabled = false;
			confirm.disabled = false;
			confirm.setText(this.confirmation.confirmLabel);
		}
	}
}


function findActiveAncestorPaths(
	roots: ProjectedTreeNode[],
	activePath: string | undefined,
): Set<string> {
	const ancestorPaths = new Set<string>();
	if (activePath === undefined) return ancestorPaths;

	const findActiveBranch = (node: ProjectedTreeNode): boolean => {
		if (node.path === activePath) return true;
		for (const child of node.children) {
			if (findActiveBranch(child)) {
				ancestorPaths.add(node.path);
				return true;
			}
		}
		return false;
	};

	for (const root of roots) {
		if (findActiveBranch(root)) break;
	}
	return ancestorPaths;
}

function createNoticeText(
	loadInfo: PageTreeLoadInfo,
	strings: PageTreeTranslations,
): string | null {
	if (loadInfo.source === "degraded") {
		return strings.view.loadDegraded(loadInfo.issueCount);
	}
	if (loadInfo.source === "backup") {
		return strings.view.loadBackup;
	}
	return null;
}
