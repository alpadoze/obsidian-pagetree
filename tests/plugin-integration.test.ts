import type { App, PluginManifest, WorkspaceLeaf } from "obsidian";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import PageTreePlugin from "../src/main";
import type { PageTreeViewActions } from "../src/page-tree-view";
import type { ParentPageCreationProgress } from "../src/core/physical-tree-auditor";

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
		refresh() {}
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
		loadLocalStorage: vi.fn(() => null),
		saveLocalStorage: vi.fn(),
		vault: {
			configDir: ".obsidian",
			adapter: { exists: async () => false },
			on: vi.fn(),
			getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
			getMarkdownFiles: () => [...entries.values()].filter((entry) => entry instanceof TFile),
			getAllLoadedFiles: () => [...entries.values()],
			create: vi.fn(async (path: string, _content: string) => {
				if (entries.has(path)) throw new Error("File already exists");
				const file = Object.assign(new TFile(), { path });
				entries.set(path, file);
				return file;
			}),
			trash: vi.fn(async () => { throw new Error("Bypassed the user's deletion setting"); }),
		},
		fileManager: { trashFile },
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
	const factory = host.registerView.mock.calls[0]![1] as (leaf: unknown) => { actions: PageTreeViewActions };
	const view = factory(originalLeaf);
	originalLeaf.view = view;
	return { app, plugin, actions: view.actions, leaves, originalLeaf, entries, page, folder };
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
