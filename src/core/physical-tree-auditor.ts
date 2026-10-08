import { pageFolderPath } from "./page-path";
import { canonicalVaultPath, type NodeId, type TreeState } from "./tree-state";

export type PhysicalTreeEntryKind = "file" | "folder";

export interface PhysicalTreeEntry {
	path: string;
	kind: PhysicalTreeEntryKind;
}

export interface PhysicalTreePathConflict {
	type: "page-body-blocked" | "paired-folder-blocked";
	path: string;
	relatedPath: string;
}

export interface PhysicalTreeAudit {
	missingPageBodyPaths: string[];
	missingMetadataPaths: string[];
	staleMetadataNodes: Array<{ id: NodeId; path: string }>;
	orderHistoryRecords: Array<{
		id: NodeId;
		path: string;
		reason: "deleted" | "missing";
		archivedAt: number;
		canRestore: boolean;
		restoreBlockedReason: "missing-file" | "active-record" | null;
	}>;
	conflicts: PhysicalTreePathConflict[];
	issueCount: number;
	repairableIssueCount: number;
}

export function auditPhysicalTree(
	entries: PhysicalTreeEntry[],
	state: TreeState,
): PhysicalTreeAudit {
	const relevantEntries = entries.filter((entry) => !isIgnoredVaultPath(entry.path));
	const entryByCanonicalPath = new Map(
		relevantEntries.map((entry) => [canonicalVaultPath(entry.path), entry] as const),
	);
	const markdownPaths = relevantEntries
		.filter((entry) => entry.kind === "file" && entry.path.toLowerCase().endsWith(".md"))
		.map((entry) => entry.path)
		.sort(comparePaths);
	const markdownByCanonicalPath = new Map(
		markdownPaths.map((path) => [canonicalVaultPath(path), path] as const),
	);

	const missingPageBodyPaths: string[] = [];
	const conflicts: PhysicalTreePathConflict[] = [];
	for (const folder of relevantEntries.filter((entry) => entry.kind === "folder")) {
		const folderPrefix = `${canonicalVaultPath(folder.path)}/`;
		if (!markdownPaths.some((path) => canonicalVaultPath(path).startsWith(folderPrefix))) continue;

		const pagePath = `${folder.path}.md`;
		const pageEntry = entryByCanonicalPath.get(canonicalVaultPath(pagePath));
		if (pageEntry === undefined) {
			missingPageBodyPaths.push(pagePath);
		} else if (pageEntry.kind !== "file") {
			conflicts.push({
				type: "page-body-blocked",
				path: pagePath,
				relatedPath: folder.path,
			});
		}
	}

	for (const markdownPath of markdownPaths) {
		const pairedFolderPath = pageFolderPath(markdownPath);
		const pairedEntry = entryByCanonicalPath.get(canonicalVaultPath(pairedFolderPath));
		if (pairedEntry?.kind === "file") {
			conflicts.push({
				type: "paired-folder-blocked",
				path: pairedFolderPath,
				relatedPath: markdownPath,
			});
		}
	}

	const metadataByCanonicalPath = new Map(
		Object.values(state.nodes).map((node) => [canonicalVaultPath(node.path), node] as const),
	);
	const missingMetadataPaths = markdownPaths
		.filter((path) => !metadataByCanonicalPath.has(canonicalVaultPath(path)));
	const staleMetadataNodes = Object.values(state.nodes)
		.filter((node) => !markdownByCanonicalPath.has(canonicalVaultPath(node.path)))
		.map((node) => ({ id: node.id, path: node.path }))
		.sort((left, right) => comparePaths(left.path, right.path));
	const orderHistoryRecords = Object.entries(state.orderHistory)
		.map(([id, record]) => {
			const pathKey = canonicalVaultPath(record.node.path);
			const restoreBlockedReason = metadataByCanonicalPath.has(pathKey) || state.nodes[id] !== undefined
				? "active-record" as const
				: record.reason !== "missing" && !markdownByCanonicalPath.has(pathKey)
					? "missing-file" as const
					: null;
			return {
				id,
				path: record.node.path,
				reason: record.reason,
				archivedAt: record.archivedAt,
				canRestore: restoreBlockedReason === null,
				restoreBlockedReason,
			};
		})
		.sort((left, right) => right.archivedAt - left.archivedAt || comparePaths(left.path, right.path));

	missingPageBodyPaths.sort(comparePaths);
	conflicts.sort((left, right) => comparePaths(left.path, right.path));
	const repairableIssueCount = missingPageBodyPaths.length
		+ staleMetadataNodes.length;

	return {
		missingPageBodyPaths,
		missingMetadataPaths,
		staleMetadataNodes,
		orderHistoryRecords,
		conflicts,
		issueCount: repairableIssueCount + conflicts.length,
		repairableIssueCount,
	};
}

function isIgnoredVaultPath(path: string): boolean {
	return path.split("/").some((segment) => segment.startsWith("."));
}

function comparePaths(left: string, right: string): number {
	const depthDifference = left.split("/").length - right.split("/").length;
	return depthDifference || left.localeCompare(right);
}
