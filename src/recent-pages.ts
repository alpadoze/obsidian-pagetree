import { setIcon, setTooltip, type TFile } from "obsidian";
import type { PageTreeTranslations } from "./i18n";

/** A read-only projection of file timestamps; never changes page-tree order. */
export function renderRecentPages(
	container: HTMLElement,
	files: readonly TFile[],
	activePath: string | undefined,
	strings: PageTreeTranslations,
	openPage: (file: TFile) => void,
): void {
	const sorted = [...files].sort((left, right) => (
		right.stat.mtime - left.stat.mtime || left.path.localeCompare(right.path)
	));
	for (const file of sorted) {
		const active = file.path === activePath;
		const row = container.createDiv({
			cls: `page-tree-recent-row${active ? " is-active" : ""}`,
			attr: { role: "listitem", "data-page-path": file.path },
		});
		const button = row.createEl("button", {
			cls: "page-tree-recent-item",
			attr: { "data-page-path": file.path },
		});
		button.type = "button";
		setTooltip(button, file.path);
		if (active) button.setAttribute("aria-current", "page");
		const icon = button.createSpan({ cls: "page-tree-page-icon", attr: { "aria-hidden": "true" } });
		setIcon(icon, "file-text");
		const body = button.createSpan({ cls: "page-tree-recent-body" });
		body.createSpan({ cls: "page-tree-recent-title", text: file.basename });
		const details = body.createSpan({ cls: "page-tree-recent-details" });
		const parentPath = file.path.slice(0, Math.max(0, file.path.lastIndexOf("/")));
		const location = details.createSpan({
			cls: "page-tree-recent-path", text: parentPath || strings.view.vaultRoot,
		});
		setTooltip(location, parentPath || strings.view.vaultRoot);
		const modified = new Date(file.stat.mtime);
		if (Number.isFinite(modified.getTime())) {
			const label = strings.view.formatModifiedTime(modified);
			const time = details.createEl("time", {
				cls: "page-tree-recent-time", text: label,
				attr: { datetime: modified.toISOString() },
			});
			setTooltip(time, strings.view.modifiedAt(modified.toLocaleString()));
		}
		button.addEventListener("click", () => openPage(file));
	}
}
