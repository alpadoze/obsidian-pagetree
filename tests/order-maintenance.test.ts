import { describe, expect, it } from "vitest";
import {
	addPageOrder,
	archiveOrderPaths,
	registerVisibleOrder,
	remapOrderPaths,
	restoreOrderRecord,
} from "../src/core/order-maintenance";
import { projectTree, type ProjectedTreeNode } from "../src/core/tree-projection";
import { createEmptyTreeState, type TreeNode } from "../src/core/tree-state";
import { TreeStore } from "../src/core/tree-store";

function storeWith(nodes: TreeNode[] = []): TreeStore {
	const state = createEmptyTreeState();
	state.nodes = Object.fromEntries(nodes.map((node) => [node.id, node]));
	return new TreeStore(state);
}

function shape(tree: TreeStore, paths: string[]): unknown {
	const visit = (nodes: ProjectedTreeNode[]): unknown => nodes.map((node) => ({ path: node.path, children: visit(node.children) }));
	return visit(projectTree(tree.getState(), paths).roots);
}

function roots(tree: TreeStore, paths: string[]): string[] {
	return projectTree(tree.getState(), paths).roots.map((node) => node.path);
}

function children(tree: TreeStore, paths: string[], parent: string): string[] {
	const find = (nodes: ProjectedTreeNode[]): ProjectedTreeNode | undefined => {
		for (const node of nodes) {
			if (node.path === parent) return node;
			const nested = find(node.children);
			if (nested) return nested;
		}
		return undefined;
	};
	return find(projectTree(tree.getState(), paths).roots)?.children.map((node) => node.path) ?? [];
}

describe("explicit order registration", () => {
	it.each([false, true])("preserves mixed visible order with a missing parent record: %s", (ghost) => {
		const tree = storeWith([
			{ id: "z", path: "Z.md", order: 3 },
			{ id: "child", path: "Missing/Child.md", order: 2 },
			...(ghost ? [{ id: "ghost", path: "Missing.md", order: 1 }] : []),
		]);
		const paths = ["A.md", "B.md", "B/Second.md", "B/First.md", "Z.md", "Missing/Child.md"];
		const before = shape(tree, paths);
		const oldGhost = tree.getNode("ghost");
		registerVisibleOrder(tree, paths);
		expect(shape(tree, paths)).toEqual(before);
		expect(projectTree(tree.getState(), paths).metadataMissingPaths).toEqual([]);
		expect(tree.getNode("ghost")).toEqual(oldGhost);
		expect(tree.getState().revision).toBe(1);
		const registered = tree.getState();
		registerVisibleOrder(tree, paths);
		expect(tree.getState()).toEqual(registered);
	});

	it("preserves existing custom order rather than alphabetically resetting it", () => {
		const tree = storeWith([
			{ id: "c", path: "C.md", order: 0 },
			{ id: "b", path: "B.md", order: 1 },
		]);
		registerVisibleOrder(tree, ["A.md", "B.md", "C.md"]);
		expect(roots(tree, ["A.md", "B.md", "C.md"])).toEqual(["C.md", "B.md", "A.md"]);
	});

	it("adds a page last without promoting it in front of unregistered siblings", () => {
		const tree = storeWith([{ id: "z", path: "Z.md", order: 4 }]);
		const paths = ["A.md", "B.md", "Z.md"];
		addPageOrder(tree, paths, "AAA.md");
		expect(roots(tree, [...paths, "AAA.md"])).toEqual(["Z.md", "A.md", "B.md", "AAA.md"]);
		expect(tree.getState().revision).toBe(1);
		const state = tree.getState();
		addPageOrder(tree, paths, "AAA.md");
		expect(tree.getState()).toEqual(state);
	});

	it("appends under the visible parent and does not alter other sibling groups", () => {
		const tree = storeWith();
		const paths = ["Parent.md", "Parent/B.md", "Parent/C.md", "Elsewhere.md"];
		const before = roots(tree, paths);
		addPageOrder(tree, paths, "Parent/A.md");
		expect(children(tree, [...paths, "Parent/A.md"], "Parent.md")).toEqual(["Parent/B.md", "Parent/C.md", "Parent/A.md"]);
		expect(roots(tree, [...paths, "Parent/A.md"])).toEqual(before);
	});

	it("preserves orphan relative order when adding their formerly missing parent", () => {
		const tree = storeWith([{ id: "b", path: "Parent/B.md", order: 0 }]);
		const paths = ["A.md", "Parent/A.md", "Parent/B.md"];
		addPageOrder(tree, paths, "Parent.md");
		expect(roots(tree, [...paths, "Parent.md"])).toEqual(["A.md", "Parent.md"]);
		expect(children(tree, [...paths, "Parent.md"], "Parent.md")).toEqual(["Parent/B.md", "Parent/A.md"]);
	});
});

describe("explicit path remapping", () => {
	it("keeps an unregistered same-directory rename in its original position", () => {
		const tree = storeWith();
		remapOrderPaths(tree, ["A.md", "B.md", "C.md"], [{ from: "B.md", to: "Z.md" }], ["A.md", "Z.md", "C.md"]);
		expect(roots(tree, ["A.md", "Z.md", "C.md"])).toEqual(["A.md", "Z.md", "C.md"]);
		expect(tree.findNodeByPath("B.md")).toBeNull();
		expect(tree.getState().revision).toBe(1);
	});

	it("keeps tracked identity on a Unicode/case title change", () => {
		const tree = storeWith([{ id: "page", path: "CAFÉ.md", order: 0 }]);
		remapOrderPaths(tree, ["CAFÉ.md"], [{ from: "CAFÉ.md", to: "Cafe\u0301.md" }], ["Cafe\u0301.md"]);
		expect(tree.getNode("page")?.path).toBe("Cafe\u0301.md");
		expect(Object.keys(tree.getState().nodes)).toEqual(["page"]);
	});

	it("appends a moved page after target siblings without changing the others", () => {
		const tree = storeWith();
		const before = ["Source.md", "Target.md", "Source/A.md", "Source/B.md", "Target/Z.md"];
		const after = ["Source.md", "Target.md", "Source/B.md", "Target/A.md", "Target/Z.md"];
		remapOrderPaths(tree, before, [{ from: "Source/A.md", to: "Target/A.md" }], after);
		expect(children(tree, after, "Target.md")).toEqual(["Target/Z.md", "Target/A.md"]);
		expect(children(tree, after, "Source.md")).toEqual(["Source/B.md"]);
		expect(roots(tree, after)).toEqual(["Source.md", "Target.md"]);
	});

	it("preserves a remapped subtree's internal custom order and stable IDs", () => {
		const tree = storeWith([
			{ id: "p", path: "Project.md", order: 0 },
			{ id: "c", path: "Project/C.md", order: 0 },
			{ id: "b", path: "Project/B.md", order: 1 },
		]);
		const before = ["Project.md", "Project/A.md", "Project/B.md", "Project/C.md", "Target.md", "Target/Existing.md"];
		const changes = before.filter((path) => path.startsWith("Project")).map((from) => ({ from, to: `Target/${from}` }));
		const after = before.map((path) => changes.find(({ from }) => from === path)?.to ?? path);
		remapOrderPaths(tree, before, changes, after);
		expect(children(tree, after, "Target.md")).toEqual(["Target/Existing.md", "Target/Project.md"]);
		expect(children(tree, after, "Target/Project.md")).toEqual(["Target/Project/C.md", "Target/Project/B.md", "Target/Project/A.md"]);
		expect(tree.getNode("p")?.path).toBe("Target/Project.md");
		expect(tree.getNode("c")?.path).toBe("Target/Project/C.md");
	});

	it("supports explicit before/after placement in unchanged paths", () => {
		const tree = storeWith();
		const paths = ["A.md", "B.md", "C.md"];
		remapOrderPaths(tree, paths, [], paths, { path: "C.md", targetPath: "A.md", type: "before" });
		expect(roots(tree, paths)).toEqual(["C.md", "A.md", "B.md"]);
		remapOrderPaths(tree, paths, [], paths, { path: "C.md", targetPath: "B.md", type: "after" });
		expect(roots(tree, paths)).toEqual(["A.md", "B.md", "C.md"]);
		expect(tree.getState().revision).toBe(2);
	});

	it("places a remapped page by its destination path", () => {
		const tree = storeWith();
		const before = ["A.md", "Parent.md", "Parent/B.md"];
		const after = ["Parent.md", "Parent/A.md", "Parent/B.md"];
		remapOrderPaths(tree, before, [{ from: "A.md", to: "Parent/A.md" }], after,
			{ path: "Parent/A.md", targetPath: "Parent/B.md", type: "before" });
		expect(children(tree, after, "Parent.md")).toEqual(["Parent/A.md", "Parent/B.md"]);
	});

	it("ignores replayed old events without registering a ghost path", () => {
		const tree = storeWith();
		const changes = [{ from: "A.md", to: "B.md" }];
		remapOrderPaths(tree, ["A.md"], changes, ["B.md"]);
		const state = tree.getState();
		remapOrderPaths(tree, ["B.md"], changes, ["B.md"]);
		expect(tree.getState()).toEqual(state);
		remapOrderPaths(tree, ["A.md"], changes, ["B.md"]);
		expect(tree.getState()).toEqual(state);
	});

	it("does not guess identity for matching names in different folders", () => {
		const tree = storeWith([{ id: "old", path: "Old/Same.md", order: 0 }]);
		const state = tree.getState();
		remapOrderPaths(tree, ["Other/Same.md"], [{ from: "Absent/Same.md", to: "New/Same.md" }], ["New/Same.md"]);
		expect(tree.getState()).toEqual(state);
		expect(tree.findNodeByPath("New/Same.md")).toBeNull();
	});

	it("does not prune unrelated stale records while handling a rename", () => {
		const tree = storeWith([{ id: "stale", path: "Gone.md", order: 17 }]);
		remapOrderPaths(tree, ["A.md"], [{ from: "A.md", to: "B.md" }], ["B.md"]);
		expect(tree.getNode("stale")).toEqual({ id: "stale", path: "Gone.md", order: 17 });
		expect(tree.getState().orderHistory).toEqual({});
	});

	it("does not claim an unrelated concurrent rename before its own queued event", () => {
		const tree = storeWith([
			{ id: "x", path: "X.md", order: 0 },
			{ id: "y", path: "Y.md", order: 1 },
			{ id: "parent", path: "Parent.md", order: 2 },
		]);
		const after = ["Parent/X.md", "Z.md", "Parent.md"];
		remapOrderPaths(tree, ["X.md", "Y.md", "Parent.md"],
			[{ from: "X.md", to: "Parent/X.md" }], after);
		expect(tree.findNodeByPath("Z.md")).toBeNull();
		expect(tree.getNode("y")?.path).toBe("Y.md");

		remapOrderPaths(tree, ["Parent/X.md", "Y.md", "Parent.md"],
			[{ from: "Y.md", to: "Z.md" }], after);
		expect(tree.getNode("y")?.path).toBe("Z.md");
		expect(tree.findNodeByPath("Y.md")).toBeNull();
		expect(Object.keys(tree.getState().nodes).sort()).toEqual(["parent", "x", "y"]);
	});

	it("leaves an unrelated newly created page for its own creation event", () => {
		const tree = storeWith();
		remapOrderPaths(tree, ["A.md", "B.md"], [{ from: "A.md", to: "Z.md" }], ["Z.md", "B.md", "New.md"]);
		expect(tree.findNodeByPath("New.md")).toBeNull();
		expect(roots(tree, ["Z.md", "B.md"])).toEqual(["Z.md", "B.md"]);
		addPageOrder(tree, ["Z.md", "B.md"], "New.md");
		expect(roots(tree, ["Z.md", "B.md", "New.md"])).toEqual(["Z.md", "B.md", "New.md"]);
	});

	it("does not renumber an unrelated active record that only appears in the after snapshot", () => {
		const tree = storeWith([{ id: "unexpected", path: "Unexpected.md", order: 45 }]);
		remapOrderPaths(tree, ["A.md"], [{ from: "A.md", to: "B.md" }], ["B.md", "Unexpected.md"]);
		expect(tree.getNode("unexpected")).toEqual({ id: "unexpected", path: "Unexpected.md", order: 45 });
	});

	it("rejects placement against an unknown concurrent path without claiming it", () => {
		const tree = storeWith();
		const before = tree.getState();
		expect(() => remapOrderPaths(tree, ["A.md"], [], ["A.md", "Concurrent.md"],
			{ path: "A.md", targetPath: "Concurrent.md", type: "after" })).toThrow();
		expect(tree.getState()).toEqual(before);
	});

	it("keeps orphan root position when its folder is renamed with no parent body", () => {
		const tree = storeWith([{ id: "child", path: "Old/Child.md", order: 0 }]);
		const before = ["A.md", "Old/Child.md", "Z.md"];
		const after = ["A.md", "New/Child.md", "Z.md"];
		remapOrderPaths(tree, before, [{ from: "Old/Child.md", to: "New/Child.md" }], after);
		expect(roots(tree, after)).toEqual(["New/Child.md", "A.md", "Z.md"]);
	});

	it("rejects destination collisions atomically without overwriting another ID", () => {
		const tree = storeWith([
			{ id: "source", path: "A.md", order: 0 },
			{ id: "target", path: "B.md", order: 1 },
		]);
		const before = tree.getState();
		expect(() => remapOrderPaths(tree, ["A.md"], [{ from: "A.md", to: "B.md" }], ["B.md"])).toThrow();
		expect(tree.getState()).toEqual(before);
	});

	it("rejects multiple sources targeting one destination atomically", () => {
		const tree = storeWith();
		const before = tree.getState();
		expect(() => remapOrderPaths(tree, ["A.md", "B.md"], [
			{ from: "A.md", to: "C.md" }, { from: "B.md", to: "C.md" },
		], ["C.md"])).toThrow();
		expect(tree.getState()).toEqual(before);
	});

	it("rejects a placement between different visible parents atomically", () => {
		const tree = storeWith();
		const paths = ["Parent.md", "Parent/A.md", "B.md"];
		const before = tree.getState();
		expect(() => remapOrderPaths(tree, paths, [], paths,
			{ path: "Parent/A.md", targetPath: "B.md", type: "before" })).toThrow();
		expect(tree.getState()).toEqual(before);
	});
});

describe("reversible order history", () => {
	it("archives exact paths without registering or renumbering anything else", () => {
		const tree = storeWith([
			{ id: "a", path: "A.md", order: 0 },
			{ id: "b", path: "B.md", order: 9 },
			{ id: "child", path: "A/Child.md", order: 4 },
			{ id: "stale", path: "Absent.md", order: 2 },
		]);
		const state = tree.getState();
		state.collapsedNodeIds = ["a", "child"];
		tree.replaceState(state);
		archiveOrderPaths(tree, ["a.MD"], "deleted", 100);
		expect(tree.getState().nodes).toEqual({ b: state.nodes.b, child: state.nodes.child, stale: state.nodes.stale });
		expect(tree.getState().collapsedNodeIds).toEqual(["child"]);
		expect(tree.getState().orderHistory).toEqual({ a: { node: state.nodes.a, reason: "deleted", archivedAt: 100 } });
		expect(tree.getState().revision).toBe(1);
		const archived = tree.getState();
		archiveOrderPaths(tree, ["A.md"], "missing", 200);
		expect(tree.getState()).toEqual(archived);
	});

	it("does nothing when none of the supplied paths have an active record", () => {
		const tree = storeWith([{ id: "a", path: "A.md", order: 3 }]);
		const before = tree.getState();
		archiveOrderPaths(tree, ["Absent.md"], "missing", 100);
		expect(tree.getState()).toEqual(before);
	});

	it("restores original ID and order only after explicit request and with a present file", () => {
		const tree = storeWith([{ id: "a", path: "A.md", order: 7 }]);
		archiveOrderPaths(tree, ["A.md"], "deleted", 100);
		const before = tree.getState();
		expect(restoreOrderRecord(tree, "a", [])).toBe(false);
		expect(tree.getState()).toEqual(before);
		expect(restoreOrderRecord(tree, "a", ["A.md"])).toBe(true);
		expect(tree.getNode("a")).toEqual({ id: "a", path: "A.md", order: 7 });
		expect(tree.getState().orderHistory).toEqual({});
		expect(tree.getState().revision).toBe(2);
	});

	it("undoes missing-record cleanup immediately without a file or changes to other order values", () => {
		const tree = storeWith([
			{ id: "missing", path: "Missing.md", order: 7 },
			{ id: "other", path: "Other.md", order: 15 },
		]);
		const originalNodes = tree.getState().nodes;
		archiveOrderPaths(tree, ["Missing.md"], "missing", 100);
		expect(restoreOrderRecord(tree, "missing", [])).toBe(true);
		expect(tree.getState().nodes).toEqual(originalNodes);
		expect(tree.getState().orderHistory).toEqual({});
		expect(tree.getState().revision).toBe(2);
	});

	it.each(["constructor", "toString"])("archives and restores an ordinary valid ID named %s", (id) => {
		const tree = storeWith([{ id, path: "A.md", order: 7 }]);
		archiveOrderPaths(tree, ["A.md"], "deleted", 100);
		expect(Object.keys(tree.getState().orderHistory)).toEqual([id]);
		expect(restoreOrderRecord(tree, id, ["A.md"])).toBe(true);
		expect(tree.getState().nodes[id]).toEqual({ id, path: "A.md", order: 7 });
	});

	it("delete plus create never restores old identity or overwrites a newly created record", () => {
		const tree = storeWith([{ id: "old", path: "A.md", order: 7 }]);
		archiveOrderPaths(tree, ["A.md"], "deleted", 100);
		addPageOrder(tree, [], "A.md");
		const replacement = tree.findNodeByPath("A.md")!;
		expect(replacement.id).not.toBe("old");
		const before = tree.getState();
		expect(restoreOrderRecord(tree, "old", ["A.md"])).toBe(false);
		expect(tree.getState()).toEqual(before);
		expect(tree.getState().orderHistory.old?.node.order).toBe(7);
	});

	it("preserves repeated histories for the same path without overwriting earlier records", () => {
		const tree = storeWith([{ id: "old", path: "A.md", order: 7 }]);
		archiveOrderPaths(tree, ["A.md"], "deleted", 100);
		addPageOrder(tree, [], "A.md");
		const newId = tree.findNodeByPath("A.md")!.id;
		archiveOrderPaths(tree, ["A.md"], "deleted", 200);
		expect(Object.keys(tree.getState().orderHistory).sort()).toEqual(["old", newId].sort());
		expect(tree.getState().orderHistory.old?.archivedAt).toBe(100);
		expect(tree.getState().orderHistory[newId]?.archivedAt).toBe(200);
	});

	it("does not restore a history into a same-named file in another folder", () => {
		const tree = storeWith([{ id: "old", path: "Old/Same.md", order: 0 }]);
		archiveOrderPaths(tree, ["Old/Same.md"], "deleted", 100);
		const before = tree.getState();
		expect(restoreOrderRecord(tree, "old", ["New/Same.md"])).toBe(false);
		expect(restoreOrderRecord(tree, "unknown", ["Old/Same.md"])).toBe(false);
		expect(tree.getState()).toEqual(before);
	});
});
