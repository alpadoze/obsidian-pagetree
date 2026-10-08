import { describe, expect, it } from "vitest";
import { createEmptyTreeState } from "../src/core/tree-state";
import { projectTree } from "../src/core/tree-projection";
import { TreeStore } from "../src/core/tree-store";

describe("projectTree", () => {
	it("reconstructs the recursive tree from physical paths without metadata", () => {
		const projection = projectTree(createEmptyTreeState(), [
			"Project/Requirements/Details.md",
			"Project.md",
			"Project/Requirements.md",
			"Loose.md",
		]);

		expect(projection.roots).toEqual([
			{ id: null, path: "Loose.md", children: [] },
			{
				id: null,
				path: "Project.md",
				children: [
					{
						id: null,
						path: "Project/Requirements.md",
						children: [
							{ id: null, path: "Project/Requirements/Details.md", children: [] },
						],
					},
				],
			},
		]);
		expect(projection.metadataMissingPaths).toHaveLength(4);
		expect(projection.pageCount).toBe(4);
	});

	it("uses metadata only for stable IDs and sibling order", () => {
		const store = new TreeStore(createEmptyTreeState());
		store.addNode({ id: "project", path: "Project.md" });
		store.addNode({ id: "requirements", path: "Project/Requirements.md" });
		store.addNode({ id: "architecture", path: "Project/Architecture.md", index: 0 });

		const projection = projectTree(store.getState(), [
			"Project/Requirements.md",
			"Project.md",
			"Project/Architecture.md",
		]);

		expect(projection.roots[0]?.children.map((node) => node.id)).toEqual([
			"architecture",
			"requirements",
		]);
		expect(projection.metadataMissingPaths).toEqual([]);
	});

	it("shows a nested file as a root when its paired parent page is missing", () => {
		const store = new TreeStore(createEmptyTreeState());
		store.addNode({ id: "child", path: "Missing parent/Child.md" });

		const projection = projectTree(store.getState(), ["Missing parent/Child.md"]);

		expect(projection.roots).toEqual([
			{ id: "child", path: "Missing parent/Child.md", children: [] },
		]);
		expect(projection.missingNodeIds).toEqual([]);
	});
});
