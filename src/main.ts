import {
	getLanguage,
	Notice,
	Platform,
	Plugin,
	TFile,
	TFolder,
	WorkspaceLeaf,
} from "obsidian";
import {
	PhysicalPageDeleteError,
	PhysicalPageDeleter,
	type PhysicalPageDeleteAdapter,
	type PhysicalPageDeletePlan,
} from "./core/physical-page-deleter";
import {
	PhysicalPageMoveError,
	PhysicalPageMover,
} from "./core/physical-page-mover";
import {
	PhysicalPageRenameError,
	PhysicalPageRenamer,
} from "./core/physical-page-renamer";
import {
	auditPhysicalTree,
	type PhysicalTreeAudit,
	type PhysicalTreeEntry,
} from "./core/physical-tree-auditor";
import {
	isPageInsideSubtree,
	movedPagePath,
	nextUntitledPagePath,
	pageFolderPath,
	replaceSubtreePath,
} from "./core/page-path";
import { INITIAL_PAGE_CONTENT } from "./core/page-content";
import { canonicalVaultPath } from "./core/tree-state";
import { TreeMutationService } from "./core/tree-mutation-service";
import { addPageOrder, archiveOrderPaths, remapOrderPaths, restoreOrderRecord } from "./core/order-maintenance";
import { isManagedMarkdownPath, pathMatchesEntry, VaultPathTracker, type VaultPathChange } from "./core/vault-path-tracker";
import { TreeStore } from "./core/tree-store";
import { projectTree, type ProjectedTreeNode } from "./core/tree-projection";
import { validateTreeState } from "./core/tree-validator";
import { getPageTreeTranslations, type PageTreeTranslations } from "./i18n";
import {
	PageTreeView,
	VIEW_TYPE_PAGE_TREE,
	type PageTreeLoadInfo,
	type PageMoveDestination,
	type PageTreeViewActions,
} from "./page-tree-view";
import { TreeRepository, type TreeLoadResult, type TreeLoadSource } from "./persistence/tree-repository";
import { LEGACY_LOCAL_VIEW_STATE_KEY, LOCAL_VIEW_STATE_KEY, LocalViewState } from "./persistence/local-view-state";
import { guardPluginDataStorage } from "./persistence/plugin-data-lifecycle";
import { LegacyPluginEnabledError, migrateLegacyPluginData } from "./persistence/legacy-plugin-migration";

export default class PageTreePlugin extends Plugin {
	private treeRepository!: TreeRepository;
	private treeStore!: TreeStore;
	private treeMutations!: TreeMutationService;
	private localViewState!: LocalViewState;
	private pageMover!: PhysicalPageMover;
	private createNativePageRenamer!: (file: TFile) => PhysicalPageRenamer;
	private pageDeleter!: PhysicalPageDeleter;
	private loadSource: TreeLoadSource = "empty";
	private loadIssueCount = 0;
	private pendingPageOperation: Promise<void> = Promise.resolve();
	private readonly pathTracker = new VaultPathTracker();
	private trackingReady = false;
	private unloading = false;
	private readonly internalCreates = new Set<string>();
	private readonly internalRenames: Array<{ from: string; to: string; folder: boolean }> = [];
	private readonly pairedRenameSources = new Map<TFile, { source: string; pending: number }>();
	private readonly pairingRenames: Array<{ from: string; to: string }> = [];
	private strings!: PageTreeTranslations;

	async onload(): Promise<void> {
		this.strings = getPageTreeTranslations(getLanguage());
		const storage = guardPluginDataStorage(this.app, this, () => !this.unloading);
		try {
			const migration = await migrateLegacyPluginData(storage, this.app.vault.adapter, this.app.vault.configDir);
			if (migration === "imported") new Notice(this.strings.notices.legacyDataImported);
		} catch (error) {
			new Notice(error instanceof LegacyPluginEnabledError
				? this.strings.notices.legacyPluginEnabled
				: this.strings.notices.legacyDataImportFailed, 10000);
			throw error;
		}
		this.treeRepository = new TreeRepository(storage);
		const loadResult = await this.treeRepository.load();
		this.applyLoadResult(loadResult);
		this.localViewState = new LocalViewState({
			load: () => this.app.loadLocalStorage(LOCAL_VIEW_STATE_KEY),
			loadLegacy: () => this.app.loadLocalStorage(LEGACY_LOCAL_VIEW_STATE_KEY),
			save: (value) => this.app.saveLocalStorage(LOCAL_VIEW_STATE_KEY, value),
		}, loadResult.state);
		if (this.localViewState.loadError !== undefined) {
			console.error("PageTree failed to load local view state", this.localViewState.loadError);
			new Notice(this.strings.notices.collapsedSaveFailed);
		}
		this.treeMutations = new TreeMutationService(this.treeStore, this.treeRepository);
		const physicalPageAdapter: PhysicalPageDeleteAdapter = {
			getEntryKind: (path) => {
				const entry = this.app.vault.getAbstractFileByPath(path);
				if (entry instanceof TFile) return "file";
				if (entry instanceof TFolder) return "folder";
				return null;
			},
			createFolder: async (path) => {
				await this.app.vault.createFolder(path);
			},
			move: async (sourcePath, targetPath) => {
				const entry = this.app.vault.getAbstractFileByPath(sourcePath);
				if (entry === null) throw new Error(`Missing source path: ${sourcePath}`);
				const scope = { from: sourcePath, to: targetPath, folder: entry instanceof TFolder };
				this.internalRenames.push(scope);
				try {
					await this.app.fileManager.renameFile(entry, targetPath);
				} finally {
					this.internalRenames.splice(this.internalRenames.indexOf(scope), 1);
				}
			},
			trash: async (path) => {
				const entry = this.app.vault.getAbstractFileByPath(path);
				if (entry === null) throw new Error(`Missing trash target: ${path}`);
				await this.app.vault.trash(entry, Platform.isDesktopApp);
			},
		};
		this.pageMover = new PhysicalPageMover(physicalPageAdapter);
		this.createNativePageRenamer = (file) => new PhysicalPageRenamer({
			...physicalPageAdapter,
			move: async (sourcePath, targetPath) => {
				const entry = this.app.vault.getAbstractFileByPath(sourcePath);
				if (!entry) throw new Error(`Missing source path: ${sourcePath}`);
				// A failed folder operation must never roll back a different file reusing this path.
				if (entry instanceof TFile && entry !== file) throw new Error("Native rename rollback target changed identity.");
				const scope = { from: sourcePath, to: targetPath };
				this.pairingRenames.push(scope);
				try {
					// Observe these actual folder moves (and rollbacks) in event order.
					await this.app.fileManager.renameFile(entry, targetPath);
				} finally {
					this.pairingRenames.splice(this.pairingRenames.indexOf(scope), 1);
				}
			},
		});
		this.pageDeleter = new PhysicalPageDeleter(physicalPageAdapter);
		this.registerEvent(this.app.vault.on("create", (entry) => {
			if (!this.trackingReady || !(entry instanceof TFile)) return;
			const change = this.pathTracker.create(entry.path);
			if (!this.internalCreates.has(canonicalVaultPath(entry.path))) this.queueOrderMaintenance(change);
		}));
		this.registerEvent(this.app.vault.on("rename", (entry, oldPath) => {
			this.updateLocalViewState(() => {
				this.localViewState.renamePath(oldPath, entry.path, entry instanceof TFolder);
			});
			if (!this.trackingReady) return;
			const change = this.pathTracker.rename(oldPath, entry.path, entry instanceof TFolder);
			if (entry instanceof TFolder) {
				for (const lineage of this.pairedRenameSources.values()) {
					if (pathMatchesEntry(lineage.source, oldPath, true)) {
						const suffix = lineage.source.split("/").slice(oldPath.split("/").length).join("/");
						lineage.source = `${entry.path}/${suffix}`;
					}
				}
			}
			const internal = this.internalRenames.some((scope) => (
				(oldPath === scope.from && entry.path === scope.to)
				|| (scope.folder && pathMatchesEntry(oldPath, scope.from, true)
					&& pathMatchesEntry(entry.path, scope.to, true))
			));
			if (internal) {
				if (entry instanceof TFile) this.pairedRenameSources.delete(entry);
				return;
			}
			// Metadata always follows each observed event, never a coalesced future name.
			this.queueOrderMaintenance(change);
			const pairingInternal = this.pairingRenames.some((scope) => scope.from === oldPath && scope.to === entry.path);
			if (entry instanceof TFile && isManagedMarkdownPath(oldPath)
				&& isManagedMarkdownPath(entry.path) && isNativeTitleRename(oldPath, entry.path)
				&& change.changes.length > 0 && !pairingInternal) {
				const lineage = this.pairedRenameSources.get(entry) ?? { source: oldPath, pending: 0 };
				lineage.pending += 1;
				this.pairedRenameSources.set(entry, lineage);
				this.queuePageOperation(async () => {
					try {
						await this.synchronizeNativePageRename(entry, lineage);
					} finally {
						lineage.pending -= 1;
						if (lineage.pending === 0 && this.pairedRenameSources.get(entry) === lineage) {
							this.pairedRenameSources.delete(entry);
						}
					}
				});
			} else if (entry instanceof TFile && !pairingInternal) {
				this.pairedRenameSources.delete(entry);
			}
		}));
		this.registerEvent(this.app.vault.on("delete", (entry) => {
			if (entry instanceof TFile) this.pairedRenameSources.delete(entry);
			if (entry instanceof TFolder) {
				for (const [file, lineage] of this.pairedRenameSources) {
					if (pathMatchesEntry(lineage.source, entry.path, true) || pathMatchesEntry(file.path, entry.path, true)) {
						this.pairedRenameSources.delete(file);
					}
				}
			}
			this.updateLocalViewState(() => {
				this.localViewState.removePath(entry.path, entry instanceof TFolder);
			});
			if (this.trackingReady) this.queueOrderMaintenance(this.pathTracker.delete(entry.path, entry instanceof TFolder));
		}));
		this.app.workspace.onLayoutReady(() => {
			if (this.unloading) return;
			// Initial indexing is observation, not a series of user-created pages.
			this.pathTracker.reset(this.getManagedMarkdownPaths());
			this.trackingReady = true;
		});

		this.registerView(
			VIEW_TYPE_PAGE_TREE,
			(leaf) => new PageTreeView(
				leaf,
				this.treeStore,
				() => this.getLoadInfo(),
				this.createViewActions(),
				this.strings,
			),
		);

		this.addRibbonIcon("list-tree", this.strings.commands.open, () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-page-tree",
			name: this.strings.commands.open,
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: "reload-page-tree",
			name: this.strings.commands.reload,
			callback: () => {
				void this.reloadTree();
			},
		});

		this.addCommand({
			id: "validate-page-tree",
			name: this.strings.commands.validate,
			callback: () => {
				const validation = validateTreeState(this.treeStore.getState());
				new Notice(
					validation.valid
						? this.strings.notices.validTree
						: this.strings.notices.invalidTree(validation.issues.length),
				);
			},
		});

		this.showRecoveryNotice(loadResult);
	}

	onunload(): void {
		this.unloading = true;
		this.trackingReady = false;
		this.pairedRenameSources.clear();
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_PAGE_TREE);
	}

	private async activateView(): Promise<void> {
		const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PAGE_TREE)[0];
		if (existingLeaf) {
			await this.app.workspace.revealLeaf(existingLeaf);
			return;
		}

		const leaf: WorkspaceLeaf | null = this.app.workspace.getLeftLeaf(false);
		if (!leaf) return;

		await leaf.setViewState({
			type: VIEW_TYPE_PAGE_TREE,
			active: true,
		});
		await this.app.workspace.revealLeaf(leaf);
	}

	private async reloadTree(): Promise<void> {
		try {
			await this.whenPageOperationsIdle();
			await this.treeMutations.whenIdle();
			const loadResult = await this.treeRepository.load();
			this.applyLoadResult(loadResult);
			this.refreshViews();
			this.showRecoveryNotice(loadResult, true);
		} catch (error) {
			console.error("PageTree failed to reload tree data", error);
			new Notice(this.strings.notices.reloadFailed);
		}
	}

	private createViewActions(): PageTreeViewActions {
		return {
			createRootPage: () => this.queueUntitledPageCreation(null),
			createChildPage: (parentPath) => this.queueUntitledPageCreation(parentPath),
			movePage: (sourcePath, destination) => {
				this.queuePageMove(sourcePath, destination);
			},
			deletePage: (sourcePath) => {
				this.queuePageDelete(sourcePath);
			},
			checkPageTree: () => this.auditPageTree(),
			archiveMissingOrder: (paths) => this.archiveMissingOrder(paths),
			createMissingParentPages: (paths) => this.createMissingParentPages(paths),
			restoreOrderRecord: (id) => this.restoreOrderHistory(id),
			isCollapsed: (pagePath) => this.localViewState.isCollapsed(pagePath),
			setCollapsed: (pagePath, collapsed) => {
				this.setCollapsed(pagePath, collapsed);
			},
		};
	}

	private async auditPageTree(): Promise<PhysicalTreeAudit> {
		await this.whenPageOperationsIdle();
		await this.treeMutations.whenIdle();
		return auditPhysicalTree(this.getPhysicalTreeEntries(), this.treeStore.getState());
	}

	private async archiveMissingOrder(records: Array<{ id: string; path: string }>): Promise<boolean> {
		if (!this.canMutateTree()) return false;
		return this.runMaintenanceAction(async () => {
			await this.treeMutations.run((tree) => {
				const existing = new Set(this.getManagedMarkdownPaths().map(canonicalVaultPath));
				const missing = records.filter((record) => {
					const node = tree.getNode(record.id);
					return node && canonicalVaultPath(node.path) === canonicalVaultPath(record.path)
						&& !existing.has(canonicalVaultPath(record.path));
				}).map((record) => record.path);
				archiveOrderPaths(tree, missing, "missing");
			});
			new Notice(this.strings.notices.orderHistorySaved);
		});
	}

	private async restoreOrderHistory(id: string): Promise<boolean> {
		if (!this.canMutateTree()) return false;
		let restored = false;
		const success = await this.runMaintenanceAction(async () => {
			restored = await this.treeMutations.run((tree) => restoreOrderRecord(tree, id, this.getManagedMarkdownPaths()));
			new Notice(restored ? this.strings.notices.orderHistoryRestored : this.strings.notices.orderHistoryRestoreBlocked);
		});
		return success && restored;
	}

	private async runMaintenanceAction(action: () => Promise<void>): Promise<boolean> {
		const operation = this.pendingPageOperation.then(async () => {
			if (this.unloading || !this.canMutateTree()) return false;
			try {
				await action();
				this.markCurrentStateLoaded();
				this.refreshViews();
				return true;
			} catch (error) {
				console.error("PageTree failed to maintain page order", error);
				new Notice(this.strings.notices.orderMaintenanceFailed);
				this.refreshViews();
				return false;
			}
		});
		this.pendingPageOperation = operation.then(() => undefined, () => undefined);
		return operation;
	}

	private async createMissingParentPages(paths: string[]): Promise<boolean> {
		if (!this.canMutateTree()) return false;
		return this.runMaintenanceAction(async () => {
			try {
				await this.treeMutations.whenIdle();
				const initialAudit = auditPhysicalTree(this.getPhysicalTreeEntries(), this.treeStore.getState());
				let createdPageCount = 0;
				const approved = new Set(paths.map(canonicalVaultPath));
				for (const pagePath of initialAudit.missingPageBodyPaths.filter((path) => approved.has(canonicalVaultPath(path)))) {
					if (this.app.vault.getAbstractFileByPath(pagePath) !== null) continue;
					const before = this.getManagedMarkdownPaths();
					await this.createPhysicalPage(pagePath);
					await this.treeMutations.run((tree) => addPageOrder(tree, before, pagePath));
					createdPageCount += 1;
				}
				new Notice(this.strings.notices.parentPagesCreated(createdPageCount));
			} catch (error) {
				new Notice(this.strings.notices.parentPagesCreateFailed);
				throw error;
			}
		});
	}

	private getPhysicalTreeEntries(): PhysicalTreeEntry[] {
		return this.app.vault.getAllLoadedFiles()
			.filter((entry) => entry.path.length > 0)
			.map((entry) => ({
				path: entry.path,
				kind: entry instanceof TFolder ? "folder" : "file",
			}));
	}

	private getManagedMarkdownPaths(): string[] {
		return this.app.vault.getMarkdownFiles()
			.map((file) => file.path)
			.filter((path) => !path.split("/").some((segment) => segment.startsWith(".")));
	}

	private queueUntitledPageCreation(parentPath: string | null): void {
		this.queuePageOperation(() => this.createUntitledPage(parentPath));
	}

	private queuePageMove(sourcePath: string, destination: PageMoveDestination): void {
		this.queuePageOperation(() => this.movePage(sourcePath, destination));
	}

	private queuePageDelete(sourcePath: string): void {
		this.queuePageOperation(() => this.deletePage(sourcePath));
	}

	private queuePageOperation(operation: () => Promise<void>): void {
		const guarded = async (): Promise<void> => {
			if (!this.unloading) await operation();
		};
		this.pendingPageOperation = this.pendingPageOperation.then(guarded, guarded);
	}

	private async whenPageOperationsIdle(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.pendingPageOperation;
			await pending;
		} while (pending !== this.pendingPageOperation);
	}

	private queueOrderMaintenance(change: VaultPathChange): void {
		if (change.added.length + change.removed.length + change.changes.length === 0) return;
		this.queuePageOperation(async () => {
			if (this.loadSource === "degraded") return;
			try {
				await this.applyOrderChange(change);
				this.markCurrentStateLoaded();
				this.refreshViews();
			} catch (error) {
				console.error("PageTree could not save file-event order metadata", error);
				new Notice(this.strings.notices.orderMaintenanceFailed);
			}
		});
	}

	private async applyOrderChange(change: VaultPathChange): Promise<void> {
		await this.treeMutations.run((tree) => {
			if (change.changes.length > 0) remapOrderPaths(tree, change.before, change.changes, change.after);
			if (change.removed.length > 0) archiveOrderPaths(tree, change.removed, "deleted");
			for (const path of change.added) addPageOrder(tree, change.before, path);
		});
	}

	private async createPhysicalPage(path: string): Promise<TFile> {
		const key = canonicalVaultPath(path);
		this.internalCreates.add(key);
		try {
			return await this.app.vault.create(path, INITIAL_PAGE_CONTENT);
		} finally {
			this.internalCreates.delete(key);
		}
	}

	private async createUntitledPage(parentPath: string | null): Promise<void> {
		if (!this.canMutateTree()) return;
		const targetPath = nextUntitledPagePath(
			parentPath,
			this.app.vault.getAllLoadedFiles().map((file) => file.path),
		);

		try {
			const before = this.getManagedMarkdownPaths();
			if (parentPath !== null) await this.ensurePageFolder(parentPath);
			const file = await this.createPhysicalPage(targetPath);
			try {
				await this.treeMutations.run((tree) => addPageOrder(tree, before, file.path));
				this.markCurrentStateLoaded();
				this.refreshViews();
				const leaf = this.app.workspace.getLeaf(false);
				await leaf.openFile(file);
				this.focusInlineTitle(leaf, file.path);
			} catch (error) {
				console.error("PageTree created a file but failed to save its tree node", error);
				this.refreshViews();
				new Notice(this.strings.notices.createdMetadataFailed(file.basename));
			}
		} catch (error) {
			console.error("PageTree failed to create Markdown file", error);
			new Notice(this.strings.notices.createFailed);
		}
	}

	private focusInlineTitle(
		leaf: WorkspaceLeaf,
		filePath: string,
		attemptsRemaining = 20,
	): void {
		if (this.app.workspace.getActiveFile()?.path !== filePath) return;
		const inlineTitle = leaf.view.containerEl.querySelector<HTMLElement>(".inline-title");
		if (inlineTitle !== null) {
			inlineTitle.focus();
			const selection = window.getSelection();
			if (selection !== null) {
				const range = document.createRange();
				range.selectNodeContents(inlineTitle);
				selection.removeAllRanges();
				selection.addRange(range);
			}
			return;
		}
		if (attemptsRemaining <= 0) return;
		window.setTimeout(() => {
			this.focusInlineTitle(leaf, filePath, attemptsRemaining - 1);
		}, 50);
	}

	private async movePage(sourcePath: string, destination: PageMoveDestination): Promise<void> {
		if (!this.canMutateTree()) return;
		const before = this.getManagedMarkdownPaths();
		const targetParentPath = destination.type === "inside"
			? destination.targetParentPath
			: destination.type === "root"
				? null
				: destination.targetParentPath;

		try {
			if (
				canonicalVaultPath(movedPagePath(sourcePath, targetParentPath))
				=== canonicalVaultPath(sourcePath)
			) {
				await this.commitPageMoveMetadata(sourcePath, targetParentPath, destination, before);
				this.markCurrentStateLoaded();
				this.refreshViews();
				return;
			}

			const result = await this.pageMover.movePage(
				sourcePath,
				targetParentPath,
				(plan) => this.commitPageMoveMetadata(
					plan.sourcePagePath,
					plan.targetParentPagePath,
					destination,
					before,
				),
			);
			if (!result.moved) return;

			this.markCurrentStateLoaded();
			this.refreshViews();
		} catch (error) {
			console.error("PageTree failed to move a physical page subtree", error);
			this.refreshViews();
			new Notice(createPageMoveErrorMessage(error, this.strings));
		}
	}

	private async commitPageMoveMetadata(
		sourcePagePath: string,
		targetParentPagePath: string | null,
		destination: PageMoveDestination,
		before: string[],
	): Promise<void> {
		const targetPagePath = movedPagePath(sourcePagePath, targetParentPagePath);
		const changes = before.filter((path) => canonicalVaultPath(path) === canonicalVaultPath(sourcePagePath)
			|| isPageInsideSubtree(path, sourcePagePath))
			.map((path) => ({ from: path, to: replaceSubtreePath(path, sourcePagePath, targetPagePath) }));
		await this.treeMutations.run((tree) => {
			let placement = destination.type === "before" || destination.type === "after"
				? { path: targetPagePath, targetPath: destination.targetPath, type: destination.type }
				: undefined;
			if (!placement && canonicalVaultPath(sourcePagePath) === canonicalVaultPath(targetPagePath)) {
				const siblings = findVisibleSiblings(projectTree(tree.getState(), before).roots, sourcePagePath);
				const last = siblings?.filter((node) => canonicalVaultPath(node.path) !== canonicalVaultPath(sourcePagePath)).at(-1);
				if (last) placement = { path: targetPagePath, targetPath: last.path, type: "after" };
			}
			remapOrderPaths(tree, before, changes, mappedPaths(before, changes),
				placement);
		});
		if (targetParentPagePath !== null) {
			this.updateLocalViewState(() => this.localViewState.setCollapsed(targetParentPagePath, false));
		}
	}

	private async synchronizeNativePageRename(
		file: TFile,
		lineage: { source: string; pending: number },
	): Promise<void> {
		// Physical pairing may skip intermediate titles; metadata still follows every actual event.
		const targetPath = file.path;
		if (this.unloading || this.pairedRenameSources.get(file) !== lineage
			|| this.app.vault.getAbstractFileByPath(targetPath) !== file) return;
		const physicalSource = lineage.source;
		if (physicalSource !== targetPath && !isNativeTitleRename(physicalSource, targetPath)) return;
		try {
			if (physicalSource !== targetPath) {
				await this.createNativePageRenamer(file).synchronizeExternalRename(physicalSource, targetPath, async () => undefined);
			}
			lineage.source = targetPath;
			this.refreshViews();
		} catch (error) {
			if (this.pairedRenameSources.get(file) === lineage) this.pairedRenameSources.delete(file);
			console.error("PageTree failed to synchronize an Obsidian title rename", error);
			this.refreshViews();
			new Notice(createPageRenameErrorMessage(error, this.strings));
		}
	}

	private async deletePage(sourcePath: string): Promise<void> {
		if (!this.canMutateTree()) return;
		const sourceEntry = this.app.vault.getAbstractFileByPath(sourcePath);
		const sourceTitle = sourceEntry instanceof TFile
			? sourceEntry.basename
			: sourcePath;

		try {
			await this.pageDeleter.deletePage(
				sourcePath,
				(plan) => this.commitPageDeleteMetadata(plan),
			);
			this.markCurrentStateLoaded();
			this.refreshViews();
			new Notice(this.strings.notices.deleteSuccess(sourceTitle));
		} catch (error) {
			console.error("PageTree failed to delete a physical page", error);
			this.refreshViews();
			new Notice(createPageDeleteErrorMessage(error, this.strings));
		}
	}

	private async commitPageDeleteMetadata(plan: PhysicalPageDeletePlan): Promise<void> {
		await this.treeMutations.run((tree) => {
			const subtreePaths = Object.values(tree.getState().nodes)
				.filter((node) => (
					canonicalVaultPath(node.path) === canonicalVaultPath(plan.sourcePagePath)
					|| isPageInsideSubtree(node.path, plan.sourcePagePath)
				))
				.map((node) => node.path);
			archiveOrderPaths(tree, subtreePaths, "deleted");
		});
	}

	private async ensurePageFolder(parentPath: string): Promise<void> {
		const folderPath = pageFolderPath(parentPath);
		const existing = this.app.vault.getAbstractFileByPath(folderPath);
		if (existing instanceof TFolder) return;
		if (existing !== null) {
			throw new Error(`Cannot create page folder because ${folderPath} is already a file.`);
		}
		await this.app.vault.createFolder(folderPath);
	}

	private setCollapsed(pagePath: string, collapsed: boolean): void {
		this.updateLocalViewState(() => this.localViewState.setCollapsed(pagePath, collapsed));
		this.refreshViews();
	}

	private updateLocalViewState(update: () => void): void {
		try {
			update();
		} catch (error) {
			console.error("PageTree failed to save collapsed state", error);
			new Notice(this.strings.notices.collapsedSaveFailed);
		}
	}

	private canMutateTree(): boolean {
		if (this.loadSource !== "degraded") return true;
		new Notice(this.strings.notices.degradedMutationBlocked);
		return false;
	}

	private markCurrentStateLoaded(): void {
		this.loadSource = "current";
		this.loadIssueCount = 0;
	}

	private applyLoadResult(loadResult: TreeLoadResult): void {
		if (this.treeStore) this.treeStore.replaceState(loadResult.state);
		else this.treeStore = new TreeStore(loadResult.state);
		this.loadSource = loadResult.source;
		this.loadIssueCount = loadResult.issues.length;
	}

	private getLoadInfo(): PageTreeLoadInfo {
		return {
			source: this.loadSource,
			issueCount: this.loadIssueCount,
		};
	}

	private refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PAGE_TREE)) {
			if (leaf.view instanceof PageTreeView) leaf.view.refresh();
		}
	}

	private showRecoveryNotice(loadResult: TreeLoadResult, always = false): void {
		if (loadResult.source === "backup") {
			new Notice(this.strings.notices.recoveredBackup);
		} else if (loadResult.source === "degraded") {
			new Notice(this.strings.notices.recoveredPhysical);
		} else if (always) {
			new Notice(this.strings.notices.reloadSuccess);
		}
	}
}

function createPageMoveErrorMessage(
	error: unknown,
	strings: PageTreeTranslations,
): string {
	if (!(error instanceof PhysicalPageMoveError)) {
		return strings.errors.moveUnknown;
	}

	switch (error.code) {
		case "would-create-cycle":
			return strings.errors.moveCycle;
		case "target-page-exists":
		case "target-folder-exists":
			return strings.errors.moveDestinationExists;
		case "target-container-blocked":
		case "source-folder-blocked":
			return strings.errors.moveFolderBlocked;
		case "target-parent-not-file":
		case "source-not-file":
			return strings.errors.moveMissingPage;
		case "metadata-commit-failed":
			return strings.errors.moveMetadata;
		case "physical-move-failed":
			return strings.errors.movePhysical;
		case "rollback-failed":
			return strings.errors.moveRollback;
	}
}

function createPageRenameErrorMessage(
	error: unknown,
	strings: PageTreeTranslations,
): string {
	if (!(error instanceof PhysicalPageRenameError)) {
		return strings.errors.renameUnknown;
	}

	switch (error.code) {
		case "invalid-target-title":
			return strings.errors.renameInvalidTitle;
		case "target-page-exists":
		case "target-folder-exists":
			return strings.errors.renameDestinationExists;
		case "source-folder-blocked":
			return strings.errors.renameFolderBlocked;
		case "source-not-file":
			return strings.errors.renameMissingPage;
		case "metadata-commit-failed":
			return strings.errors.renameMetadata;
		case "physical-rename-failed":
			return strings.errors.renamePhysical;
		case "rollback-failed":
			return strings.errors.renameRollback;
	}
}

function isNativeTitleRename(sourcePath: string, targetPath: string): boolean {
	const sourceSlashIndex = sourcePath.lastIndexOf("/");
	const targetSlashIndex = targetPath.lastIndexOf("/");
	const sourceParentPath = sourceSlashIndex < 0 ? "" : sourcePath.slice(0, sourceSlashIndex);
	const targetParentPath = targetSlashIndex < 0 ? "" : targetPath.slice(0, targetSlashIndex);
	if (canonicalVaultPath(sourceParentPath) !== canonicalVaultPath(targetParentPath)) return false;
	const sourceFilename = sourcePath.slice(sourceSlashIndex + 1);
	const targetFilename = targetPath.slice(targetSlashIndex + 1);
	return sourceFilename !== targetFilename;
}

function findVisibleSiblings(nodes: ProjectedTreeNode[], path: string): ProjectedTreeNode[] | null {
	if (nodes.some((node) => canonicalVaultPath(node.path) === canonicalVaultPath(path))) return nodes;
	for (const node of nodes) {
		const siblings = findVisibleSiblings(node.children, path);
		if (siblings) return siblings;
	}
	return null;
}

function mappedPaths(before: string[], changes: Array<{ from: string; to: string }>): string[] {
	const mapping = new Map(changes.map((change) => [canonicalVaultPath(change.from), change.to]));
	return before.map((path) => mapping.get(canonicalVaultPath(path)) ?? path);
}

function createPageDeleteErrorMessage(
	error: unknown,
	strings: PageTreeTranslations,
): string {
	if (!(error instanceof PhysicalPageDeleteError)) {
		return strings.errors.deleteUnknown;
	}

	switch (error.code) {
		case "source-not-file":
			return strings.errors.deleteMissingPage;
		case "source-folder-blocked":
			return strings.errors.deleteFolderBlocked;
		case "trash-failed":
			return strings.errors.deleteTrashFailed;
		case "partial-trash-failed":
			return strings.errors.deletePartial;
		case "metadata-commit-failed":
			return strings.errors.deleteMetadata;
	}
}
