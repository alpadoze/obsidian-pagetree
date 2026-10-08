import { describe, expect, it } from "vitest";
import {
	PhysicalPageDeleter,
	type PhysicalPageDeleteAdapter,
} from "../src/core/physical-page-deleter";
import type { PhysicalEntryKind } from "../src/core/physical-page-mover";

describe("PhysicalPageDeleter", () => {
	it("trashes a page and its complete paired folder", async () => {
		const adapter = new MemoryDeleteAdapter({
			"Branch.md": "file",
			Branch: "folder",
			"Branch/Child.md": "file",
			"Branch/asset.png": "file",
		});
		const deleter = new PhysicalPageDeleter(adapter);

		const result = await deleter.deletePage("Branch.md", async () => undefined);

		expect(result.plan).toEqual({
			sourcePagePath: "Branch.md",
			sourceFolderPath: "Branch",
			hasSourceFolder: true,
		});
		expect(adapter.snapshot()).toEqual({});
		expect(adapter.operations).toEqual([
			["trash", "Branch.md"],
			["trash", "Branch"],
		]);
	});

	it("trashes a leaf page without requiring a paired folder", async () => {
		const adapter = new MemoryDeleteAdapter({ "Leaf.md": "file" });
		const deleter = new PhysicalPageDeleter(adapter);

		await deleter.deletePage("Leaf.md", async () => undefined);

		expect(adapter.snapshot()).toEqual({});
		expect(adapter.operations).toEqual([["trash", "Leaf.md"]]);
	});

	it("rejects a paired path blocked by a file before deleting the page", async () => {
		const adapter = new MemoryDeleteAdapter({
			"Branch.md": "file",
			Branch: "file",
		});
		const deleter = new PhysicalPageDeleter(adapter);

		await expect(deleter.deletePage("Branch.md", async () => undefined))
			.rejects.toMatchObject({ code: "source-folder-blocked" });
		expect(adapter.operations).toEqual([]);
	});

	it("keeps the paired subtree when the page cannot enter the recycle bin", async () => {
		const entries = {
			"Branch.md": "file" as const,
			Branch: "folder" as const,
			"Branch/Child.md": "file" as const,
		};
		const adapter = new MemoryDeleteAdapter(entries);
		adapter.failNextTrash("Branch.md");
		const deleter = new PhysicalPageDeleter(adapter);

		await expect(deleter.deletePage("Branch.md", async () => undefined))
			.rejects.toMatchObject({ code: "trash-failed" });
		expect(adapter.snapshot()).toEqual(entries);
	});

	it("reports a partial deletion if the paired subtree cannot be trashed", async () => {
		const adapter = new MemoryDeleteAdapter({
			"Branch.md": "file",
			Branch: "folder",
			"Branch/Child.md": "file",
		});
		adapter.failNextTrash("Branch");
		const deleter = new PhysicalPageDeleter(adapter);

		await expect(deleter.deletePage("Branch.md", async () => undefined))
			.rejects.toMatchObject({ code: "partial-trash-failed" });
		expect(adapter.snapshot()).toEqual({
			Branch: "folder",
			"Branch/Child.md": "file",
		});
	});

	it("reports metadata failure after the physical deletion completes", async () => {
		const adapter = new MemoryDeleteAdapter({ "Leaf.md": "file" });
		const deleter = new PhysicalPageDeleter(adapter);

		await expect(deleter.deletePage("Leaf.md", async () => {
			throw new Error("disk full");
		})).rejects.toMatchObject({ code: "metadata-commit-failed" });
		expect(adapter.snapshot()).toEqual({});
	});
});

class MemoryDeleteAdapter implements PhysicalPageDeleteAdapter {
	readonly operations: Array<["move", string, string] | ["trash", string]> = [];
	private readonly entries = new Map<string, PhysicalEntryKind>();
	private nextTrashFailure: string | null = null;

	constructor(entries: Record<string, PhysicalEntryKind>) {
		for (const [path, kind] of Object.entries(entries)) this.entries.set(path, kind);
	}

	getEntryKind(path: string): PhysicalEntryKind | null {
		return this.entries.get(path) ?? null;
	}

	async createFolder(path: string): Promise<void> {
		if (this.entries.has(path)) throw new Error(`Entry exists: ${path}`);
		this.entries.set(path, "folder");
	}

	async move(sourcePath: string, targetPath: string): Promise<void> {
		this.operations.push(["move", sourcePath, targetPath]);
		throw new Error("Delete flow must not move pages.");
	}

	async trash(path: string): Promise<void> {
		this.operations.push(["trash", path]);
		if (this.nextTrashFailure === path) {
			this.nextTrashFailure = null;
			throw new Error("Injected trash failure");
		}
		if (!this.entries.has(path)) throw new Error(`Missing source: ${path}`);
		for (const entryPath of [...this.entries.keys()]) {
			if (entryPath === path || entryPath.startsWith(`${path}/`)) this.entries.delete(entryPath);
		}
	}

	failNextTrash(path: string): void {
		this.nextTrashFailure = path;
	}

	snapshot(): Record<string, PhysicalEntryKind> {
		return Object.fromEntries([...this.entries.entries()].sort(([a], [b]) => a.localeCompare(b)));
	}
}
