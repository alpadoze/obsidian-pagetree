import { canonicalVaultPath } from "./tree-state";

export function pageFolderPath(pagePath: string): string {
	return pagePath.toLowerCase().endsWith(".md") ? pagePath.slice(0, -3) : pagePath;
}

export function pageFilename(pagePath: string): string {
	return pagePath.split("/").pop() ?? pagePath;
}

export function physicalParentPagePath(pagePath: string): string | null {
	const separatorIndex = pagePath.lastIndexOf("/");
	if (separatorIndex < 0) return null;
	return `${pagePath.slice(0, separatorIndex)}.md`;
}

export function childPagePath(parentPagePath: string, childFilename: string): string {
	return `${pageFolderPath(parentPagePath)}/${childFilename}`;
}

export function nextUntitledPagePath(
	parentPagePath: string | null,
	occupiedPaths: Iterable<string>,
): string {
	const occupied = new Set([...occupiedPaths].map(canonicalVaultPath));
	for (let suffix = 0; suffix <= occupied.size; suffix += 1) {
		const filename = suffix === 0 ? "Untitled.md" : `Untitled ${suffix}.md`;
		const candidate = parentPagePath === null
			? filename
			: childPagePath(parentPagePath, filename);
		if (!occupied.has(canonicalVaultPath(candidate))) return candidate;
	}

	throw new Error("Unable to allocate an untitled page path.");
}

export function movedPagePath(pagePath: string, targetParentPagePath: string | null): string {
	const filename = pageFilename(pagePath);
	return targetParentPagePath === null
		? filename
		: childPagePath(targetParentPagePath, filename);
}

export function renamedPagePath(pagePath: string, targetFilename: string): string {
	const separatorIndex = pagePath.lastIndexOf("/");
	return separatorIndex < 0
		? targetFilename
		: `${pagePath.slice(0, separatorIndex + 1)}${targetFilename}`;
}

export function isPageInsideSubtree(candidatePath: string, ancestorPagePath: string): boolean {
	const candidate = canonicalVaultPath(candidatePath);
	const descendantPrefix = `${canonicalVaultPath(pageFolderPath(ancestorPagePath))}/`;
	return candidate.startsWith(descendantPrefix);
}

export function canMovePageUnder(sourcePagePath: string, targetParentPagePath: string): boolean {
	if (
		canonicalVaultPath(sourcePagePath)
		=== canonicalVaultPath(targetParentPagePath)
	) {
		return false;
	}
	return !isPageInsideSubtree(targetParentPagePath, sourcePagePath);
}

export function replaceSubtreePath(
	path: string,
	oldRootPagePath: string,
	newRootPagePath: string,
): string {
	if (canonicalVaultPath(path) === canonicalVaultPath(oldRootPagePath)) return newRootPagePath;

	const oldFolder = pageFolderPath(oldRootPagePath);
	const newFolder = pageFolderPath(newRootPagePath);
	const oldPrefix = `${oldFolder}/`;
	if (!canonicalVaultPath(path).startsWith(canonicalVaultPath(oldPrefix))) return path;
	return `${newFolder}/${path.slice(oldPrefix.length)}`;
}
