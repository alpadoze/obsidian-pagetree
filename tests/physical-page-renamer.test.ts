import { describe, expect, it } from "vitest";
import {
	PhysicalPageRenameError,
	PhysicalPageRenamer,
	type PhysicalPageRenamePlan,
} from "../src/core/physical-page-renamer";
import type {
	PhysicalEntryKind,
	PhysicalPageMoveAdapter,
} from "../src/core/physical-page-mover";

describe("PhysicalPageRenamer", () => {
	it("renames a leaf page in place", async () => {
		const adapter = new MemoryRenameAdapter({ "Old.md": "file" });
		const renamer = new PhysicalPageRenamer(adapter);

		const result = await renamer.renamePage("Old.md", "Renamed", async () => undefined);

		expect(result.renamed).toBe(true);
		expect(result.plan.targetPagePath).toBe("Renamed.md");
		expect(adapter.snapshot()).toEqual({ "Renamed.md": "file" });
	});

	it("renames a parent page together with its paired folder and descendants", async () => {
		const adapter = new MemoryRenameAdapter({
			"Branch.md": "file",
			Branch: "folder",
			"Branch/Child.md": "file",
		});
		const renamer = new PhysicalPageRenamer(adapter);

		await renamer.renamePage("Branch.md", "Renamed.md", async () => undefined);

		expect(adapter.snapshot()).toEqual({
			Renamed: "folder",
			"Renamed.md": "file",
			"Renamed/Child.md": "file",
		});
	});

	it("rejects unsafe titles and target collisions before changing the filesystem", async () => {
		const adapter = new MemoryRenameAdapter({
			"Old.md": "file",
			"Taken.md": "file",
		});
		const renamer = new PhysicalPageRenamer(adapter);

		await expect(renamer.renamePage("Old.md", "Bad/name", async () => undefined))
			.rejects.toMatchObject({ code: "invalid-target-title" });
		await expect(renamer.renamePage("Old.md", "Taken", async () => undefined))
			.rejects.toMatchObject({ code: "target-page-exists" });
		expect(adapter.operations).toEqual([]);
	});

	it("rolls the paired folder back if renaming the Markdown file fails", async () => {
		const adapter = new MemoryRenameAdapter({
			"Branch.md": "file",
			Branch: "folder",
			"Branch/Child.md": "file",
		});
		adapter.failNextMove("Branch.md", "Renamed.md");
		const before = adapter.snapshot();
		const renamer = new PhysicalPageRenamer(adapter);

		await expect(renamer.renamePage("Branch.md", "Renamed", async () => undefined))
			.rejects.toMatchObject({ code: "physical-rename-failed" });
		expect(adapter.snapshot()).toEqual(before);
		expect(adapter.operations).toContainEqual(["move", "Renamed", "Branch"]);
	});

	it("rolls the Markdown file and paired folder back if metadata persistence fails", async () => {
		const adapter = new MemoryRenameAdapter({
			"Branch.md": "file",
			Branch: "folder",
			"Branch/Child.md": "file",
		});
		const before = adapter.snapshot();
		const renamer = new PhysicalPageRenamer(adapter);

		await expect(renamer.renamePage("Branch.md", "Renamed", async () => {
			throw new Error("disk full");
		})).rejects.toMatchObject({ code: "metadata-commit-failed" });
		expect(adapter.snapshot()).toEqual(before);
	});

	it("passes the complete rename plan to metadata persistence", async () => {
		const adapter = new MemoryRenameAdapter({
			"Area/Branch.md": "file",
			"Area/Branch": "folder",
		});
		const renamer = new PhysicalPageRenamer(adapter);
		let committedPlan: PhysicalPageRenamePlan | null = null;

		await renamer.renamePage("Area/Branch.md", "Renamed", async (plan) => {
			committedPlan = plan;
		});

		expect(committedPlan).toMatchObject({
			sourcePagePath: "Area/Branch.md",
			targetPagePath: "Area/Renamed.md",
			sourceFolderPath: "Area/Branch",
			targetFolderPath: "Area/Renamed",
			hasSourceFolder: true,
		});
	});

	it("finishes a native title rename by moving the paired folder and committing metadata", async () => {
		const adapter = new MemoryRenameAdapter({
			"Renamed.md": "file",
			Branch: "folder",
			"Branch/Child.md": "file",
		});
		const renamer = new PhysicalPageRenamer(adapter);
		let committedPlan: PhysicalPageRenamePlan | null = null;

		await renamer.synchronizeExternalRename("Branch.md", "Renamed.md", async (plan) => {
			committedPlan = plan;
		});

		expect(adapter.snapshot()).toEqual({
			Renamed: "folder",
			"Renamed.md": "file",
			"Renamed/Child.md": "file",
		});
		expect(committedPlan).toMatchObject({
			sourcePagePath: "Branch.md",
			targetPagePath: "Renamed.md",
			hasSourceFolder: true,
		});
	});

	it("commits a native leaf title rename without requiring a paired folder", async () => {
		const adapter = new MemoryRenameAdapter({ "Renamed.md": "file" });
		const renamer = new PhysicalPageRenamer(adapter);
		let committed = false;

		await renamer.synchronizeExternalRename("Leaf.md", "Renamed.md", async () => {
			committed = true;
		});

		expect(committed).toBe(true);
		expect(adapter.snapshot()).toEqual({ "Renamed.md": "file" });
	});

	it("restores the native page title if the paired target folder conflicts", async () => {
		const adapter = new MemoryRenameAdapter({
			"Renamed.md": "file",
			Branch: "folder",
			Renamed: "folder",
		});
		const renamer = new PhysicalPageRenamer(adapter);

		await expect(renamer.synchronizeExternalRename("Branch.md", "Renamed.md", async () => undefined))
			.rejects.toMatchObject({ code: "target-folder-exists" });
		expect(adapter.snapshot()).toEqual({
			"Branch.md": "file",
			Branch: "folder",
			Renamed: "folder",
		});
	});

	it("restores the native page title and paired folder if metadata persistence fails", async () => {
		const adapter = new MemoryRenameAdapter({
			"Renamed.md": "file",
			Branch: "folder",
			"Branch/Child.md": "file",
		});
		const renamer = new PhysicalPageRenamer(adapter);

		await expect(renamer.synchronizeExternalRename("Branch.md", "Renamed.md", async () => {
			throw new Error("disk full");
		})).rejects.toMatchObject({ code: "metadata-commit-failed" });
		expect(adapter.snapshot()).toEqual({
			"Branch.md": "file",
			Branch: "folder",
			"Branch/Child.md": "file",
		});
	});
});

class MemoryRenameAdapter implements PhysicalPageMoveAdapter {
	readonly operations: Array<["move", string, string]> = [];
	private readonly entries = new Map<string, PhysicalEntryKind>();
	private nextMoveFailure: { sourcePath: string; targetPath: string } | null = null;

	constructor(entries: Record<string, PhysicalEntryKind>) {
		for (const [path, kind] of Object.entries(entries)) this.entries.set(path, kind);
	}

	getEntryKind(path: string): PhysicalEntryKind | null {
		return this.entries.get(path) ?? null;
	}

	async createFolder(): Promise<void> {
		throw new Error("Rename tests do not create folders.");
	}

	async move(sourcePath: string, targetPath: string): Promise<void> {
		this.operations.push(["move", sourcePath, targetPath]);
		if (
			this.nextMoveFailure?.sourcePath === sourcePath
			&& this.nextMoveFailure.targetPath === targetPath
		) {
			this.nextMoveFailure = null;
			throw new Error("Injected move failure");
		}
		const kind = this.entries.get(sourcePath);
		if (!kind) throw new Error(`Missing source: ${sourcePath}`);
		if (this.entries.has(targetPath)) throw new Error(`Entry exists: ${targetPath}`);

		const movedEntries = [...this.entries.entries()].filter(([path]) => (
			path === sourcePath || path.startsWith(`${sourcePath}/`)
		));
		for (const [path] of movedEntries) this.entries.delete(path);
		for (const [path, entryKind] of movedEntries) {
			this.entries.set(`${targetPath}${path.slice(sourcePath.length)}`, entryKind);
		}
	}

	failNextMove(sourcePath: string, targetPath: string): void {
		this.nextMoveFailure = { sourcePath, targetPath };
	}

	snapshot(): Record<string, PhysicalEntryKind> {
		return Object.fromEntries([...this.entries.entries()].sort(([a], [b]) => a.localeCompare(b)));
	}
}
