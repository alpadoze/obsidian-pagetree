import { projectTree, type ProjectedTreeNode } from "./tree-projection";
import { canonicalVaultPath, generateNodeId, type TreeState } from "./tree-state";
import type { TreeStore } from "./tree-store";

// Not a hidden folder: ordinary vault sync can carry these JSON files on mobile.
export const SHARED_ORDER_FOLDER = "_pagetree";
export const SHARED_ORDER_FORMAT = "page-tree-order-v1";

export interface SharedOrderGroup {
	parent: string | null;
	paths: string[];
}

export interface SharedOrderDocument {
	format: typeof SHARED_ORDER_FORMAT;
	id: string;
	clock: number;
	groups: SharedOrderGroup[];
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function sharedOrderPath(id: string): string {
	if (!uuidPattern.test(id)) throw new Error("Invalid shared order ID.");
	return `${SHARED_ORDER_FOLDER}/order-${id}.json`;
}

export function isSharedOrderPath(path: string): boolean {
	return path.startsWith(`${SHARED_ORDER_FOLDER}/order-`) && path.endsWith(".json");
}

export function decodeSharedOrder(value: unknown): SharedOrderDocument {
	if (!isRecord(value) || value.format !== SHARED_ORDER_FORMAT
		|| typeof value.id !== "string" || !uuidPattern.test(value.id)
		|| typeof value.clock !== "number" || !Number.isSafeInteger(value.clock)
		|| value.clock < 1 || value.clock >= Number.MAX_SAFE_INTEGER
		|| !Array.isArray(value.groups) || value.groups.length === 0) {
		throw new Error("Invalid or unsupported shared order document.");
	}
	const parents = new Set<string>();
	const groups: SharedOrderGroup[] = [];
	for (const raw of value.groups as unknown[]) {
		if (!isRecord(raw) || !(raw.parent === null || isPagePath(raw.parent))
			|| !Array.isArray(raw.paths) || !raw.paths.every(isPagePath)) {
			throw new Error("Invalid shared sibling order.");
		}
		const parent = raw.parent;
		const paths = raw.paths;
		const key = groupKey(parent);
		if (parents.has(key) || new Set(paths.map(canonicalVaultPath)).size !== paths.length) {
			throw new Error("Duplicate shared order paths.");
		}
		parents.add(key);
		groups.push({ parent, paths: [...paths] });
	}
	return { format: SHARED_ORDER_FORMAT, id: value.id, clock: value.clock, groups };
}

/** Per-sibling-group last-writer register. Logical clocks avoid device clock skew. */
export function mergeSharedOrders(documents: Iterable<SharedOrderDocument>): SharedOrderGroup[] {
	const winners = new Map<string, { document: SharedOrderDocument; group: SharedOrderGroup }>();
	for (const document of documents) {
		for (const group of document.groups) {
			const key = groupKey(group.parent);
			const previous = winners.get(key)?.document;
			if (!previous || document.clock > previous.clock
				|| (document.clock === previous.clock && document.id > previous.id)) {
				winners.set(key, { document, group });
			}
		}
	}
	return [...winners.entries()].sort(([a], [b]) => compareKeys(a, b))
		.map(([, { group }]) => ({ parent: group.parent, paths: [...group.paths] }));
}

export function captureOrderGroups(state: TreeState, paths: string[]): SharedOrderGroup[] {
	const groups: SharedOrderGroup[] = [];
	const visit = (siblings: ProjectedTreeNode[], parent: string | null): void => {
		groups.push({ parent, paths: siblings.map((node) => node.path) });
		for (const node of siblings) if (node.children.length > 0) visit(node.children, node.path);
	};
	visit(projectTree(state, paths).roots, null);
	return groups;
}

export function changedOrderGroups(before: SharedOrderGroup[], after: SharedOrderGroup[]): SharedOrderGroup[] {
	const previous = new Map(before.map((group) => [groupKey(group.parent), group]));
	const next = new Map(after.map((group) => [groupKey(group.parent), group]));
	const changes = after.filter((group) => !samePaths(previous.get(groupKey(group.parent))?.paths, group.paths));
	for (const [key, group] of previous) {
		if (!next.has(key)) changes.push({ parent: group.parent, paths: [] });
	}
	return changes;
}

/** Receiving order never changes files, settings, fold state, or archived records. */
export function applySharedOrder(tree: TreeStore, paths: string[], groups: SharedOrderGroup[]): void {
	if (groups.length === 0) return;
	const shared = new Map(groups.map((group) => [groupKey(group.parent), group]));
	const state = tree.getState();
	const existing = new Map(Object.values(state.nodes).map((node) => [canonicalVaultPath(node.path), node]));
	let changed = false;
	for (const visible of captureOrderGroups(state, paths)) {
		const order = shared.get(groupKey(visible.parent));
		if (!order) continue;
		const ranks = new Map(order.paths.map((path, index) => [canonicalVaultPath(path), index]));
		const sorted = [...visible.paths].sort((a, b) => {
			const left = canonicalVaultPath(a);
			const right = canonicalVaultPath(b);
			return (ranks.get(left) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(right) ?? Number.MAX_SAFE_INTEGER)
				|| compareKeys(left, right);
		});
		for (const [index, path] of sorted.entries()) {
			let node = existing.get(canonicalVaultPath(path));
			if (!node) {
				let id = generateNodeId();
				while (Object.prototype.hasOwnProperty.call(state.nodes, id)
					|| Object.prototype.hasOwnProperty.call(state.orderHistory, id)) id = generateNodeId();
				node = { id, path, order: index };
				state.nodes[id] = node;
				existing.set(canonicalVaultPath(path), node);
				changed = true;
			}
			if (node.order !== index) {
				node.order = index;
				changed = true;
			}
		}
	}
	if (changed) {
		state.revision += 1;
		tree.replaceState(state);
	}
}

/** Remap only explicit rename events, including records for not-yet-downloaded pages. */
export function remapSharedOrderGroups(
	groups: SharedOrderGroup[],
	changes: Array<{ from: string; to: string }>,
): SharedOrderGroup[] {
	const mapping = new Map(changes.map(({ from, to }) => [canonicalVaultPath(from), to]));
	const remap = (path: string): string => mapping.get(canonicalVaultPath(path)) ?? path;
	const next = new Map(groups.map((group) => [groupKey(group.parent), group]));
	for (const group of groups) {
		// Empty old-parent tombstones must never replace an already renamed group on replay.
		if (group.paths.length === 0) continue;
		const parent = group.parent === null ? null : remap(group.parent);
		const paths = [...new Map(group.paths.map((path) => {
			const mapped = remap(path);
			return [canonicalVaultPath(mapped), mapped];
		})).values()];
		if (groupKey(parent) === groupKey(group.parent) && samePaths(group.paths, paths)) continue;
		if (groupKey(parent) !== groupKey(group.parent)) next.set(groupKey(group.parent), { parent: group.parent, paths: [] });
		next.set(groupKey(parent), { parent, paths });
	}
	return changedOrderGroups(groups, [...next.values()]);
}

function groupKey(parent: string | null): string {
	return parent === null ? "" : canonicalVaultPath(parent);
}

function samePaths(left: string[] | undefined, right: string[]): boolean {
	return left !== undefined && left.length === right.length
		&& left.every((path, index) => canonicalVaultPath(path) === canonicalVaultPath(right[index]!));
}

function compareKeys(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isPagePath(value: unknown): value is string {
	return typeof value === "string" && value.toLowerCase().endsWith(".md")
		&& !value.includes("\\") && !value.includes(":")
		&& ![...value].some((character) => character.charCodeAt(0) < 32)
		&& value.split("/").every((part) => part.length > 0 && !part.startsWith("."));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
