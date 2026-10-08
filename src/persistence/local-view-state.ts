import { canonicalVaultPath, type TreeState } from "../core/tree-state";

export const LOCAL_VIEW_STATE_KEY = "page-tree:view-state";
export const LEGACY_LOCAL_VIEW_STATE_KEY = "page-arbor:view-state";

export interface LocalViewStateStorage {
	load(): unknown;
	loadLegacy?(): unknown;
	save(value: unknown): void;
}

interface LocalViewStateDocument {
	version: 1;
	collapsedPaths: string[];
}

/** Device- and vault-local presentation state; never creates ordering metadata. */
export class LocalViewState {
	private collapsedPaths = new Set<string>();
	readonly loadError: unknown;

	constructor(private readonly storage: LocalViewStateStorage, legacyState: TreeState) {
		try {
			const raw = storage.load();
			if (raw === null || raw === undefined) {
				// Prefer the previous plugin's device-local state over shared legacy IDs.
				// Keep the old key untouched and never overwrite an existing new record.
				const legacyLocal = storage.loadLegacy?.();
				if (legacyLocal !== null && legacyLocal !== undefined) {
					if (!isLocalViewStateDocument(legacyLocal)) return;
					this.collapsedPaths = new Set(legacyLocal.collapsedPaths.map(canonicalVaultPath));
				} else {
					// Import once without rewriting shared metadata or normalizing its order.
					this.collapsedPaths = new Set(legacyState.collapsedNodeIds.flatMap((id) => {
						const node = legacyState.nodes[id];
						return node ? [canonicalVaultPath(node.path)] : [];
					}));
				}
				this.persist(this.collapsedPaths);
			} else if (isLocalViewStateDocument(raw)) {
				this.collapsedPaths = new Set(raw.collapsedPaths.map(canonicalVaultPath));
			}
			// Invalid local data is not overwritten on load or replaced by stale shared data.
		} catch (error) {
			// Local-storage failure must not prevent access to the physical page tree.
			this.loadError = error;
		}
	}

	isCollapsed(path: string): boolean {
		return this.collapsedPaths.has(canonicalVaultPath(path));
	}

	setCollapsed(path: string, collapsed: boolean): void {
		const next = new Set(this.collapsedPaths);
		if (collapsed) next.add(canonicalVaultPath(path));
		else next.delete(canonicalVaultPath(path));
		this.persist(next);
	}

	renamePath(oldPath: string, newPath: string, isFolder: boolean): void {
		const oldKey = canonicalVaultPath(oldPath);
		const newKey = canonicalVaultPath(newPath);
		const next = new Set([...this.collapsedPaths].map((path) => {
			if (!isFolder && path === oldKey) return newKey;
			if (isFolder && path.startsWith(`${oldKey}/`)) {
				return `${newKey}${path.slice(oldKey.length)}`;
			}
			return path;
		}));
		if (!samePaths(this.collapsedPaths, next)) this.persist(next);
	}

	removePath(path: string, isFolder: boolean): void {
		const key = canonicalVaultPath(path);
		const next = new Set([...this.collapsedPaths].filter((candidate) => (
			isFolder ? !candidate.startsWith(`${key}/`) : candidate !== key
		)));
		if (!samePaths(this.collapsedPaths, next)) this.persist(next);
	}

	private persist(paths: Set<string>): void {
		this.storage.save({ version: 1, collapsedPaths: [...paths].sort() });
		this.collapsedPaths = paths;
	}
}

function isLocalViewStateDocument(value: unknown): value is LocalViewStateDocument {
	if (typeof value !== "object" || value === null) return false;
	const document = value as Partial<LocalViewStateDocument>;
	return document.version === 1 && Array.isArray(document.collapsedPaths)
		&& document.collapsedPaths.every((path) => typeof path === "string" && path.length > 0);
}

function samePaths(left: Set<string>, right: Set<string>): boolean {
	return left.size === right.size && [...left].every((path) => right.has(path));
}
