import { describe, expect, it } from "vitest";
import { INITIAL_PAGE_CONTENT } from "../src/core/page-content";

describe("initial page content", () => {
	it("keeps newly created and repaired Markdown pages non-empty", () => {
		expect(INITIAL_PAGE_CONTENT).toBe("\n");
		expect(new TextEncoder().encode(INITIAL_PAGE_CONTENT).byteLength).toBeGreaterThan(0);
	});
});
