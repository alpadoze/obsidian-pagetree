import { describe, expect, it } from "vitest";
import { pageTitleToPath } from "../src/core/page-title";

describe("pageTitleToPath", () => {
	it("creates a root-level Markdown path and avoids a doubled extension", () => {
		expect(pageTitleToPath("  Project plan  ")).toEqual({
			valid: true,
			title: "Project plan",
			path: "Project plan.md",
		});
		expect(pageTitleToPath("Project.md")).toEqual({
			valid: true,
			title: "Project",
			path: "Project.md",
		});
	});

	it.each([
		["   ", "empty"],
		["Bad/name", "invalid-character"],
		["Bad:name", "invalid-character"],
		["Trailing.", "trailing-character"],
		["CON", "reserved-name"],
	])("rejects unsafe cross-platform page title %s", (title, code) => {
		expect(pageTitleToPath(title)).toEqual({ valid: false, code });
	});
});
