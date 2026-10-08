import { describe, expect, it } from "vitest";
import { isPageEffectivelyCollapsed } from "../src/core/tree-visibility";

describe("page tree visibility", () => {
	it("lets an explicit collapse override the active-page auto reveal", () => {
		expect(isPageEffectivelyCollapsed(false, false, false)).toBe(false);
		expect(isPageEffectivelyCollapsed(true, false, false)).toBe(true);
		expect(isPageEffectivelyCollapsed(true, true, false)).toBe(false);
		expect(isPageEffectivelyCollapsed(true, true, true)).toBe(true);
	});
});
