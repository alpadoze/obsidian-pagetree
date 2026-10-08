import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCAL_VIEW_STATE_KEY } from "../src/persistence/local-view-state";
import { PAGE_TREE_DATA_FORMAT } from "../src/persistence/tree-repository";

describe("PageTree identity", () => {
	it("uses the new identity for installation, packaging, and new storage", () => {
		const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
		const license = readFileSync(new URL("../LICENSE", import.meta.url), "utf8");
		expect(manifest.name).toBe("PageTree");
		expect(manifest.author).toBe("alpadoze");
		expect(manifest.authorUrl).toBe("https://github.com/alpadoze");
		expect(pkg.author).toBe(manifest.author);
		expect(license).toMatch(/Copyright \(c\) \d{4} alpadoze/);
		expect(manifest.id).toBe("page-tree");
		expect(pkg.name).toBe(manifest.id);
		expect(lock.name).toBe(manifest.id);
		expect(lock.packages[""].name).toBe(manifest.id);
		expect(LOCAL_VIEW_STATE_KEY).toBe("page-tree:view-state");
		expect(PAGE_TREE_DATA_FORMAT).toBe("page-tree-v3");
	});

	it("registers only PageTree command, view, drag, and styling identifiers", () => {
		const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
		const view = readFileSync(new URL("../src/page-tree-view.ts", import.meta.url), "utf8");
		const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
		for (const command of ["open-page-tree", "reload-page-tree", "validate-page-tree"]) {
			expect(main).toContain(`id: "${command}"`);
		}
		expect(view).toContain('VIEW_TYPE_PAGE_TREE = "page-tree-view"');
		expect(view).toContain('"application/x-page-tree-path"');
		expect(styles).toContain(".page-tree-view");
		for (const source of [main, view, styles]) {
			expect(source).not.toMatch(/page-arbor|PageArbor|PAGE_ARBOR|pageArbor/);
		}
	});
});
