import { describe, expect, it, vi } from "vitest";
import {
	applySharedOrder, captureOrderGroups, changedOrderGroups, decodeSharedOrder,
	mergeSharedOrders, remapSharedOrderGroups, SHARED_ORDER_FORMAT, sharedOrderPath,
	type SharedOrderDocument, type SharedOrderGroup,
} from "../src/core/shared-order";
import { createEmptyTreeState } from "../src/core/tree-state";
import { TreeStore } from "../src/core/tree-store";
import { projectTree } from "../src/core/tree-projection";
import { LocalViewState } from "../src/persistence/local-view-state";
import { SharedOrderSync, type SharedOrderStorage } from "../src/persistence/shared-order-sync";

const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
const thirdId = "00000000-0000-4000-8000-000000000003";
const group = (paths: string[], parent: string | null = null): SharedOrderGroup => ({ parent, paths });
const doc = (id = firstId, clock = 1, groups = [group(["B.md", "A.md"])]): SharedOrderDocument => (
	{ format: SHARED_ORDER_FORMAT, id, clock, groups }
);
function createTree(paths: string[]) {
	const state = createEmptyTreeState();
	paths.forEach((path, index) => { state.nodes[`n${index}`] = { id: `n${index}`, path, order: index }; });
	return new TreeStore(state);
}
function fixture() {
	const files = new Map<string, string>();
	let outbox: unknown = null;
	const storage: SharedOrderStorage = {
		list: () => [...files.keys()],
		read: async (path) => files.get(path)!,
		append: vi.fn(async (path, contents) => {
			if (files.has(path) && files.get(path) !== contents) throw new Error("Would overwrite file");
			files.set(path, contents);
		}),
		loadOutbox: () => outbox,
		saveOutbox: (documents) => { outbox = structuredClone(documents); },
	};
	return { files, storage, sync: new SharedOrderSync(storage) };
}
function deliver(from: ReturnType<typeof fixture>, to: ReturnType<typeof fixture>) {
	for (const [path, contents] of from.files) to.files.set(path, contents);
}

describe("shared order data", () => {
	it("merges independent sibling groups and deterministically resolves concurrent changes to one group", () => {
		const root = doc(firstId, 2, [group(["B.md", "A.md"])]);
		const children = doc(secondId, 2, [group(["A/Y.md", "A/X.md"], "A.md")]);
		const concurrent = doc(thirdId, 2, [group(["A.md", "B.md"])]);
		const forward = mergeSharedOrders([root, children, concurrent]);
		expect(mergeSharedOrders([concurrent, root, children])).toEqual(forward);
		expect(forward).toContainEqual(group(["A.md", "B.md"]));
		expect(forward).toContainEqual(group(["A/Y.md", "A/X.md"], "A.md"));
		expect(mergeSharedOrders([concurrent, doc(firstId, 3)])).toEqual([group(["B.md", "A.md"])]);
	});

	it("only applies order to physically present pages and preserves settings, history, and legacy folds", () => {
		const tree = createTree(["A.md", "B.md"]);
		const state = tree.getState();
		state.settings.showFilePath = true;
		state.collapsedNodeIds = ["n0"];
		state.orderHistory.old = { node: { id: "old", path: "Missing.md", order: 4 }, reason: "deleted", archivedAt: 1 };
		tree.replaceState(state);
		const groups = [group(["Missing.md", "B.md", "A.md", "Later.md"])];
		applySharedOrder(tree, ["A.md", "B.md"], groups);
		expect(projectTree(tree.getState(), ["A.md", "B.md"]).roots.map((node) => node.path)).toEqual(["B.md", "A.md"]);
		expect(Object.values(tree.getState().nodes).map((node) => node.path)).not.toContain("Later.md");
		expect(tree.getState().settings).toEqual(state.settings);
		expect(tree.getState().orderHistory).toEqual(state.orderHistory);
		expect(tree.getState().collapsedNodeIds).toEqual(state.collapsedNodeIds);
		applySharedOrder(tree, ["A.md", "B.md", "Later.md"], groups);
		expect(projectTree(tree.getState(), ["A.md", "B.md", "Later.md"]).roots.map((node) => node.path)).toEqual(["B.md", "A.md", "Later.md"]);
	});

	it("does not publish receiving changes and leaves unknown pages in a deterministic trailing order", async () => {
		const a = fixture();
		const b = fixture();
		await a.sync.publish([group(["B.md", "A.md"])]);
		deliver(a, b);
		await b.sync.reload();
		const tree = createTree(["Z.md", "A.md", "C.md", "B.md"]);
		applySharedOrder(tree, ["Z.md", "A.md", "C.md", "B.md"], b.sync.groups);
		expect(captureOrderGroups(tree.getState(), ["Z.md", "A.md", "C.md", "B.md"])[0]!.paths).toEqual(["B.md", "A.md", "C.md", "Z.md"]);
		expect(b.storage.append).not.toHaveBeenCalled();
	});

	it("remaps names in shared records without relying on a complete local file download", () => {
		const groups = [group(["A.md", "B.md"]), group(["A/Y.md", "A/X.md"], "A.md")];
		const result = remapSharedOrderGroups(groups, [
			{ from: "A.md", to: "Renamed.md" },
			{ from: "A/Y.md", to: "Renamed/Y.md" },
			{ from: "A/X.md", to: "Renamed/X.md" },
		]);
		expect(result).toContainEqual(group(["Renamed.md", "B.md"]));
		expect(result).toContainEqual(group(["Renamed/Y.md", "Renamed/X.md"], "Renamed.md"));
		expect(result).toContainEqual(group([], "A.md"));
		expect(remapSharedOrderGroups(result, [{ from: "A.md", to: "Renamed.md" }])).toEqual([]);
	});

	it("captures only changed sibling groups", () => {
		const before = [group(["A.md", "B.md"]), group(["A/X.md", "A/Y.md"], "A.md")];
		const after = [group(["B.md", "A.md"]), before[1]!];
		expect(changedOrderGroups(before, after)).toEqual([after[0]]);
		expect(changedOrderGroups(after, after)).toEqual([]);
	});

	it.each(["../Escape.md", "/absolute.md", "C:/x.md", ".obsidian/x.md", "a\\b.md", "a\u0000.md"])("rejects unsafe path %s", (path) => {
		expect(() => decodeSharedOrder(doc(firstId, 1, [group([path])]))).toThrow();
	});

	it("rejects unsupported formats, duplicate groups, duplicate paths, and invalid clocks", () => {
		for (const raw of [
			{ ...doc(), format: "page-tree-order-v2" }, { ...doc(), clock: Number.MAX_SAFE_INTEGER },
			{ ...doc(), clock: -1 }, { ...doc(), clock: 1.5 }, { ...doc(), id: "../../x" },
			doc(firstId, 1, [group(["A.md", "a.md"])]), doc(firstId, 1, [group([]), group([])]),
		]) expect(() => decodeSharedOrder(raw)).toThrow();
	});
});

describe("shared order delivery", () => {
	it("converges after independent offline edits, reverse delivery, duplicate delivery, and restart", async () => {
		const computer = fixture();
		const phone = fixture();
		await computer.sync.publish([group(["A.md", "B.md"]), group(["A/X.md", "A/Y.md"], "A.md")]);
		deliver(computer, phone);
		await phone.sync.reload();
		await computer.sync.publish([group(["B.md", "A.md"])]);
		await phone.sync.publish([group(["A/Y.md", "A/X.md"], "A.md")]);
		deliver(phone, computer);
		deliver(computer, phone);
		await computer.sync.reload();
		await phone.sync.reload();
		expect(computer.sync.groups).toEqual(phone.sync.groups);
		expect(phone.sync.groups).toContainEqual(group(["B.md", "A.md"]));
		expect(phone.sync.groups).toContainEqual(group(["A/Y.md", "A/X.md"], "A.md"));
		const restarted = new SharedOrderSync(phone.storage);
		await restarted.reload();
		expect(restarted.groups).toEqual(computer.sync.groups);
		expect(phone.files.size).toBe(3);
	});

	it("keeps collapse/expand state different on two devices with identical shared order", async () => {
		const computer = fixture();
		const phone = fixture();
		const computerTree = createTree(["A.md", "A/X.md", "B.md"]);
		const phoneTree = createTree(["B.md", "A.md", "A/X.md"]);
		const computerFolds = new LocalViewState({ load: () => null, save: vi.fn() }, computerTree.getState());
		const phoneFolds = new LocalViewState({ load: () => null, save: vi.fn() }, phoneTree.getState());
		computerFolds.setCollapsed("A.md", true);
		phoneFolds.setCollapsed("A.md", false);
		await computer.sync.publish(captureOrderGroups(computerTree.getState(), ["A.md", "A/X.md", "B.md"]));
		deliver(computer, phone);
		await phone.sync.reload();
		applySharedOrder(phoneTree, ["A.md", "A/X.md", "B.md"], phone.sync.groups);
		expect(captureOrderGroups(phoneTree.getState(), ["A.md", "A/X.md", "B.md"]))
			.toEqual(captureOrderGroups(computerTree.getState(), ["A.md", "A/X.md", "B.md"]));
		expect(computerFolds.isCollapsed("A.md")).toBe(true);
		expect(phoneFolds.isCollapsed("A.md")).toBe(false);
		expect([...computer.files.values()].join()).not.toMatch(/collapsed|settings|orderHistory/);
	});

	it("keeps a durable outbox on failed writes and retries the original operation after restart", async () => {
		const a = fixture();
		vi.mocked(a.storage.append).mockRejectedValueOnce(new Error("Disk full"));
		await expect(a.sync.publish([group(["B.md", "A.md"])])).rejects.toThrow("Disk full");
		const pending = structuredClone(a.storage.loadOutbox()) as SharedOrderDocument[];
		expect(pending).toHaveLength(1);
		expect(a.files.size).toBe(0);
		const restarted = new SharedOrderSync(a.storage);
		await restarted.reload();
		expect(a.files.size).toBe(1);
		expect(JSON.parse([...a.files.values()][0]!)).toEqual(pending[0]);
		expect(a.storage.loadOutbox()).toEqual([]);
	});

	it("does not give retried offline edits a newer clock than an already received edit", async () => {
		const a = fixture();
		vi.mocked(a.storage.append).mockRejectedValueOnce(new Error("Disk full"));
		await expect(a.sync.publish([group(["B.md", "A.md"])])).rejects.toThrow();
		a.files.set(sharedOrderPath(secondId), JSON.stringify(doc(secondId, 5, [group(["A.md", "B.md"])])));
		const restarted = new SharedOrderSync(a.storage);
		await restarted.reload();
		expect(restarted.groups).toEqual([group(["A.md", "B.md"])]);
		await restarted.publish([group(["B.md", "A.md"])]);
		expect(restarted.groups).toEqual([group(["B.md", "A.md"])]);
	});

	it("retains last valid data on partial downloads and refuses publishing over unknown formats", async () => {
		const a = fixture();
		const path = sharedOrderPath(firstId);
		a.files.set(path, JSON.stringify(doc()));
		await a.sync.reload();
		a.files.set(path, "{");
		await expect(a.sync.reload()).rejects.toThrow();
		expect(a.sync.groups).toEqual([group(["B.md", "A.md"])]);
		await expect(a.sync.publish([group(["A.md", "B.md"])])).rejects.toThrow();
		a.files.set(path, JSON.stringify(doc()));
		await a.sync.reload();
		await a.sync.publish([group(["A.md", "B.md"])]);
		expect(a.sync.groups).toEqual([group(["A.md", "B.md"])]);
	});

	it("retries safely if append succeeded but clearing the outbox failed", async () => {
		const a = fixture();
		const save = a.storage.saveOutbox;
		a.storage.saveOutbox = (documents) => {
			if (documents.length === 0) throw new Error("Local storage unavailable");
			save(documents);
		};
		await expect(a.sync.publish([group(["B.md", "A.md"])])).rejects.toThrow();
		expect(a.files.size).toBe(1);
		a.storage.saveOutbox = save;
		const restarted = new SharedOrderSync(a.storage);
		await restarted.reload();
		expect(a.files.size).toBe(1);
		expect(a.storage.loadOutbox()).toEqual([]);
	});

	it("rejects a corrupt outbox rather than deleting it", () => {
		const a = fixture();
		a.storage.loadOutbox = () => ({ bad: true });
		a.storage.saveOutbox = vi.fn();
		expect(() => new SharedOrderSync(a.storage)).toThrow();
		expect(a.storage.saveOutbox).not.toHaveBeenCalled();
	});
});
