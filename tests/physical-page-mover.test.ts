import { describe, expect, it } from "vitest";
import {
	PhysicalPageMoveError,
	PhysicalPageMover,
	type PhysicalEntryKind,
	type PhysicalPageMoveAdapter,
} from "../src/core/physical-page-mover";

describe("PhysicalPageMover", () => {
	it("moves a leaf page below another page and creates its child folder", async () => {
		const adapter = new MemoryMoveAdapter({
			"Leaf.md": "file",
			"Parent.md": "file",
		});
		const mover = new PhysicalPageMover(adapter);

		const result = await mover.movePage("Leaf.md", "Parent.md", async () => undefined);

		expect(result.moved).toBe(true);
		expect(result.plan.targetPagePath).toBe("Parent/Leaf.md");
		expect(adapter.snapshot()).toEqual({
			Parent: "folder",
			"Parent.md": "file",
			"Parent/Leaf.md": "file",
		});
	});

	it("moves a parent page together with its paired folder and descendants", async () => {
		const adapter = new MemoryMoveAdapter({
			"Branch.md": "file",
			Branch: "folder",
			"Branch/Child.md": "file",
			"Target.md": "file",
		});
		const mover = new PhysicalPageMover(adapter);

		await mover.movePage("Branch.md", "Target.md", async () => undefined);

		expect(adapter.snapshot()).toEqual({
			Target: "folder",
			"Target.md": "file",
			"Target/Branch": "folder",
			"Target/Branch.md": "file",
			"Target/Branch/Child.md": "file",
		});
	});

	it("rejects collisions before changing the filesystem", async () => {
		const adapter = new MemoryMoveAdapter({
			"Leaf.md": "file",
			"Parent.md": "file",
			Parent: "folder",
			"Parent/Leaf.md": "file",
		});
		const mover = new PhysicalPageMover(adapter);

		await expect(mover.movePage("Leaf.md", "Parent.md", async () => undefined))
			.rejects.toMatchObject({ code: "target-page-exists" });
		expect(adapter.operations).toEqual([]);
	});

	it("rejects moving a page below its own descendant", async () => {
		const adapter = new MemoryMoveAdapter({
			"Branch.md": "file",
			Branch: "folder",
			"Branch/Child.md": "file",
		});
		const mover = new PhysicalPageMover(adapter);

		await expect(mover.movePage("Branch.md", "Branch/Child.md", async () => undefined))
			.rejects.toMatchObject({ code: "would-create-cycle" });
		expect(adapter.operations).toEqual([]);
	});

	it("rolls the paired folder back if moving the Markdown file fails", async () => {
		const adapter = new MemoryMoveAdapter({
			"Branch.md": "file",
			Branch: "folder",
			"Branch/Child.md": "file",
			"Target.md": "file",
		});
		adapter.failNextMove("Branch.md", "Target/Branch.md");
		const before = adapter.snapshot();
		const mover = new PhysicalPageMover(adapter);

		await expect(mover.movePage("Branch.md", "Target.md", async () => undefined))
			.rejects.toMatchObject({ code: "physical-move-failed" });
		expect(adapter.snapshot()).toEqual({ ...before, Target: "folder" });
		expect(adapter.operations).toContainEqual(["move", "Target/Branch", "Branch"]);
	});

	it("rolls the Markdown file and paired folder back if metadata persistence fails", async () => {
		const adapter = new MemoryMoveAdapter({
			"Branch.md": "file",
			Branch: "folder",
			"Branch/Child.md": "file",
			"Target.md": "file",
		});
		const before = adapter.snapshot();
		const mover = new PhysicalPageMover(adapter);

		await expect(mover.movePage("Branch.md", "Target.md", async () => {
			throw new Error("disk full");
		})).rejects.toMatchObject({ code: "metadata-commit-failed" });
		expect(adapter.snapshot()).toEqual({ ...before, Target: "folder" });
	});
});

class MemoryMoveAdapter implements PhysicalPageMoveAdapter {
	readonly operations: Array<["createFolder", string] | ["move", string, string]> = [];
	private readonly entries = new Map<string, PhysicalEntryKind>();
	private nextMoveFailure: { sourcePath: string; targetPath: string } | null = null;

	constructor(entries: Record<string, PhysicalEntryKind>) {
		for (const [path, kind] of Object.entries(entries)) this.entries.set(path, kind);
	}

	getEntryKind(path: string): PhysicalEntryKind | null {
		return this.entries.get(path) ?? null;
	}

	async createFolder(path: string): Promise<void> {
		this.operations.push(["createFolder", path]);
		if (this.entries.has(path)) throw new Error(`Entry exists: ${path}`);
		this.entries.set(path, "folder");
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
