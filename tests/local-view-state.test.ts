import { describe, expect, it } from "vitest";
import { projectTree } from "../src/core/tree-projection";
import { canonicalVaultPath, createEmptyTreeState, type TreeState } from "../src/core/tree-state";
import { TreeStore } from "../src/core/tree-store";
import { LocalViewState } from "../src/persistence/local-view-state";

class MemoryStorage {
	data: unknown;
	saved: unknown[] = [];
	failSave = false;

	constructor(data: unknown = null) {
		this.data = data;
	}

	load(): unknown {
		return this.data;
	}

	save(value: unknown): void {
		if (this.failSave) throw new Error("Local storage is unavailable.");
		this.data = structuredClone(value);
		this.saved.push(structuredClone(value));
	}
}

function legacyState(): TreeState {
	const state = createEmptyTreeState();
	state.revision = 7;
	state.nodes = {
		one: { id: "one", path: "One.md", order: 0 },
		two: { id: "two", path: "Two.md", order: 1 },
	};
	state.collapsedNodeIds = ["two", "missing"];
	return state;
}

function persisted(paths: string[]): { version: 1; collapsedPaths: string[] } {
	return { version: 1, collapsedPaths: paths };
}

function savedPaths(storage: MemoryStorage): string[] {
	const data = storage.data as { version: number; collapsedPaths: string[] };
	expect(data.version).toBe(1);
	return data.collapsedPaths.map(canonicalVaultPath).sort();
}

describe("LocalViewState", () => {
	it.each([[], ["One.md", "ONE.md"]].map((paths) => [paths]))("imports the pre-rename local key once, preserving the old record: %j", (paths) => {
		const storage = new MemoryStorage();
		const old = persisted(paths);
		const before = structuredClone(old);
		let legacyReads = 0;
		const migrationStorage = {
			load: () => storage.load(),
			save: (value: unknown) => storage.save(value),
			loadLegacy: () => { legacyReads += 1; return old; },
		};
		const view = new LocalViewState(migrationStorage, legacyState());
		expect(view.isCollapsed("One.md")).toBe(paths.length > 0);
		expect(view.isCollapsed("Two.md")).toBe(false);
		expect(savedPaths(storage)).toEqual(paths.length > 0 ? ["one.md"] : []);
		expect(storage.saved).toHaveLength(1);
		expect(old).toEqual(before);
		new LocalViewState(migrationStorage, legacyState());
		expect(legacyReads).toBe(1);
		expect(storage.saved).toHaveLength(1);
	});

	it.each([persisted([]), persisted(["Two.md"]), { version: 99 }])("never replaces existing PageTree local data with the old key: %j", (current) => {
		const storage = new MemoryStorage(current);
		const view = new LocalViewState({
			load: () => storage.load(),
			save: (value) => storage.save(value),
			loadLegacy: () => { throw new Error("Existing data must take precedence."); },
		}, legacyState());
		expect(view.loadError).toBeUndefined();
		expect(storage.data).toEqual(current);
		expect(storage.saved).toEqual([]);
	});

	it("leaves invalid pre-rename local data untouched instead of replacing it with shared defaults", () => {
		const storage = new MemoryStorage();
		const old = { version: 2, collapsedPaths: ["One.md"] };
		const view = new LocalViewState({
			load: () => storage.load(),
			save: (value) => storage.save(value),
			loadLegacy: () => old,
		}, legacyState());
		expect(view.isCollapsed("One.md")).toBe(false);
		expect(view.isCollapsed("Two.md")).toBe(false);
		expect(storage.data).toBeNull();
		expect(storage.saved).toEqual([]);
		expect(old).toEqual({ version: 2, collapsedPaths: ["One.md"] });
	});

	it("keeps migrated local state in memory if saving to the new key fails", () => {
		const storage = new MemoryStorage();
		storage.failSave = true;
		const old = persisted(["One.md"]);
		const view = new LocalViewState({
			load: () => storage.load(),
			save: (value) => storage.save(value),
			loadLegacy: () => old,
		}, legacyState());
		expect(view.loadError).toBeInstanceOf(Error);
		expect(view.isCollapsed("One.md")).toBe(true);
		expect(storage.data).toBeNull();
		storage.failSave = false;
		view.setCollapsed("Three.md", true);
		expect(savedPaths(storage)).toEqual(["one.md", "three.md"]);
		expect(old).toEqual(persisted(["One.md"]));
	});

	it("does not write defaults when reading the pre-rename key fails", () => {
		const storage = new MemoryStorage();
		const view = new LocalViewState({
			load: () => storage.load(),
			save: (value) => storage.save(value),
			loadLegacy: () => { throw new Error("Legacy key cannot be read."); },
		}, legacyState());
		expect(view.loadError).toBeInstanceOf(Error);
		expect(storage.data).toBeNull();
		expect(storage.saved).toEqual([]);
	});

	it.each([null, undefined])("migrates legacy collapsed IDs once when local data is %s", (missing) => {
		const storage = new MemoryStorage();
		storage.data = missing;
		const state = legacyState();
		const before = structuredClone(state);

		const view = new LocalViewState(storage, state);

		expect(view.isCollapsed("Two.md")).toBe(true);
		expect(view.isCollapsed("One.md")).toBe(false);
		expect(savedPaths(storage)).toEqual(["two.md"]);
		expect(storage.saved).toHaveLength(1);
		expect(state).toEqual(before);

		state.collapsedNodeIds = ["one"];
		const reopened = new LocalViewState(storage, state);
		expect(reopened.isCollapsed("Two.md")).toBe(true);
		expect(reopened.isCollapsed("One.md")).toBe(false);
		expect(storage.saved).toHaveLength(1);
	});

	it("treats an existing empty local record as authoritative over legacy data", () => {
		const storage = new MemoryStorage(persisted([]));
		const view = new LocalViewState(storage, legacyState());

		expect(view.isCollapsed("Two.md")).toBe(false);
		expect(storage.saved).toEqual([]);
	});

	it("retains legacy collapse memory after a migration save failure and can persist it later", () => {
		const storage = new MemoryStorage();
		storage.failSave = true;
		const state = legacyState();
		const before = structuredClone(state);
		const view = new LocalViewState(storage, state);

		expect(view.loadError).toBeInstanceOf(Error);
		expect((view.loadError as Error).message).toBe("Local storage is unavailable.");
		expect(view.isCollapsed("Two.md")).toBe(true);
		expect(view.isCollapsed("One.md")).toBe(false);
		expect(storage.data).toBeNull();
		expect(storage.saved).toEqual([]);
		expect(state).toEqual(before);

		storage.failSave = false;
		view.setCollapsed("One.md", true);
		expect(savedPaths(storage)).toEqual(["one.md", "two.md"]);
		expect(state).toEqual(before);
		const reopened = new LocalViewState(storage, createEmptyTreeState());
		expect(reopened.loadError).toBeUndefined();
		expect(reopened.isCollapsed("One.md")).toBe(true);
		expect(reopened.isCollapsed("Two.md")).toBe(true);
		expect(storage.saved).toHaveLength(1);
	});

	it("remembers explicit collapse and expansion after reopening", () => {
		const storage = new MemoryStorage(persisted([]));
		const view = new LocalViewState(storage, createEmptyTreeState());
		view.setCollapsed("Project.md", true);
		view.setCollapsed("Other.md", true);
		view.setCollapsed("Other.md", false);

		const reopened = new LocalViewState(storage, createEmptyTreeState());
		expect(reopened.isCollapsed("Project.md")).toBe(true);
		expect(reopened.isCollapsed("Other.md")).toBe(false);
		expect(savedPaths(storage)).toEqual(["project.md"]);
	});

	it("keeps two devices independent even when their legacy tree data is shared", () => {
		const state = legacyState();
		const desktopStorage = new MemoryStorage();
		const phoneStorage = new MemoryStorage();
		const desktop = new LocalViewState(desktopStorage, state);
		const phone = new LocalViewState(phoneStorage, state);

		desktop.setCollapsed("Two.md", false);
		desktop.setCollapsed("One.md", true);
		phone.setCollapsed("Phone only.md", true);

		expect(phone.isCollapsed("Two.md")).toBe(true);
		expect(phone.isCollapsed("One.md")).toBe(false);
		expect(desktop.isCollapsed("Phone only.md")).toBe(false);
		expect(new LocalViewState(desktopStorage, state).isCollapsed("Two.md")).toBe(false);
		expect(new LocalViewState(phoneStorage, state).isCollapsed("Two.md")).toBe(true);
		expect(state).toEqual(legacyState());
	});

	it.each(["untracked", "tracked", "mixed"] as const)(
		"does not change %s page order, tree nodes, or revision when toggling collapse",
		(metadata) => {
			const store = new TreeStore(createEmptyTreeState());
			if (metadata !== "untracked") store.addNode({ id: "c", path: "C.md" });
			if (metadata === "tracked") {
				store.addNode({ id: "b", path: "B.md" });
				store.addNode({ id: "a", path: "A.md" });
			}
			const paths = ["A.md", "B.md", "B/Child.md", "C.md"];
			const state = store.getState();
			const before = structuredClone(state);
			const projection = projectTree(state, paths);
			const view = new LocalViewState(new MemoryStorage(persisted([])), state);

			for (const collapsed of [true, false, true]) {
				view.setCollapsed("B.md", collapsed);
				expect(view.isCollapsed("B.md")).toBe(collapsed);
				expect(projectTree(state, paths)).toEqual(projection);
				expect(state).toEqual(before);
				expect(store.getState()).toEqual(before);
			}
		},
	);

	it("matches case-insensitively, normalizes Unicode, and deduplicates stored paths", () => {
		const storage = new MemoryStorage(persisted(["CAFÉ.md", "Cafe\u0301.md"]));
		const view = new LocalViewState(storage, createEmptyTreeState());
		expect(view.isCollapsed("cafe\u0301.MD")).toBe(true);
		view.setCollapsed("Other.md", true);
		expect(savedPaths(storage)).toEqual(["café.md", "other.md"]);
		view.setCollapsed("Cafe\u0301.MD", false);
		expect(view.isCollapsed("CAFÉ.md")).toBe(false);
		expect(savedPaths(storage)).toEqual(["other.md"]);
	});

	it.each([
		42,
		false,
		"invalid",
		{},
		{ version: 2, collapsedPaths: ["One.md"] },
		{ version: 1, collapsedPaths: "One.md" },
		{ version: 1, collapsedPaths: null },
		{ version: 1, collapsedPaths: ["One.md", 42] },
		{ version: 1, collapsedPaths: [""] },
	].map((value) => [value]))("safely ignores invalid existing local data: %j", (invalid) => {
		const storage = new MemoryStorage(invalid);
		const view = new LocalViewState(storage, legacyState());

		expect(view.isCollapsed("One.md")).toBe(false);
		expect(view.isCollapsed("Two.md")).toBe(false);
		expect(storage.data).toEqual(invalid);
		expect(storage.saved).toEqual([]);

		view.setCollapsed("New.md", true);
		expect(savedPaths(storage)).toEqual(["new.md"]);
	});

	it("keeps the tree usable after a load failure and permits a later explicit save", () => {
		const storage = new MemoryStorage();
		const error = new Error("Local storage cannot be read.");
		storage.load = () => { throw error; };
		const state = legacyState();
		const view = new LocalViewState(storage, state);

		expect(view.loadError).toBe(error);
		expect(view.isCollapsed("Two.md")).toBe(false);
		expect(storage.saved).toEqual([]);
		expect(state).toEqual(legacyState());
		view.setCollapsed("One.md", true);
		expect(view.isCollapsed("One.md")).toBe(true);
		expect(savedPaths(storage)).toEqual(["one.md"]);
	});

	it("does not retain mutable references to loaded arrays", () => {
		const record = persisted(["One.md"]);
		const view = new LocalViewState(new MemoryStorage(record), createEmptyTreeState());
		record.collapsedPaths.push("Two.md");
		record.collapsedPaths[0] = "Changed.md";
		expect(view.isCollapsed("One.md")).toBe(true);
		expect(view.isCollapsed("Two.md")).toBe(false);
		expect(view.isCollapsed("Changed.md")).toBe(false);
	});

	it.each([true, false])("preserves in-memory collapse state if saving %s fails, and allows retry", (collapsed) => {
		const storage = new MemoryStorage(persisted(collapsed ? [] : ["One.md"]));
		const view = new LocalViewState(storage, createEmptyTreeState());
		const before = structuredClone(storage.data);
		storage.failSave = true;

		expect(() => view.setCollapsed("One.md", collapsed)).toThrow("Local storage is unavailable.");
		expect(view.isCollapsed("One.md")).toBe(!collapsed);
		expect(storage.data).toEqual(before);

		storage.failSave = false;
		view.setCollapsed("One.md", collapsed);
		expect(view.isCollapsed("One.md")).toBe(collapsed);
		expect(new LocalViewState(storage, createEmptyTreeState()).isCollapsed("One.md")).toBe(collapsed);
	});

	it("renames a file by exact canonical path without changing its paired folder descendants", () => {
		const storage = new MemoryStorage(persisted(["Project.md", "Project/Child.md", "Project.md.backup.md"]));
		const view = new LocalViewState(storage, createEmptyTreeState());
		view.renamePath("PROJECT.MD", "Renamed.md", false);
		expect(savedPaths(storage)).toEqual(["project.md.backup.md", "project/child.md", "renamed.md"]);
		expect(view.isCollapsed("Project.md")).toBe(false);
		expect(view.isCollapsed("Renamed.md")).toBe(true);
	});

	it("renames only folder descendants, preserving similarly prefixed folders and the paired page", () => {
		const storage = new MemoryStorage(persisted([
			"Project.md", "Project/Child.md", "Project/Child/Detail.md", "Projects/Other.md",
		]));
		const view = new LocalViewState(storage, createEmptyTreeState());
		view.renamePath("PROJECT", "Archive", true);
		expect(savedPaths(storage)).toEqual([
			"archive/child.md", "archive/child/detail.md", "project.md", "projects/other.md",
		]);
	});

	it("normalizes renamed folder paths and deduplicates destination entries", () => {
		const storage = new MemoryStorage(persisted(["Café/Child.md", "Résumé/Child.md"]));
		const view = new LocalViewState(storage, createEmptyTreeState());
		view.renamePath("CAFE\u0301", "Re\u0301sume\u0301", true);
		expect(view.isCollapsed("Café/Child.md")).toBe(false);
		expect(view.isCollapsed("RÉSUMÉ/CHILD.md")).toBe(true);
		expect(savedPaths(storage)).toEqual(["résumé/child.md"]);
	});

	it("does not write local storage for unrelated rename and delete events", () => {
		const storage = new MemoryStorage(persisted(["Project/Child.md"]));
		const view = new LocalViewState(storage, createEmptyTreeState());
		view.renamePath("Other.md", "Renamed.md", false);
		view.renamePath("Other", "Renamed", true);
		view.removePath("Other.md", false);
		view.removePath("Other", true);
		expect(storage.saved).toEqual([]);
		expect(view.isCollapsed("Project/Child.md")).toBe(true);
	});

	it("removes only the exact file when a page body is deleted", () => {
		const storage = new MemoryStorage(persisted(["Project.md", "Project/Child.md", "Projects.md"]));
		const view = new LocalViewState(storage, createEmptyTreeState());
		view.removePath("PROJECT.MD", false);
		expect(savedPaths(storage)).toEqual(["project/child.md", "projects.md"]);
	});

	it("removes only folder descendants when a folder is deleted", () => {
		const storage = new MemoryStorage(persisted([
			"Project.md", "Project/Child.md", "Project/Child/Detail.md", "Projects/Other.md",
		]));
		const view = new LocalViewState(storage, createEmptyTreeState());
		view.removePath("PROJECT", true);
		expect(savedPaths(storage)).toEqual(["project.md", "projects/other.md"]);
	});

	it.each(["rename", "remove"] as const)("preserves in-memory paths when saving a %s fails", (operation) => {
		const storage = new MemoryStorage(persisted(["Project/Child.md"]));
		const view = new LocalViewState(storage, createEmptyTreeState());
		const act = () => operation === "rename"
			? view.renamePath("Project", "Renamed", true)
			: view.removePath("Project", true);
		storage.failSave = true;
		expect(act).toThrow("Local storage is unavailable.");
		expect(view.isCollapsed("Project/Child.md")).toBe(true);
		expect(view.isCollapsed("Renamed/Child.md")).toBe(false);
		expect(savedPaths(storage)).toEqual(["project/child.md"]);

		storage.failSave = false;
		act();
		expect(view.isCollapsed("Project/Child.md")).toBe(false);
		expect(view.isCollapsed("Renamed/Child.md")).toBe(operation === "rename");
	});
});
