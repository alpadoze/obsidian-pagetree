import { describe, expect, it } from "vitest";
import { VaultPathTracker } from "../src/core/vault-path-tracker";

describe("VaultPathTracker", () => {
	it("captures an untracked page rename before the live file object changes again", () => {
		const tracker = new VaultPathTracker();
		tracker.reset(["A.md", "B.md", "C.md"]);
		const first = tracker.rename("B.md", "Z.md", false);
		tracker.rename("Z.md", "Y.md", false);
		expect(first.before).toEqual(["A.md", "B.md", "C.md"]);
		expect(first.changes).toEqual([{ from: "B.md", to: "Z.md" }]);
		expect(first.after).toContain("Z.md");
		expect(first.after).not.toContain("Y.md");
	});

	it("handles a folder event and duplicate descendant events only once", () => {
		const tracker = new VaultPathTracker();
		tracker.reset(["Parent.md", "Parent/A.md", "Parent/A/B.md", "Parents/C.md"]);
		const folder = tracker.rename("Parent", "Moved", true);
		expect(folder.changes).toEqual([
			{ from: "Parent/A.md", to: "Moved/A.md" },
			{ from: "Parent/A/B.md", to: "Moved/A/B.md" },
		]);
		expect(tracker.rename("Parent/A.md", "Moved/A.md", false).changes).toEqual([]);
		expect(tracker.snapshot()).toContain("Parent.md");
		expect(tracker.snapshot()).toContain("Parents/C.md");
	});

	it("does not treat deletion plus creation as a rename", () => {
		const tracker = new VaultPathTracker();
		tracker.reset(["Old.md"]);
		expect(tracker.delete("Old.md", false).removed).toEqual(["Old.md"]);
		const created = tracker.create("New.md");
		expect(created.added).toEqual(["New.md"]);
		expect(created.changes).toEqual([]);
		expect(tracker.delete("Old.md", false).removed).toEqual([]);
	});

	it("remaps Unicode-normalized folder names without slicing the child name", () => {
		const tracker = new VaultPathTracker();
		tracker.reset(["Cafe\u0301/Child.md"]);
		expect(tracker.rename("Café", "Archive", true).changes).toEqual([
			{ from: "Cafe\u0301/Child.md", to: "Archive/Child.md" },
		]);
	});

	it("filters hidden and non-Markdown files and handles extension changes", () => {
		const tracker = new VaultPathTracker();
		tracker.reset(["A.md", ".trash/X.md", "asset.png"]);
		expect(tracker.snapshot()).toEqual(["A.md"]);
		expect(tracker.rename("A.md", "A.txt", false).removed).toEqual(["A.md"]);
		expect(tracker.rename("A.txt", "A.md", false).added).toEqual(["A.md"]);
		expect(tracker.create("A.md").added).toEqual([]);
	});
});
