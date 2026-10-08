import { describe, expect, it } from "vitest";
import {
	canMovePageUnder,
	childPagePath,
	isPageInsideSubtree,
	movedPagePath,
	nextUntitledPagePath,
	pageFolderPath,
	physicalParentPagePath,
	renamedPagePath,
	replaceSubtreePath,
} from "../src/core/page-path";

describe("physical page paths", () => {
	it("pairs a Markdown page with its same-name child folder", () => {
		expect(pageFolderPath("Project.md")).toBe("Project");
		expect(childPagePath("Project.md", "Requirements.md")).toBe("Project/Requirements.md");
		expect(physicalParentPagePath("Project/Requirements.md")).toBe("Project.md");
		expect(physicalParentPagePath("Project.md")).toBeNull();
	});

	it("moves and rewrites an entire physical page subtree", () => {
		expect(movedPagePath("One/Two.md", "Three.md")).toBe("Three/Two.md");
		expect(renamedPagePath("One/Two.md", "Renamed.md")).toBe("One/Renamed.md");
		expect(renamedPagePath("Two.md", "Renamed.md")).toBe("Renamed.md");
		expect(isPageInsideSubtree("One/Two/Detail.md", "One/Two.md")).toBe(true);
		expect(replaceSubtreePath(
			"One/Two/Detail.md",
			"One/Two.md",
			"Three/Two.md",
		)).toBe("Three/Two/Detail.md");
	});

	it("rejects mobile move targets inside the source subtree", () => {
		expect(canMovePageUnder("Project.md", "Archive.md")).toBe(true);
		expect(canMovePageUnder("Project.md", "Project.md")).toBe(false);
		expect(canMovePageUnder("Project.md", "Project/Child.md")).toBe(false);
		expect(canMovePageUnder("Project/Child.md", "Project.md")).toBe(true);
	});

	it("allocates a unique untitled name within the selected physical parent", () => {
		const occupied = [
			"Untitled.md",
			"Untitled 1.md",
			"Project/Untitled.md",
		];

		expect(nextUntitledPagePath(null, occupied)).toBe("Untitled 2.md");
		expect(nextUntitledPagePath("Project.md", occupied)).toBe("Project/Untitled 1.md");
		expect(nextUntitledPagePath("Other.md", occupied)).toBe("Other/Untitled.md");
	});
});
