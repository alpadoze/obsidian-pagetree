import { physicalParentPagePath } from "./page-path";
import { projectTree, type ProjectedTreeNode } from "./tree-projection";
import {
	canonicalVaultPath,
	generateNodeId,
	type TreeNode,
	type TreeState,
} from "./tree-state";
import type { TreeStore } from "./tree-store";

export interface OrderPathChange {
	from: string;
	to: string;
}

export interface OrderPlacement {
	path: string;
	targetPath: string;
	type: "before" | "after";
}

/** Capture the visible order only for an explicit ordering/file operation. */
export function registerVisibleOrder(tree: TreeStore, availablePaths: string[]): void {
	updateState(tree, (state) => registerOnState(state, availablePaths));
}

/** New pages go last in their visible sibling group; missing old records are retained. */
export function addPageOrder(tree: TreeStore, beforePaths: string[], newPath: string): void {
	const key = canonicalVaultPath(newPath);
	updateState(tree, (state) => {
		if (findNode(state, key)) return;
		const before = beforePaths.filter((path) => canonicalVaultPath(path) !== key);
		registerOnState(state, before);
		const after = [...before, newPath];
		const beforeKeys = new Set(before.map(canonicalVaultPath));
		const afterKeys = new Set(after.map(canonicalVaultPath));
		const parent = visibleParent(key, afterKeys);
		const siblingOrders = Object.values(state.nodes)
			.filter((node) => beforeKeys.has(canonicalVaultPath(node.path)))
			.filter((node) => visibleParent(canonicalVaultPath(node.path), afterKeys) === parent)
			.map((node) => node.order);
		const id = nextNodeId(state);
		state.nodes[id] = { id, path: newPath, order: siblingOrders.reduce((max, order) => Math.max(max, order), -1) + 1 };
	});
}

/** Apply only explicit, observed old/new paths. Never infer identity from contents or names. */
export function remapOrderPaths(
	tree: TreeStore,
	beforePaths: string[],
	changes: OrderPathChange[],
	afterPaths: string[],
	placement?: OrderPlacement,
): void {
	updateState(tree, (state) => {
		const before = pathMap(beforePaths);
		const after = pathMap(afterPaths);
		const initialNodes = nodeMap(state);
		const mapping = new Map<string, string>();
		const destinations = new Set<string>();
		for (const change of changes) {
			const from = canonicalVaultPath(change.from);
			const to = canonicalVaultPath(change.to);
			// Replayed events must not register an old path that is no longer present.
			if (!before.has(from) || !after.has(to)) continue;
			if (change.from === change.to) continue;
			if (!initialNodes.has(from) && initialNodes.has(to)) continue;
			if (mapping.has(from)) {
				if (canonicalVaultPath(mapping.get(from)!) !== to) throw new Error("Conflicting old page paths.");
				continue;
			}
			if (destinations.has(to)) throw new Error("Multiple pages cannot map to the same path.");
			mapping.set(from, after.get(to)!);
			destinations.add(to);
		}
		const canPlace = placement !== undefined
			&& before.has(canonicalVaultPath(placement.path))
			&& after.has(canonicalVaultPath(placement.path))
			&& after.has(canonicalVaultPath(placement.targetPath));
		// A moved page may use its new path in the explicit placement.
		const mappedPlacement = placement !== undefined
			&& destinations.has(canonicalVaultPath(placement.path))
			&& after.has(canonicalVaultPath(placement.targetPath));
		if (mapping.size === 0 && !canPlace && !mappedPlacement) return;

		for (const [from, target] of mapping) {
			const occupied = initialNodes.get(canonicalVaultPath(target));
			if (occupied && canonicalVaultPath(occupied.path) !== from
				&& !mapping.has(canonicalVaultPath(occupied.path))) {
				throw new Error("The destination already has another page's order record.");
			}
		}
		const oldPositions = visiblePositions(state, [...before.values()]);
		registerOnState(state, [...before.values()]);
		for (const node of Object.values(state.nodes)) {
			const target = mapping.get(canonicalVaultPath(node.path));
			if (target !== undefined) node.path = target;
		}

		const inverse = new Map([...mapping].map(([from, to]) => [canonicalVaultPath(to), from]));
		const afterKeys = new Set(after.keys());
		const mappedNodes = nodeMap(state);
		const groups = new Map<string | null, Array<{ node: TreeNode; moved: boolean; index: number }>>();
		for (const projected of flatten(projectTree(state, [...after.values()]).roots)) {
			const key = canonicalVaultPath(projected.path);
			const oldKey = inverse.get(key) ?? key;
			const old = oldPositions.get(oldKey);
			// An unrelated create/rename can occur while the caller awaits a file operation.
			// Its queued event owns that new path; do not invent an identity before it runs.
			if (!old) continue;
			const node = mappedNodes.get(key);
			if (!node) continue;
			const parent = visibleParent(key, afterKeys);
			const previousParent = old.parent === null
				? null
				: canonicalVaultPath(mapping.get(old.parent) ?? old.parent);
			const moved = previousParent !== parent;
			const siblings = groups.get(parent) ?? [];
			siblings.push({ node, moved, index: old.index });
			groups.set(parent, siblings);
		}
		for (const siblings of groups.values()) {
			siblings.sort((left, right) => Number(left.moved) - Number(right.moved) || left.index - right.index);
		}
		if (placement !== undefined && (canPlace || mappedPlacement)) {
			const sourceKey = canonicalVaultPath(placement.path);
			const targetKey = canonicalVaultPath(placement.targetPath);
			if (sourceKey !== targetKey) {
				const parent = visibleParent(sourceKey, afterKeys);
				if (parent !== visibleParent(targetKey, afterKeys)) {
					throw new Error("An order placement must reference visible siblings.");
				}
				const siblings = groups.get(parent)!;
				const sourceIndex = siblings.findIndex(({ node }) => canonicalVaultPath(node.path) === sourceKey);
				if (sourceIndex < 0 || !siblings.some(({ node }) => canonicalVaultPath(node.path) === targetKey)) {
					throw new Error("Order placement paths must belong to the operation's snapshot.");
				}
				const source = siblings.splice(sourceIndex, 1)[0]!;
				const targetIndex = siblings.findIndex(({ node }) => canonicalVaultPath(node.path) === targetKey);
				siblings.splice(targetIndex + (placement.type === "after" ? 1 : 0), 0, source);
			}
		}
		for (const siblings of groups.values()) {
			for (const [index, { node }] of siblings.entries()) node.order = index;
		}
	});
}

/** Retire only the named active records. This operation never creates or edits files. */
export function archiveOrderPaths(
	tree: TreeStore,
	paths: string[],
	reason: "deleted" | "missing",
	now = Date.now(),
): void {
	const keys = new Set(paths.map(canonicalVaultPath));
	updateState(tree, (state) => {
		for (const node of Object.values(state.nodes)) {
			if (!keys.has(canonicalVaultPath(node.path))) continue;
			if (!hasOwn(state.orderHistory, node.id)) {
				state.orderHistory[node.id] = { node: { ...node }, reason, archivedAt: now };
			}
			delete state.nodes[node.id];
			state.collapsedNodeIds = state.collapsedNodeIds.filter((id) => id !== node.id);
		}
	});
}

/** Undo missing-record cleanup, or restore deleted-page order if its file exists. Never replace a new ID. */
export function restoreOrderRecord(tree: TreeStore, id: string, availablePaths: string[]): boolean {
	let restored = false;
	updateState(tree, (state) => {
		if (!hasOwn(state.orderHistory, id) || hasOwn(state.nodes, id)) return;
		const record = state.orderHistory[id];
		if (!record) return;
		const key = canonicalVaultPath(record.node.path);
		if (findNode(state, key)) return;
		if (record.reason !== "missing" && !availablePaths.some((path) => canonicalVaultPath(path) === key)) return;
		state.nodes[id] = { ...record.node };
		delete state.orderHistory[id];
		restored = true;
	});
	return restored;
}

function registerOnState(state: TreeState, availablePaths: string[]): void {
	const nodes = nodeMap(state);
	const visit = (siblings: ProjectedTreeNode[]): void => {
		for (const [order, projected] of siblings.entries()) {
			const key = canonicalVaultPath(projected.path);
			let node = nodes.get(key);
			if (!node) {
				const id = nextNodeId(state);
				node = { id, path: projected.path, order };
				state.nodes[id] = node;
				nodes.set(key, node);
			}
			node.order = order;
			visit(projected.children);
		}
	};
	visit(projectTree(state, availablePaths).roots);
}

function visiblePositions(state: TreeState, paths: string[]): Map<string, { parent: string | null; index: number }> {
	const keys = new Set(paths.map(canonicalVaultPath));
	return new Map(flatten(projectTree(state, paths).roots).map((node, index) => {
		const key = canonicalVaultPath(node.path);
		return [key, { parent: visibleParent(key, keys), index }];
	}));
}

function flatten(nodes: ProjectedTreeNode[]): ProjectedTreeNode[] {
	return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function pathMap(paths: string[]): Map<string, string> {
	return new Map(paths.map((path) => [canonicalVaultPath(path), path]));
}

function visibleParent(key: string, available: Set<string>): string | null {
	const parent = physicalParentPagePath(key);
	return parent !== null && available.has(parent) ? parent : null;
}

function findNode(state: TreeState, key: string): TreeNode | undefined {
	return Object.values(state.nodes).find((node) => canonicalVaultPath(node.path) === key);
}

function nodeMap(state: TreeState): Map<string, TreeNode> {
	return new Map(Object.values(state.nodes).map((node) => [canonicalVaultPath(node.path), node]));
}

function nextNodeId(state: TreeState): string {
	let id = generateNodeId();
	while (hasOwn(state.nodes, id) || hasOwn(state.orderHistory, id)) id = generateNodeId();
	return id;
}

function hasOwn(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function updateState(tree: TreeStore, mutate: (state: TreeState) => void): void {
	const state = tree.getState();
	const before = JSON.stringify(state);
	mutate(state);
	if (JSON.stringify(state) === before) return;
	state.revision += 1;
	tree.replaceState(state);
}
