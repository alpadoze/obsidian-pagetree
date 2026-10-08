import { describe, expect, it } from "vitest";
import { cloneTreeState, createEmptyTreeState, type TreeState } from "../src/core/tree-state";
import { decodeTreeState, validateTreeState } from "../src/core/tree-validator";

describe("validateTreeState", () => {
	it("accepts an empty physical tree metadata document", () => {
		expect(validateTreeState(createEmptyTreeState())).toEqual({ valid: true, issues: [] });
	});

	it("rejects duplicate active paths even when their orders differ", () => {
		const state: TreeState = {
			...createEmptyTreeState(),
			nodes: {
				one: { id: "one", path: "Project.md", order: 1 },
				two: { id: "two", path: "project.md", order: 0 },
				three: { id: "three", path: "Journal.md", order: 3 },
			},
		};

		const codes = validateTreeState(state).issues.map((issue) => issue.code);
		expect(codes).toEqual(["duplicate-path"]);
	});

	it("accepts duplicate and non-contiguous order values without renumbering nodes", () => {
		const state: TreeState = {
			...createEmptyTreeState(),
			nodes: {
				project: { id: "project", path: "Project.md", order: 20 },
				requirements: { id: "requirements", path: "Project/Requirements.md", order: 42 },
				architecture: { id: "architecture", path: "Project/Architecture.md", order: 42 },
			},
		};

		const before = structuredClone(state);
		expect(validateTreeState(state)).toEqual({ valid: true, issues: [] });
		expect(state).toEqual(before);
	});

	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		"rejects unsafe active node order %s",
		(order) => {
			const state = createEmptyTreeState();
			state.nodes.one = { id: "one", path: "One.md", order };
			expect(validateTreeState(state).issues.map((issue) => issue.code)).toContain("invalid-order");
		},
	);

	it("allows several historical occupants of a path also used by a new active page", () => {
		const state = historyState();
		state.orderHistory.older = {
			node: { id: "older", path: "ONE.md", order: 99 }, reason: "missing", archivedAt: 1,
		};
		expect(validateTreeState(state)).toEqual({ valid: true, issues: [] });
	});

	it("rejects an ID shared by the active tree and order history", () => {
		const state = historyState();
		state.nodes.old = { id: "old", path: "Another.md", order: 7 };
		expect(validateTreeState(state).issues.map((issue) => issue.code)).toContain("duplicate-history-node-id");
	});

	it("deeply clones historical records and their nodes", () => {
		const state = historyState();
		const copy = cloneTreeState(state);
		expect(copy).toEqual(state);
		copy.orderHistory.old!.node.path = "Changed.md";
		copy.orderHistory.old!.reason = "missing";
		copy.orderHistory.old!.archivedAt = 999;
		expect(state.orderHistory.old).toEqual({
			node: { id: "old", path: "One.md", order: 2 }, reason: "deleted", archivedAt: 100,
		});
	});
});

describe("decodeTreeState", () => {
	it("rejects malformed or obsolete JSON-shaped data instead of coercing it", () => {
		const result = decodeTreeState({
			schemaVersion: 1,
			revision: "2",
			nodes: [],
			collapsedNodeIds: "one",
			settings: {},
		});

		expect(result.valid).toBe(false);
		expect(result.state).toBeNull();
		expect(result.issues.length).toBeGreaterThanOrEqual(4);
	});

	it("decodes schema v2 nodes without a persisted parent relation", () => {
		const result = decodeTreeState({
			schemaVersion: 2,
			revision: 1,
			nodes: {
				project: { id: "project", path: "Project.md", order: 0 },
				requirements: { id: "requirements", path: "Project/Requirements.md", order: 0 },
			},
			collapsedNodeIds: [],
			settings: { showFilePath: false },
		});

		expect(result.valid).toBe(true);
		expect(result.state?.schemaVersion).toBe(3);
		expect(result.state?.orderHistory).toEqual({});
		expect(result.state?.nodes.requirements).toEqual({
			id: "requirements",
			path: "Project/Requirements.md",
			order: 0,
		});
	});

	it("migrates schema v2 without changing IDs, paths, order, revision, or legacy collapse memory", () => {
		const legacy = {
			schemaVersion: 2,
			revision: 72,
			nodes: {
				one: { id: "one", path: "One.md", order: 20 },
				two: { id: "two", path: "Two.md", order: 20 },
				child: { id: "child", path: "One/Child.md", order: 9 },
			},
			collapsedNodeIds: ["two", "one"],
			settings: { showFilePath: true },
		};
		const before = structuredClone(legacy);
		const result = decodeTreeState(legacy);
		expect(result).toEqual({
			valid: true,
			issues: [],
			state: { ...legacy, schemaVersion: 3, orderHistory: {} },
		});
		expect(legacy).toEqual(before);
		result.state!.nodes.one!.order = 0;
		result.state!.collapsedNodeIds.reverse();
		expect(legacy).toEqual(before);
	});

	it("decodes a complete schema v3 history without retaining mutable source references", () => {
		const state = historyState();
		const result = decodeTreeState(state);
		expect(result.state).toEqual(state);
		result.state!.orderHistory.old!.node.order = 8;
		expect(state.orderHistory.old!.node.order).toBe(2);
	});

	it.each([undefined, null, [], "history"])("rejects an invalid history collection %j", (orderHistory) => {
		const result = decodeTreeState({ ...createEmptyTreeState(), orderHistory });
		expect(result.state).toBeNull();
		expect(result.issues.map((issue) => issue.code)).toContain("invalid-order-history");
	});

	it.each([
		[null, "invalid-archived-order"],
		[{}, "invalid-archived-order"],
		[{ node: null, reason: "deleted", archivedAt: 100 }, "invalid-archived-order"],
		[{ node: { id: "old", path: "One.md", order: "2" }, reason: "deleted", archivedAt: 100 }, "invalid-archived-order"],
		[{ node: { id: "wrong", path: "One.md", order: 2 }, reason: "deleted", archivedAt: 100 }, "node-id-mismatch"],
		[{ node: { id: "old", path: "../One.md", order: 2 }, reason: "deleted", archivedAt: 100 }, "invalid-path"],
		[{ node: { id: "old", path: "One.md", order: -1 }, reason: "deleted", archivedAt: 100 }, "invalid-order"],
		[{ node: { id: "old", path: "One.md", order: 2 }, reason: "renamed", archivedAt: 100 }, "invalid-archive-reason"],
		[{ node: { id: "old", path: "One.md", order: 2 }, reason: "deleted", archivedAt: -1 }, "invalid-archived-at"],
		[{ node: { id: "old", path: "One.md", order: 2 }, reason: "deleted", archivedAt: 1.5 }, "invalid-archived-at"],
		[{ node: { id: "old", path: "One.md", order: 2 }, reason: "deleted", archivedAt: Number.MAX_SAFE_INTEGER + 1 }, "invalid-archived-at"],
		[{ node: { id: "old", path: "One.md", order: 2 }, reason: "deleted", archivedAt: Number.NaN }, "invalid-archived-at"],
	])("rejects the entire state for invalid historical record %j", (record, code) => {
		const state = { ...historyState(), orderHistory: { old: record } };
		const result = decodeTreeState(state);
		expect(result.valid).toBe(false);
		expect(result.state).toBeNull();
		expect(result.issues.map((issue) => issue.code)).toContain(code);
	});

	it("rejects invalid historical IDs rather than dropping their records", () => {
		const state = historyState();
		state.orderHistory = {
			"not valid": { node: { id: "not valid", path: "Old.md", order: 2 }, reason: "deleted", archivedAt: 100 },
		};
		const result = decodeTreeState(state);
		expect(result.state).toBeNull();
		expect(result.issues.map((issue) => issue.code)).toContain("invalid-node-id");
	});

	it("rejects unknown future schema without modifying the input", () => {
		const future = { ...historyState(), schemaVersion: 4, futureField: "preserve" };
		const before = structuredClone(future);
		const result = decodeTreeState(future);
		expect(result.state).toBeNull();
		expect(result.issues.map((issue) => issue.code)).toContain("unsupported-schema-version");
		expect(future).toEqual(before);
	});
});

function historyState(): TreeState {
	return {
		...createEmptyTreeState(),
		nodes: { one: { id: "one", path: "One.md", order: 7 } },
		orderHistory: {
			old: { node: { id: "old", path: "One.md", order: 2 }, reason: "deleted", archivedAt: 100 },
		},
	};
}
