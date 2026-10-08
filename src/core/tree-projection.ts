import { physicalParentPagePath } from "./page-path";
import { canonicalVaultPath, type NodeId, type TreeState } from "./tree-state";

export interface ProjectedTreeNode {
	id: NodeId | null;
	path: string;
	children: ProjectedTreeNode[];
}

export interface TreeProjection {
	roots: ProjectedTreeNode[];
	metadataMissingPaths: string[];
	missingNodeIds: NodeId[];
	pageCount: number;
}

interface ProjectionEntry {
	id: NodeId | null;
	path: string;
	order: number | null;
}

export function projectTree(state: TreeState, availablePaths: string[]): TreeProjection {
	const availableByCanonicalPath = new Map<string, string>();
	for (const path of availablePaths) {
		availableByCanonicalPath.set(canonicalVaultPath(path), path);
	}

	const metadataByCanonicalPath = new Map(
		Object.values(state.nodes).map((node) => [canonicalVaultPath(node.path), node] as const),
	);
	const missingNodeIds = Object.values(state.nodes)
		.filter((node) => !availableByCanonicalPath.has(canonicalVaultPath(node.path)))
		.map((node) => node.id)
		.sort();
	const metadataMissingPaths: string[] = [];
	const entriesByCanonicalPath = new Map<string, ProjectionEntry>();

	for (const [canonicalPath, path] of availableByCanonicalPath) {
		const metadata = metadataByCanonicalPath.get(canonicalPath);
		if (!metadata) metadataMissingPaths.push(path);
		entriesByCanonicalPath.set(canonicalPath, {
			id: metadata?.id ?? null,
			path,
			order: metadata?.order ?? null,
		});
	}

	const childrenByParentPath = new Map<string | null, ProjectionEntry[]>();
	for (const entry of entriesByCanonicalPath.values()) {
		const candidateParentPath = physicalParentPagePath(entry.path);
		const canonicalParentPath = candidateParentPath === null
			? null
			: canonicalVaultPath(candidateParentPath);
		const parentKey = canonicalParentPath !== null && entriesByCanonicalPath.has(canonicalParentPath)
			? canonicalParentPath
			: null;
		const siblings = childrenByParentPath.get(parentKey) ?? [];
		siblings.push(entry);
		childrenByParentPath.set(parentKey, siblings);
	}

	for (const siblings of childrenByParentPath.values()) {
		siblings.sort(compareProjectionEntries);
	}

	const buildBranch = (entry: ProjectionEntry): ProjectedTreeNode => ({
		id: entry.id,
		path: entry.path,
		children: (childrenByParentPath.get(canonicalVaultPath(entry.path)) ?? []).map(buildBranch),
	});

	metadataMissingPaths.sort((a, b) => a.localeCompare(b));
	return {
		roots: (childrenByParentPath.get(null) ?? []).map(buildBranch),
		metadataMissingPaths,
		missingNodeIds,
		pageCount: entriesByCanonicalPath.size,
	};
}

function compareProjectionEntries(left: ProjectionEntry, right: ProjectionEntry): number {
	if (left.order !== null && right.order !== null) {
		return left.order - right.order || left.path.localeCompare(right.path);
	}
	if (left.order !== null) return -1;
	if (right.order !== null) return 1;
	return left.path.localeCompare(right.path);
}
