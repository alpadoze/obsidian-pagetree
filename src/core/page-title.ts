export type PageTitleErrorCode =
	| "empty"
	| "invalid-character"
	| "trailing-character"
	| "reserved-name"
	| "too-long";

export interface ValidPageTitle {
	valid: true;
	title: string;
	path: string;
}

export interface InvalidPageTitle {
	valid: false;
	code: PageTitleErrorCode;
}

export type PageTitleResult = ValidPageTitle | InvalidPageTitle;

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const INVALID_FILE_CHARACTER = /[<>:"/\\|?*\u0000-\u001F]/;

export function pageTitleToPath(input: string): PageTitleResult {
	let title = input.trim().normalize("NFC");
	if (title.toLowerCase().endsWith(".md")) title = title.slice(0, -3).trimEnd();

	if (title.length === 0) return { valid: false, code: "empty" };
	if (title.length > 180) return { valid: false, code: "too-long" };
	if (INVALID_FILE_CHARACTER.test(title)) return { valid: false, code: "invalid-character" };
	if (title.endsWith(".") || title.endsWith(" ")) return { valid: false, code: "trailing-character" };
	if (WINDOWS_RESERVED_NAME.test(title)) return { valid: false, code: "reserved-name" };

	return { valid: true, title, path: `${title}.md` };
}
