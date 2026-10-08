import type { App, PluginManifest, WorkspaceLeaf } from "obsidian";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import PageTreePlugin from "../src/main";
import type { PageTreeViewActions } from "../src/page-tree-view";

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
