import type { App, PluginManifest, WorkspaceLeaf } from "obsidian";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import PageTreePlugin from "../src/main";
import type { PageTreeViewActions } from "../src/page-tree-view";
import type { ParentPageCreationProgress } from "../src/core/physical-tree-auditor";
import { captureOrderGroups, isSharedOrderPath, SHARED_ORDER_FOLDER } from "../src/core/shared-order";
import type { TreeStore } from "../src/core/tree-store";

const host = vi.hoisted(() => {
	vi.stubGlobal("window", {});
	return {
		registerView: vi.fn(),
		addCommand: vi.fn(),
		saveData: vi.fn(async () => {}),
	};
});

vi.mock("obsidian", () => ({
	getLanguage: () => "en",
	Notice: class {},
	TFile: class {
		constructor(public path: string) {}
		get basename() { return this.path.replace(/.*\//, "").replace(/\.md$/, ""); }
	},
	TFolder: class {
		constructor(public path: string) {}
	},
	Plugin: class {
		constructor(public app: App) {}
		loadData = async () => null;
		saveData = host.saveData;
		registerView = host.registerView;
		addCommand = host.addCommand;
		registerEvent() {}
		addRibbonIcon() {}
	},
}));

vi.mock("../src/page-tree-view", () => ({
	VIEW_TYPE_PAGE_TREE: "page-tree-view",
	PageTreeView: class {
		constructor(
			public leaf: WorkspaceLeaf,
			_store: unknown,
			_getLoadInfo: unknown,
			public actions: PageTreeViewActions,
		) {}
		refresh = vi.fn();
	},
}));

beforeEach(() => { vi.clearAllMocks(); });
afterAll(() => { vi.unstubAllGlobals(); });

async function createHost() {
	const { TFile, TFolder } = await import("obsidian");
	const page = Object.assign(new TFile(), { path: "Project.md" });
	const folder = Object.assign(new TFolder(), { path: "Project" });
	const child = Object.assign(new TFile(), { path: "Project/Child.md" });
	const entries = new Map([page, folder, child].map((entry) => [entry.path, entry]));
	const contents = new Map<string, string>();
	const localStorage = new Map<string, unknown>();
	const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	const emit = (name: string, ...args: unknown[]) => {
		for (const listener of listeners.get(name) ?? []) listener(...args);
	};
	const originalLeaf = { location: "right", view: {} };
	const leaves = [originalLeaf];
	const trashFile = vi.fn(async (entry: { path: string }) => {
		entries.delete(entry.path);
		if (entry instanceof TFolder) {
			for (const path of entries.keys()) {
				if (path.startsWith(`${entry.path}/`)) entries.delete(path);
			}
		}
	});
	const app = {
		loadLocalStorage: vi.fn((key: string) => localStorage.get(key) ?? null),
		saveLocalStorage: vi.fn((key: string, value: unknown) => { localStorage.set(key, structuredClone(value)); }),
		vault: {
			configDir: ".obsidian",
			adapter: { exists: async () => false },
			on: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
				listeners.set(name, [...(listeners.get(name) ?? []), listener]);
			}),
			getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
			getMarkdownFiles: () => [...entries.values()].filter((entry) => entry instanceof TFile && entry.path.endsWith(".md")),
			getAllLoadedFiles: () => [...entries.values()],
			create: vi.fn(async (path: string, content: string) => {
				if (entries.has(path)) throw new Error("File already exists");
				const file = Object.assign(new TFile(), { path });
				entries.set(path, file);
				contents.set(path, content);
				emit("create", file);
				return file;
			}),
			read: vi.fn(async (file: { path: string }) => contents.get(file.path) ?? "\n"),
			createFolder: vi.fn(async (path: string) => {
				if (entries.has(path)) throw new Error("Folder already exists");
				const created = Object.assign(new TFolder(), { path });
				entries.set(path, created);
				emit("create", created);
				return created;
			}),
			trash: vi.fn(async () => { throw new Error("Bypassed the user's deletion setting"); }),
		},
		fileManager: {
			trashFile,
			renameFile: vi.fn(async (entry: { path: string }, path: string) => {
				if (entries.has(path)) throw new Error("Destination exists");
				const old = entry.path;
				entries.delete(old);
				entry.path = path;
				entries.set(path, entry as typeof page);
				if (entry instanceof TFolder) {
					for (const [childPath, childEntry] of [...entries]) {
						if (!childPath.startsWith(`${old}/`)) continue;
						entries.delete(childPath);
						childEntry.path = path + childPath.slice(old.length);
						entries.set(childEntry.path, childEntry);
					}
				}
				emit("rename", entry, old);
			}),
		},
		workspace: {
			onLayoutReady: (callback: () => void) => callback(),
			getLeavesOfType: () => leaves,
			detachLeavesOfType: () => leaves.splice(0),
			revealLeaf: vi.fn(async () => {}),
			getLeftLeaf: vi.fn(() => null),
		},
	};
	const plugin = new PageTreePlugin(app as unknown as App, {} as PluginManifest);
	await plugin.onload();
	const factory = host.registerView.mock.calls.at(-1)![1] as (leaf: unknown) => { actions: PageTreeViewActions };
	const view = factory(originalLeaf);
	originalLeaf.view = view;
	return { app, plugin, actions: view.actions, leaves, originalLeaf, entries, page, folder, contents, localStorage, emit };
}

describe("Obsidian host integration", () => {
	it("reuses the existing pane after reload and discards queued actions from the old instance", async () => {
		const { app, plugin, actions, leaves, originalLeaf, entries } = await createHost();
		actions.deletePage("Project.md");
		plugin.onunload();
		await actions.checkPageTree();
		expect([...entries.keys()]).toEqual(["Project.md", "Project", "Project/Child.md"]);
		expect(host.saveData).not.toHaveBeenCalled();

		const reloaded = new PageTreePlugin(app as unknown as App, {} as PluginManifest);
		await reloaded.onload();
		const open = host.addCommand.mock.calls.map(([command]) => command).find((command) => command.id === "open");
		open.callback();
		expect(leaves).toEqual([originalLeaf]);
		expect(app.workspace.revealLeaf).toHaveBeenCalledWith(originalLeaf);
		expect(app.workspace.getLeftLeaf).not.toHaveBeenCalled();
		reloaded.onunload();
	});

	it("delegates deletion of a page and its paired folder to the user-configured file manager", async () => {
		const { app, plugin, actions, entries, page, folder } = await createHost();
		actions.deletePage("Project.md");
		await actions.checkPageTree();
		expect(app.fileManager.trashFile.mock.calls).toEqual([[page], [folder]]);
		expect(app.vault.trash).not.toHaveBeenCalled();
		expect(entries.size).toBe(0);
		plugin.onunload();
	});
});

async function createMissingParentHost() {
	const fixture = await createHost();
	const { TFile, TFolder } = await import("obsidian");
	fixture.entries.delete("Project.md");
	for (const name of ["Second", "Unapproved"]) {
		fixture.entries.set(name, Object.assign(new TFolder(), { path: name }));
		const path = `${name}/Child.md`;
		fixture.entries.set(path, Object.assign(new TFile(), { path }));
	}
	return fixture;
}

describe("parent-page creation progress", () => {
	it("counts only approved pages and advances after both file creation and order persistence", async () => {
		const { app, plugin, actions, entries } = await createMissingParentHost();
		let finishSave!: () => void;
		const saving = new Promise<void>((resolve) => { finishSave = resolve; });
		host.saveData.mockImplementationOnce(() => saving);
		const reports: ParentPageCreationProgress[] = [];
		const creation = actions.createMissingParentPages(["Project.md", "Second.md"], (progress) => reports.push(progress));
		try {
			await vi.waitFor(() => expect(host.saveData).toHaveBeenCalledOnce());
			expect(app.vault.create).toHaveBeenCalledOnce();
			expect(reports.at(-1)).toEqual({ completed: 0, total: 2, currentPath: "Project.md" });
			finishSave();
			expect(await creation).toBe(true);
			expect(reports).toEqual([
				{ completed: 0, total: 2, currentPath: null },
				{ completed: 0, total: 2, currentPath: "Project.md" },
				{ completed: 1, total: 2, currentPath: "Project.md" },
				{ completed: 1, total: 2, currentPath: "Second.md" },
				{ completed: 2, total: 2, currentPath: "Second.md" },
			]);
			expect(app.vault.create.mock.calls).toEqual([["Project.md", "\n"], ["Second.md", "\n"]]);
			expect(entries.has("Unapproved.md")).toBe(false);
		} finally {
			finishSave();
			await creation;
			plugin.onunload();
		}
	});

	it("keeps partial progress on failure and retries only remaining missing pages", async () => {
		const { app, plugin, actions } = await createMissingParentHost();
		const create = app.vault.create.getMockImplementation()!;
		app.vault.create.mockImplementationOnce(create).mockRejectedValueOnce(new Error("Disk full"));
		const reports: ParentPageCreationProgress[] = [];
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(await actions.createMissingParentPages(["Project.md", "Second.md"], (progress) => reports.push(progress))).toBe(false);
			expect(reports.at(-1)).toEqual({ completed: 1, total: 2, currentPath: "Second.md" });
			expect(reports.some(({ completed, total }) => completed === total)).toBe(false);
			reports.length = 0;
			expect(await actions.createMissingParentPages(["Project.md", "Second.md"], (progress) => reports.push(progress))).toBe(true);
			expect(reports.at(-1)).toEqual({ completed: 1, total: 1, currentPath: "Second.md" });
			expect(app.vault.create.mock.calls.filter(([path]) => path === "Project.md")).toHaveLength(1);
		} finally {
			errorLog.mockRestore();
			plugin.onunload();
		}
	});

	it("counts concurrently created paths as handled without overwriting them", async () => {
		const { app, plugin, actions, entries } = await createMissingParentHost();
		const { TFile } = await import("obsidian");
		const reports: ParentPageCreationProgress[] = [];
		try {
			expect(await actions.createMissingParentPages(["Project.md", "Second.md"], (progress) => {
				reports.push(progress);
				if (progress.currentPath === "Second.md" && progress.completed === 1) {
					entries.set("Second.md", Object.assign(new TFile(), { path: "Second.md" }));
				}
			})).toBe(true);
			expect(app.vault.create.mock.calls).toEqual([["Project.md", "\n"]]);
			expect(reports.at(-1)).toEqual({ completed: 2, total: 2, currentPath: "Second.md" });
		} finally {
			plugin.onunload();
		}
	});

	it("reports an empty task without creating or persisting anything", async () => {
		const { app, plugin, actions } = await createHost();
		const progress = vi.fn();
		try {
			expect(await actions.createMissingParentPages(["Project.md"], progress)).toBe(true);
			expect(progress).toHaveBeenCalledExactlyOnceWith({ completed: 0, total: 0, currentPath: null });
			expect(app.vault.create).not.toHaveBeenCalled();
			expect(host.saveData).not.toHaveBeenCalled();
		} finally {
			plugin.onunload();
		}
	});
});

type HostFixture = Awaited<ReturnType<typeof createHost>>;
const visibleGroups = (fixture: HostFixture) => captureOrderGroups(
	(fixture.plugin as unknown as { treeStore: TreeStore }).treeStore.getState(),
	fixture.app.vault.getMarkdownFiles().map((file) => file.path),
);
async function transferOrder(from: HostFixture, to: HostFixture) {
	if (!to.entries.has(SHARED_ORDER_FOLDER)) await to.app.vault.createFolder(SHARED_ORDER_FOLDER);
	for (const [path, contents] of from.contents) {
		if (isSharedOrderPath(path) && !to.entries.has(path)) await to.app.vault.create(path, contents);
	}
	await to.actions.checkPageTree();
}

describe("cross-device order integration", () => {
	it("shares a desktop drag with another device automatically while keeping folds local", async () => {
		const computer = await createHost();
		const phone = await createHost();
		try {
			await computer.app.vault.create("B.md", "computer note");
			await phone.app.vault.create("B.md", "phone note");
			await computer.actions.checkPageTree();
			await phone.actions.checkPageTree();
			expect(computer.entries.has(SHARED_ORDER_FOLDER)).toBe(false);
			computer.actions.setCollapsed("Project.md", true);
			phone.actions.setCollapsed("Project.md", false);
			computer.actions.movePage("B.md", { type: "before", targetPath: "Project.md", targetParentPath: null });
			await computer.actions.checkPageTree();
			expect([...computer.contents.keys()].filter(isSharedOrderPath)).toHaveLength(1);
			const savesBeforeReceive = host.saveData.mock.calls.length;
			await transferOrder(computer, phone);
			expect(visibleGroups(phone)).toEqual(visibleGroups(computer));
			expect(visibleGroups(phone)[0]!.paths).toEqual(["B.md", "Project.md"]);
			expect(host.saveData.mock.calls.length).toBe(savesBeforeReceive);
			expect(phone.actions.isCollapsed("Project.md")).toBe(false);
			expect(computer.actions.isCollapsed("Project.md")).toBe(true);
			expect(phone.contents.get("B.md")).toBe("phone note");
			expect([...phone.contents.keys()].filter(isSharedOrderPath)).toHaveLength(1);
			const shared = [...computer.contents.entries()].find(([path]) => isSharedOrderPath(path))![1];
			expect(shared).not.toMatch(/collapsed|settings|orderHistory/);
		} finally { computer.plugin.onunload(); phone.plugin.onunload(); }
	});

	it("does not bootstrap on opening and does not replace existing shared order with a new device's old order", async () => {
		const computer = await createHost();
		try {
			await computer.actions.checkPageTree();
			expect(computer.entries.has(SHARED_ORDER_FOLDER)).toBe(false);
			const share = host.addCommand.mock.calls.map(([command]) => command).find((command) => command.id === "share-order");
			share.callback();
			await computer.actions.checkPageTree();
			expect([...computer.contents.keys()].filter(isSharedOrderPath)).toHaveLength(1);
			share.callback();
			await computer.actions.checkPageTree();
			expect([...computer.contents.keys()].filter(isSharedOrderPath)).toHaveLength(1);
		} finally { computer.plugin.onunload(); }
	});

	it("refreshes already open views when shared metadata arrives before the note files", async () => {
		const computer = await createHost();
		const phone = await createHost();
		try {
			await computer.app.vault.create("B.md", "\n");
			await computer.actions.checkPageTree();
			computer.actions.movePage("B.md", { type: "before", targetPath: "Project.md", targetParentPath: null });
			await computer.actions.checkPageTree();
			await transferOrder(computer, phone);
			expect(phone.entries.has("B.md")).toBe(false);
			await phone.app.vault.create("B.md", "arrived later");
			await phone.actions.checkPageTree();
			expect(visibleGroups(phone)).toEqual(visibleGroups(computer));
			expect((phone.originalLeaf.view as { refresh: ReturnType<typeof vi.fn> }).refresh).toHaveBeenCalled();
			expect([...phone.contents.keys()].filter(isSharedOrderPath)).toHaveLength(1);
		} finally { computer.plugin.onunload(); phone.plugin.onunload(); }
	});

	it("preserves shared sibling order through a native parent title and paired folder rename", async () => {
		const computer = await createHost();
		try {
			await computer.app.vault.create("B.md", "\n");
			await computer.app.vault.create("Project/Z.md", "\n");
			await computer.actions.checkPageTree();
			computer.actions.movePage("Project/Z.md", { type: "before", targetPath: "Project/Child.md", targetParentPath: "Project.md" });
			await computer.actions.checkPageTree();
			await computer.app.fileManager.renameFile(computer.page, "Renamed.md");
			await computer.actions.checkPageTree();
			expect(visibleGroups(computer).find((group) => group.parent === "Renamed.md")?.paths)
				.toEqual(["Renamed/Z.md", "Renamed/Child.md"]);
		} finally { computer.plugin.onunload(); }
	});

	it("does not publish an order change when the local metadata save fails", async () => {
		const computer = await createHost();
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await computer.app.vault.create("B.md", "\n");
			await computer.actions.checkPageTree();
			host.saveData.mockRejectedValueOnce(new Error("Disk full"));
			computer.actions.movePage("B.md", { type: "before", targetPath: "Project.md", targetParentPath: null });
			await computer.actions.checkPageTree();
			expect([...computer.contents.keys()].filter(isSharedOrderPath)).toHaveLength(0);
		} finally { computer.plugin.onunload(); errorLog.mockRestore(); }
	});

	it("keeps the current order unchanged while incoming metadata is incomplete", async () => {
		const computer = await createHost();
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await computer.app.vault.create("B.md", "\n");
			await computer.actions.checkPageTree();
			const before = visibleGroups(computer);
			await computer.app.vault.createFolder(SHARED_ORDER_FOLDER);
			await computer.app.vault.create(`${SHARED_ORDER_FOLDER}/order-00000000-0000-4000-8000-000000000001.json`, "{");
			await computer.actions.checkPageTree();
			const savesBefore = host.saveData.mock.calls.length;
			computer.actions.movePage("B.md", { type: "before", targetPath: "Project.md", targetParentPath: null });
			await computer.actions.checkPageTree();
			expect(visibleGroups(computer)).toEqual(before);
			expect(host.saveData.mock.calls.length).toBe(savesBefore);
			expect([...computer.contents.keys()].filter(isSharedOrderPath)).toHaveLength(1);
		} finally { computer.plugin.onunload(); errorLog.mockRestore(); }
	});
});
