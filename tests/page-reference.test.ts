import { describe, expect, it } from "vitest";
import { formatPageReference } from "../src/core/page-reference";

const ENGLISH_LABELS = {
	rootPage: "Root page",
	childPages: "Child pages",
};

describe("PageTree references for AI", () => {
	it("copies a page as a plain resolved absolute Markdown path", () => {
		expect(formatPageReference(
			"Research/Model notes.md",
			"page",
			(path) => `C:\\Vault\\${path.replaceAll("/", "\\")}`,
			ENGLISH_LABELS,
		)).toBe("C:\\Vault\\Research\\Model notes.md");
	});

	it("includes both the parent Markdown and paired folder for a subtree", () => {
		expect(formatPageReference(
			"Research/Model notes.md",
			"subtree",
			(path) => `/vault/${path}`,
			ENGLISH_LABELS,
		)).toBe([
			"Root page: /vault/Research/Model notes.md",
			"Child pages: /vault/Research/Model notes",
		].join("\n"));
	});

	it("uses the supplied desktop resolver for both subtree paths", () => {
		const resolveWindowsPath = (path: string): string => (
			`G:\\Knowledge Vault\\${path.replaceAll("/", "\\")}`
		);

		expect(formatPageReference(
			"Research/Model notes.md",
			"subtree",
			resolveWindowsPath,
			ENGLISH_LABELS,
		)).toBe([
			"Root page: G:\\Knowledge Vault\\Research\\Model notes.md",
			"Child pages: G:\\Knowledge Vault\\Research\\Model notes",
		].join("\n"));
	});

	it("preserves Unicode and localizes subtree labels", () => {
		expect(formatPageReference(
			"深度学习/数学语言描述任务.md",
			"subtree",
			(path) => `/Users/example/Vault/${path}`,
			{ rootPage: "根页面", childPages: "子页面目录" },
		)).toBe([
			"根页面: /Users/example/Vault/深度学习/数学语言描述任务.md",
			"子页面目录: /Users/example/Vault/深度学习/数学语言描述任务",
		].join("\n"));
	});
});
