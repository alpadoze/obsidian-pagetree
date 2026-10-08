import { describe, expect, it } from "vitest";
import { cloneTreeState, createEmptyTreeState, type TreeState } from "../src/core/tree-state";
import { TreeStore } from "../src/core/tree-store";
import {
	PAGE_TREE_DATA_FORMAT,
	LEGACY_TREE_DATA_FORMATS,
	TreeRepository,
	type PluginDataStorage,
} from "../src/persistence/tree-repository";

class MemoryStorage implements PluginDataStorage {
	data: unknown = null;
	writes = 0;

	async loadData(): Promise<unknown> {
		return cloneJson(this.data);
	}

	async saveData(data: unknown): Promise<void> {
		this.writes += 1;
		this.data = cloneJson(data);
	}
}

describe("TreeRepository", () => {
	it.each(LEGACY_TREE_DATA_FORMATS)("reads pre-rename %s data without writing, then saves only the new format", async (format) => {
		const storage = new MemoryStorage();
		const current = historyState();
		const backup = { ...historyState(), revision: 0 };
		storage.data = { format, state: current, lastValidState: backup };
		const before = cloneJson(storage.data);
		const repository = new TreeRepository(storage);

		const loaded = await repository.load();
		expect(loaded.source).toBe("current");
		expect(loaded.state).toEqual(current);
		expect(storage.data).toEqual(before);
		expect(storage.writes).toBe(0);

		const next = { ...cloneTreeState(loaded.state), revision: current.revision + 1 };
		await repository.save(next);
		expect(storage.data).toEqual({ format: PAGE_TREE_DATA_FORMAT, state: next, lastValidState: current });
		expect((await repository.load()).state).toEqual(next);
	});

	it.each(["page-arbor-tree-v4", "page-tree-v4"])("does not accept unknown format %s even with a valid current schema", async (format) => {
		const storage = new MemoryStorage();
		storage.data = { format, state: historyState(), lastValidState: historyState() };
		const before = cloneJson(storage.data);
		const repository = new TreeRepository(storage);
		expect((await repository.load()).source).toBe("degraded");
		await expect(repository.save(historyState())).rejects.toThrow("will not be overwritten");
		expect(storage.data).toEqual(before);
		expect(storage.writes).toBe(0);
	});

	it("starts with a safe empty tree when no data exists", async () => {
		const repository = new TreeRepository(new MemoryStorage());

		const result = await repository.load();

		expect(result.source).toBe("empty");
		expect(result.state).toEqual(createEmptyTreeState());
	});

	it("keeps the previously saved valid state as a backup", async () => {
		const storage = new MemoryStorage();
		const repository = new TreeRepository(storage);
		const store = new TreeStore(createEmptyTreeState());
		store.addNode({ id: "one", path: "One.md" });
		const firstState = store.getState();
		await repository.save(firstState);

		store.addNode({ id: "two", path: "Two.md" });
		await repository.save(store.getState());

		expect(storage.data).toMatchObject({
			format: PAGE_TREE_DATA_FORMAT,
			state: { revision: 2 },
			lastValidState: { revision: 1 },
		});
	});

	it("recovers the backup when current data is invalid", async () => {
		const storage = new MemoryStorage();
		const repository = new TreeRepository(storage);
		const store = new TreeStore(createEmptyTreeState());
		store.addNode({ id: "one", path: "One.md" });
		await repository.save(store.getState());
		store.addNode({ id: "two", path: "Two.md" });
		await repository.save(store.getState());

		const document = storage.data as { state: { revision: unknown } };
		document.state.revision = "corrupted";

		const result = await repository.load();
		expect(result.source).toBe("backup");
		expect(result.state.revision).toBe(1);
		expect(Object.keys(result.state.nodes)).toEqual(["one"]);
		expect(result.issues.length).toBeGreaterThan(0);
	});

	it("loads the original direct-state format as legacy data", async () => {
		const storage = new MemoryStorage();
		const store = new TreeStore(createEmptyTreeState());
		store.addNode({ id: "one", path: "One.md" });
		storage.data = store.getState();

		const result = await new TreeRepository(storage).load();

		expect(result.source).toBe("legacy");
		expect(result.state.nodes.one?.path).toBe("One.md");
	});

	it("degrades to all-roots-ready empty state when no valid copy remains", async () => {
		const storage = new MemoryStorage();
		storage.data = { unexpected: true };

		const result = await new TreeRepository(storage).load();

		expect(result.source).toBe("degraded");
		expect(result.state).toEqual(createEmptyTreeState());
		expect(result.issues.length).toBeGreaterThan(0);
	});

	it.each(["direct", "wrapped"])("loads and migrates %s schema v2 data without writing or changing source values", async (shape) => {
		const storage = new MemoryStorage();
		const legacy = legacyState();
		storage.data = shape === "direct" ? legacy : {
			format: LEGACY_TREE_DATA_FORMATS[0], state: legacy, lastValidState: null,
		};
		const before = cloneJson(storage.data);
		const result = await new TreeRepository(storage).load();
		expect(result.source).toBe(shape === "direct" ? "legacy" : "current");
		expect(result.state).toEqual({ ...legacy, schemaVersion: 3, orderHistory: {} });
		expect(result.issues).toEqual([]);
		expect(storage.data).toEqual(before);
		expect(storage.writes).toBe(0);
	});

	it.each([...LEGACY_TREE_DATA_FORMATS, PAGE_TREE_DATA_FORMAT])(
		"recovers and migrates a v2 backup from %s when the current state is invalid",
		async (format) => {
			const storage = new MemoryStorage();
			const legacy = legacyState();
			storage.data = { format, state: { ...historyState(), orderHistory: { corrupted: null } }, lastValidState: legacy };
			const before = cloneJson(storage.data);
			const result = await new TreeRepository(storage).load();
			expect(result.source).toBe("backup");
			expect(result.state).toEqual({ ...legacy, schemaVersion: 3, orderHistory: {} });
			expect(result.issues.length).toBeGreaterThan(0);
			expect(storage.data).toEqual(before);
			expect(storage.writes).toBe(0);
		},
	);

	it("writes the new format only on explicit save, keeping migrated old data as the backup", async () => {
		const storage = new MemoryStorage();
		const legacy = legacyState();
		storage.data = { format: LEGACY_TREE_DATA_FORMATS[0], state: legacy, lastValidState: null };
		const repository = new TreeRepository(storage);
		const result = await repository.load();
		const next = cloneTreeState(result.state);
		next.revision += 1;
		next.orderHistory.old = { node: { id: "old", path: "Old.md", order: 42 }, reason: "missing", archivedAt: 100 };
		await repository.save(next);
		expect(storage.writes).toBe(1);
		expect(storage.data).toEqual({
			format: "page-tree-v3",
			state: next,
			lastValidState: { ...legacy, schemaVersion: 3, orderHistory: {} },
		});
	});

	it("round-trips historical records and keeps the previous history in the backup", async () => {
		const storage = new MemoryStorage();
		const repository = new TreeRepository(storage);
		const first = historyState();
		await repository.save(first);
		expect((await repository.load()).state).toEqual(first);
		const second = cloneTreeState(first);
		second.revision += 1;
		second.orderHistory.older = {
			node: { id: "older", path: "ONE.md", order: 9 }, reason: "missing", archivedAt: 1,
		};
		await repository.save(second);
		expect(storage.data).toEqual({ format: PAGE_TREE_DATA_FORMAT, state: second, lastValidState: first });
		const loaded = await repository.load();
		expect(loaded.state).toEqual(second);
		loaded.state.orderHistory.old!.node.path = "Mutated.md";
		expect((await repository.load()).state.orderHistory.old!.node.path).toBe("One.md");
	});

	it("recovers complete historical records rather than partially accepting corrupt history", async () => {
		const storage = new MemoryStorage();
		const backup = historyState();
		storage.data = {
			format: PAGE_TREE_DATA_FORMAT,
			state: { ...backup, revision: 2, orderHistory: { ...backup.orderHistory, broken: {} } },
			lastValidState: backup,
		};
		const result = await new TreeRepository(storage).load();
		expect(result.source).toBe("backup");
		expect(result.state).toEqual(backup);
		expect(storage.writes).toBe(0);
	});

	it("refuses to save malformed historical records", async () => {
		const storage = new MemoryStorage();
		const state = historyState();
		state.orderHistory.old!.archivedAt = -1;
		await expect(new TreeRepository(storage).save(state)).rejects.toThrow("Archive timestamp");
		expect(storage.data).toBeNull();
		expect(storage.writes).toBe(0);
	});

	it.each(["direct", "schema", "format"])("preserves unknown future %s data on load and rejects overwriting it", async (shape) => {
		const storage = new MemoryStorage();
		const future = { ...historyState(), schemaVersion: 4, futureField: "preserve" };
		storage.data = shape === "direct" ? future : {
			format: shape === "format" ? "page-tree-v4" : PAGE_TREE_DATA_FORMAT,
			state: future,
			lastValidState: null,
		};
		const before = cloneJson(storage.data);
		const repository = new TreeRepository(storage);
		const result = await repository.load();
		expect(result.source).toBe("degraded");
		expect(result.state).toEqual(createEmptyTreeState());
		expect(storage.data).toEqual(before);
		await expect(repository.save(createEmptyTreeState())).rejects.toThrow("will not be overwritten");
		expect(storage.data).toEqual(before);
		expect(storage.writes).toBe(0);
	});

	it("can display an older backup but still refuses to overwrite a future current state", async () => {
		const storage = new MemoryStorage();
		storage.data = {
			format: PAGE_TREE_DATA_FORMAT,
			state: { ...historyState(), schemaVersion: 4 },
			lastValidState: legacyState(),
		};
		const before = cloneJson(storage.data);
		const repository = new TreeRepository(storage);
		const result = await repository.load();
		expect(result.source).toBe("backup");
		expect(result.state.schemaVersion).toBe(3);
		await expect(repository.save(result.state)).rejects.toThrow("will not be overwritten");
		expect(storage.data).toEqual(before);
		expect(storage.writes).toBe(0);
	});
});

function legacyState() {
	return {
		schemaVersion: 2,
		revision: 27,
		nodes: {
			one: { id: "one", path: "One.md", order: 4 },
			two: { id: "two", path: "Two.md", order: 7 },
		},
		collapsedNodeIds: ["two"],
		settings: { showFilePath: true },
	};
}

function historyState(): TreeState {
	return {
		...createEmptyTreeState(),
		revision: 1,
		nodes: { current: { id: "current", path: "One.md", order: 7 } },
		orderHistory: {
			old: { node: { id: "old", path: "One.md", order: 2 }, reason: "deleted", archivedAt: 100 },
		},
	};
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
