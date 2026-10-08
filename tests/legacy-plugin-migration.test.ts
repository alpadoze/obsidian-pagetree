import { describe, expect, it } from "vitest";
import { createEmptyTreeState } from "../src/core/tree-state";
import { LegacyPluginEnabledError, migrateLegacyPluginData } from "../src/persistence/legacy-plugin-migration";

function fixture(raw: unknown = { format: "page-arbor-tree-v3", state: createEmptyTreeState(), lastValidState: null }, configDir = ".obsidian") {
	const entries = new Map([
		[`${configDir}/community-plugins.json`, JSON.stringify(["page-tree", "obsidian-livesync"])],
		[`${configDir}/plugins/page-arbor/data.json`, JSON.stringify(raw)],
	]);
	const storage = {
		data: null as unknown,
		writes: 0,
		async loadData(): Promise<unknown> { return this.data; },
		async saveData(value: unknown): Promise<void> { this.writes++; this.data = structuredClone(value); },
	};
	const files = {
		async exists(path: string): Promise<boolean> { return entries.has(path); },
		async read(path: string): Promise<string> {
			const value = entries.get(path);
			if (value === undefined) throw new Error("Missing file");
			return value;
		},
	};
	return { entries, storage, files, migrate: () => migrateLegacyPluginData(storage, files, configDir) };
}

describe("legacy plugin identity migration", () => {
	it.each([".obsidian", ".custom-config"])("imports once using %s and leaves the old files unchanged", async (configDir) => {
		const state = createEmptyTreeState();
		state.nodes.one = { id: "one", path: "One.md", order: 7 };
		state.settings.showFilePath = true;
		state.orderHistory.old = { node: { id: "old", path: "Old.md", order: 9 }, reason: "missing", archivedAt: 1 };
		const raw = { format: "page-arbor-tree-v3", state, lastValidState: createEmptyTreeState() };
		const f = fixture(raw, configDir);
		const before = [...f.entries];
		expect(await f.migrate()).toBe("imported");
		expect(f.storage.data).toEqual(raw);
		expect([...f.entries]).toEqual(before);
		expect(await f.migrate()).toBe("existing");
		expect(f.storage.writes).toBe(1);
	});

	it("does not create data for a fresh installation", async () => {
		const f = fixture();
		f.entries.clear();
		expect(await f.migrate()).toBe("absent");
		expect(f.storage.writes).toBe(0);
	});

	it.each([{}, { schemaVersion: 99 }])("does not overwrite any existing new data: %j", async (current) => {
		const f = fixture();
		f.storage.data = current;
		expect(await f.migrate()).toBe("existing");
		expect(f.storage.data).toEqual(current);
		expect(f.storage.writes).toBe(0);
	});

	it("refuses to start when the old plugin is still enabled", async () => {
		const f = fixture();
		f.entries.set(".obsidian/community-plugins.json", JSON.stringify(["page-arbor", "page-tree"]));
		await expect(f.migrate()).rejects.toBeInstanceOf(LegacyPluginEnabledError);
		expect(f.storage.writes).toBe(0);
	});

	it.each([null, {}, { format: "page-arbor-tree-v4", state: createEmptyTreeState(), lastValidState: null }, {
		format: "page-arbor-tree-v3", state: { ...createEmptyTreeState(), schemaVersion: 99 }, lastValidState: createEmptyTreeState(),
	}])("preserves unsupported or invalid old data: %j", async (raw) => {
		const f = fixture(raw);
		const before = [...f.entries];
		await expect(f.migrate()).rejects.toThrow();
		expect(f.storage.writes).toBe(0);
		expect([...f.entries]).toEqual(before);
	});

	it("stops on malformed JSON or an unreadable enablement list", async () => {
		const f = fixture();
		f.entries.set(".obsidian/community-plugins.json", "{}");
		await expect(f.migrate()).rejects.toThrow();
		f.entries.set(".obsidian/community-plugins.json", "[]");
		f.entries.set(".obsidian/plugins/page-arbor/data.json", "{");
		await expect(f.migrate()).rejects.toThrow();
		expect(f.storage.writes).toBe(0);
	});

	it("does not overwrite data received while the old files were being read", async () => {
		const f = fixture();
		let reads = 0;
		f.storage.loadData = async () => ++reads === 1 ? null : { received: true };
		expect(await f.migrate()).toBe("existing");
		expect(f.storage.writes).toBe(0);
	});

	it("reports save failure without changing the old copy", async () => {
		const f = fixture();
		const before = [...f.entries];
		f.storage.saveData = async () => { throw new Error("Save failed"); };
		await expect(f.migrate()).rejects.toThrow("Save failed");
		expect([...f.entries]).toEqual(before);
		expect(f.storage.data).toBeNull();
	});
});
