import { describe, expect, it } from "vitest";
import {
	auditPhysicalTree,
	type PhysicalTreeEntry,
} from "../src/core/physical-tree-auditor";
import { createEmptyTreeState } from "../src/core/tree-state";
import { TreeStore } from "../src/core/tree-store";

describe("auditPhysicalTree", () => {
	it("accepts a fully paired physical page tree with matching metadata", () => {
		const entries: PhysicalTreeEntry[] = [
			{ path: "Project.md", kind: "file" },
			{ path: "Project", kind: "folder" },
			{ path: "Project/Child.md", kind: "file" },
		];
		const store = new TreeStore(createEmptyTreeState());
		store.addNode({ id: "project", path: "Project.md" });
		store.addNode({ id: "child", path: "Project/Child.md" });

		expect(auditPhysicalTree(entries, store.getState())).toEqual({
			missingPageBodyPaths: [],
			missingMetadataPaths: [],
			staleMetadataNodes: [],
			orderHistoryRecords: [],
			conflicts: [],
			issueCount: 0,
			repairableIssueCount: 0,
		});
	});

	it("finds every missing parent page plus missing and extra metadata", () => {
		const entries: PhysicalTreeEntry[] = [
			{ path: "11", kind: "folder" },
			{ path: "11/A", kind: "folder" },
			{ path: "11/A/Child.md", kind: "file" },
		];
		const store = new TreeStore(createEmptyTreeState());
		store.addNode({ id: "stale", path: "Deleted.md" });

		const audit = auditPhysicalTree(entries, store.getState());

		expect(audit.missingPageBodyPaths).toEqual(["11.md", "11/A.md"]);
		expect(audit.missingMetadataPaths).toEqual(["11/A/Child.md"]);
		expect(audit.staleMetadataNodes).toEqual([{ id: "stale", path: "Deleted.md" }]);
		expect(audit.conflicts).toEqual([]);
		expect(audit.issueCount).toBe(3);
		expect(audit.repairableIssueCount).toBe(3);
	});

	it("treats pages without custom order metadata as normal pages, not repair issues", () => {
		const audit = auditPhysicalTree([
			{ path: "Project.md", kind: "file" },
			{ path: "Project", kind: "folder" },
			{ path: "Project/Child.md", kind: "file" },
		], createEmptyTreeState());

		expect(audit.missingMetadataPaths).toEqual(["Project.md", "Project/Child.md"]);
		expect(audit.issueCount).toBe(0);
		expect(audit.repairableIssueCount).toBe(0);
	});

	it("reports restorable history separately without counting it as a problem", () => {
		const state = createEmptyTreeState();
		state.orderHistory = {
			returning: {
				node: { id: "returning", path: "Returned.md", order: 2 },
				reason: "deleted",
				archivedAt: 100,
			},
			absent: {
				node: { id: "absent", path: "Absent.md", order: 0 },
				reason: "missing",
				archivedAt: 200,
			},
		};
		const audit = auditPhysicalTree([{ path: "RETURNED.md", kind: "file" }], state);

		expect(audit.orderHistoryRecords).toEqual([
			{ id: "absent", path: "Absent.md", reason: "missing", archivedAt: 200, canRestore: true, restoreBlockedReason: null },
			{ id: "returning", path: "Returned.md", reason: "deleted", archivedAt: 100, canRestore: true, restoreBlockedReason: null },
		]);
		expect(audit.issueCount).toBe(0);
		expect(audit.repairableIssueCount).toBe(0);
	});

	it("allows undoing cleanup without a file but cannot restore deleted-page order without its file", () => {
		const state = createEmptyTreeState();
		state.orderHistory = {
			cleaned: { node: { id: "cleaned", path: "Cleaned.md", order: 0 }, reason: "missing", archivedAt: 100 },
			deleted: { node: { id: "deleted", path: "Deleted.md", order: 1 }, reason: "deleted", archivedAt: 200 },
		};
		const audit = auditPhysicalTree([], state);

		expect(audit.orderHistoryRecords.find((record) => record.id === "cleaned")?.canRestore).toBe(true);
		expect(audit.orderHistoryRecords.find((record) => record.id === "deleted")?.restoreBlockedReason).toBe("missing-file");
		expect(audit.issueCount).toBe(0);
	});

	it("blocks history restoration when an active record owns the same path or ID", () => {
		const state = createEmptyTreeState();
		state.nodes = {
			current: { id: "current", path: "Claimed.md", order: 0 },
			shared: { id: "shared", path: "Other.md", order: 1 },
		};
		state.orderHistory = {
			old: { node: { id: "old", path: "CLAIMED.md", order: 2 }, reason: "missing", archivedAt: 100 },
			shared: { node: { id: "shared", path: "Returned.md", order: 3 }, reason: "deleted", archivedAt: 200 },
		};
		const audit = auditPhysicalTree([
			{ path: "Claimed.md", kind: "file" },
			{ path: "Other.md", kind: "file" },
			{ path: "Returned.md", kind: "file" },
		], state);

		expect(audit.orderHistoryRecords.every((record) => !record.canRestore && record.restoreBlockedReason === "active-record")).toBe(true);
		expect(audit.issueCount).toBe(0);
	});

	it("does not offer to restore history for a folder or an ignored hidden file", () => {
		const state = createEmptyTreeState();
		state.orderHistory = {
			folder: { node: { id: "folder", path: "Blocked.md", order: 0 }, reason: "deleted", archivedAt: 100 },
			hidden: { node: { id: "hidden", path: ".hidden/Note.md", order: 1 }, reason: "deleted", archivedAt: 200 },
		};
		const audit = auditPhysicalTree([
			{ path: "Blocked.md", kind: "folder" },
			{ path: ".hidden/Note.md", kind: "file" },
		], state);

		expect(audit.orderHistoryRecords.every((record) => record.restoreBlockedReason === "missing-file")).toBe(true);
		expect(audit.issueCount).toBe(0);
	});

	it("ignores hidden paths and folders that contain no Markdown descendants", () => {
		const entries: PhysicalTreeEntry[] = [
			{ path: ".obsidian", kind: "folder" },
			{ path: ".obsidian/Internal.md", kind: "file" },
			{ path: "assets", kind: "folder" },
			{ path: "assets/image.png", kind: "file" },
		];

		const audit = auditPhysicalTree(entries, createEmptyTreeState());

		expect(audit.issueCount).toBe(0);
	});

	it("reports blocking file and folder conflicts without marking them repairable", () => {
		const entries: PhysicalTreeEntry[] = [
			{ path: "Project.md", kind: "file" },
			{ path: "Project", kind: "file" },
			{ path: "Group", kind: "folder" },
			{ path: "Group.md", kind: "folder" },
			{ path: "Group/Child.md", kind: "file" },
		];
		const store = new TreeStore(createEmptyTreeState());
		store.addNode({ id: "project", path: "Project.md" });
		store.addNode({ id: "child", path: "Group/Child.md" });

		const audit = auditPhysicalTree(entries, store.getState());

		expect(audit.conflicts).toEqual([
			{
				type: "page-body-blocked",
				path: "Group.md",
				relatedPath: "Group",
			},
			{
				type: "paired-folder-blocked",
				path: "Project",
				relatedPath: "Project.md",
			},
		]);
		expect(audit.repairableIssueCount).toBe(0);
		expect(audit.issueCount).toBe(2);
	});
});
