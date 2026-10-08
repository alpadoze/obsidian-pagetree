import { describe, expect, it } from "vitest";
import { createEmptyTreeState } from "../src/core/tree-state";
import { TreeOperationError, TreeStore } from "../src/core/tree-store";

describe("TreeStore", () => {
	it("derives roots and children from physical page paths", () => {
		const store = new TreeStore(createEmptyTreeState());
		store.addNode({ id: "project", path: "Project.md" });
		store.addNode({ id: "journal", path: "Journal.md", index: 0 });
		store.addNode({ id: "requirements", path: "Project/Requirements.md" });

		expect(store.getChildren(null).map((node) => node.id)).toEqual(["journal", "project"]);
		expect(store.getChildren("project").map((node) => node.id)).toEqual(["requirements"]);
		expect(store.getState().revision).toBe(3);
		expect(store.getState().nodes.requirements).not.toHaveProperty("parentId");
	});

	it("moves a physical subtree and reorders roots atomically", () => {
		const store = new TreeStore(createEmptyTreeState());
		store.addNode({ id: "one", path: "One.md" });
		store.addNode({ id: "two", path: "Two.md" });
		store.addNode({ id: "detail", path: "Two/Detail.md" });
		store.addNode({ id: "three", path: "Three.md" });

		store.reorderNode("one", 2);
		expect(store.getChildren(null).map((node) => node.id)).toEqual(["two", "three", "one"]);

		store.moveNode("two", "one", 0);
		expect(store.getChildren(null).map((node) => node.id)).toEqual(["three", "one"]);
		expect(store.getChildren("one").map((node) => node.id)).toEqual(["two"]);
		expect(store.getNode("two")?.path).toBe("One/Two.md");
		expect(store.getNode("detail")?.path).toBe("One/Two/Detail.md");
	});

	it("rejects moving a page below its physical descendant without partial changes", () => {
		const store = new TreeStore(createEmptyTreeState());
		store.addNode({ id: "parent", path: "Parent.md" });
		store.addNode({ id: "child", path: "Parent/Child.md" });
		const before = store.getState();

		expect(() => store.moveNode("parent", "child")).toThrowError(TreeOperationError);
		expect(store.getState()).toEqual(before);
	});

	it("normalizes metadata when a page record is removed", () => {
		const store = new TreeStore(createEmptyTreeState());
		store.addNode({ id: "parent", path: "Parent.md" });
		store.addNode({ id: "sibling", path: "Sibling.md" });
		store.addNode({ id: "first-child", path: "Parent/First child.md" });
		store.addNode({ id: "second-child", path: "Parent/Second child.md" });
		store.setCollapsed("parent", true);

		store.removeNode("parent");

		expect(store.getChildren(null).map((node) => node.id)).toEqual([
			"first-child",
			"second-child",
			"sibling",
		]);
		expect(store.getState().collapsedNodeIds).not.toContain("parent");
	});

	it("cascades a renamed parent path through its descendants", () => {
		const store = new TreeStore(createEmptyTreeState());
		store.addNode({ id: "parent", path: "Parent.md" });
		store.addNode({ id: "child", path: "Parent/Child.md" });
		store.addNode({ id: "detail", path: "Parent/Child/Detail.md" });

		store.updatePath("parent", "Renamed.md");

		expect(store.getNode("parent")?.path).toBe("Renamed.md");
		expect(store.getNode("child")?.path).toBe("Renamed/Child.md");
		expect(store.getNode("detail")?.path).toBe("Renamed/Child/Detail.md");
	});

	it("treats vault paths as case-insensitively unique", () => {
		const store = new TreeStore(createEmptyTreeState());
		store.addNode({ id: "one", path: "Area/Note.md" });

		expect(() => store.addNode({ id: "two", path: "area/note.md" })).toThrowError(
			TreeOperationError,
		);
	});

	it("returns defensive snapshots", () => {
		const store = new TreeStore(createEmptyTreeState());
		store.addNode({ id: "one", path: "One.md" });
		const snapshot = store.getState();
		snapshot.nodes.one!.path = "Mutated.md";

		expect(store.getNode("one")?.path).toBe("One.md");
	});
});
