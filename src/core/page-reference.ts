import { pageFolderPath } from "./page-path";

export type PageReferenceScope = "page" | "subtree";

export interface PageSubtreeReferenceLabels {
	rootPage: string;
	childPages: string;
}

export type PageReferencePathResolver = (vaultPath: string) => string;

export function formatPageReference(
	pagePath: string,
	scope: PageReferenceScope,
	resolvePath: PageReferencePathResolver,
	labels: PageSubtreeReferenceLabels,
): string {
	const resolvedPagePath = resolvePath(pagePath);
	if (scope === "page") return resolvedPagePath;

	return [
		`${labels.rootPage}: ${resolvedPagePath}`,
		`${labels.childPages}: ${resolvePath(pageFolderPath(pagePath))}`,
	].join("\n");
}
