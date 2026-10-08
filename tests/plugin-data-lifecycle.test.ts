import { afterAll, describe, expect, it, vi } from "vitest";
import { guardPluginDataStorage } from "../src/persistence/plugin-data-lifecycle";

vi.hoisted(() => { vi.stubGlobal("window", {}); });
afterAll(() => { vi.unstubAllGlobals(); });

describe("plugin data lifecycle", () => {
	it("rejects writes and loads after unload", async () => {
		let active = true;
		let saves = 0;
		const guarded = guardPluginDataStorage({}, {
			async loadData() { return {}; }, async saveData() { saves += 1; },
		}, () => active);
		active = false;
		await expect(guarded.loadData()).rejects.toThrow("no longer active");
		await expect(guarded.saveData({})).rejects.toThrow("no longer active");
		expect(saves).toBe(0);
	});

	it("a fresh instance awaits an already-started old save before loading", async () => {
		let finish!: () => void;
		const held = new Promise<void>((resolve) => { finish = resolve; });
		const context = {};
		let value = "initial";
		const storage = {
			async loadData() { return value; },
			async saveData(data: unknown) { await held; value = data as string; },
		};
		const old = guardPluginDataStorage(context, storage, () => true);
		const saving = old.saveData("saved");
		await Promise.resolve();
		const fresh = guardPluginDataStorage(context, storage, () => true);
		let loaded = false;
		const loading = fresh.loadData().then((data) => { loaded = true; return data; });
		await Promise.resolve();
		expect(loaded).toBe(false);
		finish();
		await saving;
		expect(await loading).toBe("saved");
		await expect(old.saveData("stale")).rejects.toThrow("no longer active");
		expect(value).toBe("saved");
	});

	it("keeps different vault contexts independent", async () => {
		const storage = { async loadData() { return "ok"; }, async saveData() {} };
		const first = guardPluginDataStorage({}, storage, () => true);
		guardPluginDataStorage({}, storage, () => true);
		expect(await first.loadData()).toBe("ok");
	});

	it("serializes writes and rejects stale work across a plugin module reload", async () => {
		const context = {};
		let finish!: () => void;
		const held = new Promise<void>((resolve) => { finish = resolve; });
		let value: unknown = "initial";
		const storage = {
			async loadData() { return value; },
			async saveData(data: unknown) { await held; value = data; },
		};
		const old = guardPluginDataStorage(context, storage, () => true);
		const started = old.saveData("saved");
		await Promise.resolve();
		const stale = old.saveData("stale");
		const staleRejected = expect(stale).rejects.toThrow("no longer active");

		vi.resetModules();
		const reloaded = await import("../src/persistence/plugin-data-lifecycle");
		const fresh = reloaded.guardPluginDataStorage(context, storage, () => true);
		let loaded = false;
		const loading = fresh.loadData().then((data) => { loaded = true; return data; });
		await Promise.resolve();
		expect(loaded).toBe(false);
		finish();
		await started;
		await staleRejected;
		expect(await loading).toBe("saved");
		expect(value).toBe("saved");
	});
});
