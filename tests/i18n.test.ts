import { describe, expect, it } from "vitest";
import {
	getPageTreeTranslations,
	resolvePageTreeLanguage,
} from "../src/i18n";

describe("PageTree localization", () => {
	it.each(["en", "zh"])("uses the PageTree display name for language %s", (language) => {
		const strings = getPageTreeTranslations(language);
		expect(strings.commands.open).toContain("PageTree");
		expect(strings.view.treeLabel).toContain("PageTree");
		expect(strings.audit.summary(2)).toContain("PageTree");
		expect(strings.notices.deleteSuccess("Example")).toContain("PageTree");
		expect(JSON.stringify(strings)).not.toContain("PageArbor");
	});

	it.each(["zh", "zh-CN", "zh-TW", "ZH-hans"])(
		"uses Chinese for Obsidian language %s",
		(language) => {
			expect(resolvePageTreeLanguage(language)).toBe("zh-cn");
			expect(getPageTreeTranslations(language).view.checkTree).toBe("检查页面树");
		},
	);

	it.each(["en", "de", "fr", "", "unknown"])(
		"falls back to English for Obsidian language %s",
		(language) => {
			expect(resolvePageTreeLanguage(language)).toBe("en");
			expect(getPageTreeTranslations(language).view.checkTree).toBe("Check page tree");
		},
	);

	it("formats dynamic counts in each language", () => {
		expect(getPageTreeTranslations("en").view.pageCount(2)).toBe("2 pages");
		expect(getPageTreeTranslations("zh").view.pageCount(2)).toBe("2 个页面");
	});

	it("localizes touch movement actions", () => {
		expect(getPageTreeTranslations("en").movement.under).toBe("Move under…");
		expect(getPageTreeTranslations("zh").movement.under).toBe("移至页面下…");
	});

	it("localizes page and subtree copy actions", () => {
		expect(getPageTreeTranslations("en").copy.subtreeAbsolute)
			.toBe("Copy entire subtree absolute paths");
		expect(getPageTreeTranslations("zh").copy.pageAbsolute)
			.toBe("复制页面绝对路径");
	});

	it("keeps order maintenance and parent-page creation as separate localized actions", () => {
		const english = getPageTreeTranslations("en");
		const chinese = getPageTreeTranslations("zh");
		expect(english.audit.archiveOrder).toBe("Organize order records");
		expect(english.audit.createParents).toBe("Create missing parent pages");
		expect(chinese.audit.archiveOrder).toBe("整理排序记录");
		expect(chinese.audit.createParents).toBe("补建父页面");
		expect(english.audit.undoOrderCleanup).toBe("Undo cleanup");
		expect(chinese.audit.undoOrderCleanup).toBe("撤销整理");
		expect(chinese.audit.archiveOrderNote).toContain("不修改 Markdown 正文");
		expect(chinese.audit.createParentsNote).toContain("不整理排序记录");
		expect(english.audit.historyNote).toContain("does not create or restore page contents");
		expect(chinese.audit.historyNote).toContain("不会创建或恢复正文");
	});

	it("explains blocked history restoration and completed parent creation in each language", () => {
		const english = getPageTreeTranslations("en");
		const chinese = getPageTreeTranslations("zh");
		expect(english.audit.historyFileMissing).toContain("file is not currently present");
		expect(english.audit.historyActiveRecord).toContain("active order record");
		expect(chinese.audit.historyFileMissing).toContain("文件尚不存在");
		expect(chinese.audit.historyActiveRecord).toContain("占用该路径或记录 ID");
		expect(english.notices.parentPagesCreated(1)).toContain("1 empty parent page.");
		expect(chinese.notices.parentPagesCreated(2)).toContain("2 个空白父页面");
		expect(chinese.notices.orderHistorySaved).toContain("可恢复历史");
		expect(chinese.notices.orderHistoryRestoreBlocked).toContain("未恢复或覆盖正文");
	});
});
