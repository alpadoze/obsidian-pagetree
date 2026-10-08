import {
	canonicalVaultPath,
	cloneTreeState,
	generateNodeId,
	type NodeId,
	type TreeNode,
	type TreeSettings,
	type TreeState,
} from "./tree-state";
import {
	isPageInsideSubtree,
	movedPagePath,
	physicalParentPagePath,
	replaceSubtreePath,
} from "./page-path";
import {
	validateTreeState,
	type TreeValidationIssue,
} from "./tree-validator";

export type TreeOperationErrorCode =
	| "node-not-found"
	| "parent-not-found"
	| "duplicate-node-id"
	| "duplicate-path"
	| "invalid-index"
	| "would-create-cycle";

export class TreeOperationError extends Error {
	constructor(
		public readonly code: TreeOperationErrorCode,
		message: string,
	) {
		super(message);
		this.name = "TreeOperationError";
	}
}

export class TreeValidationError extends Error {
	constructor(public readonly issues: TreeValidationIssue[]) {
		super(issues.map((issue) => issue.message).join("\n"));
		this.name = "TreeValidationError";
	}
}

export interface AddNodeInput {
	path: string;
	index?: number;
	id?: NodeId;
}

export interface TreeStoreOptions {
	idGenerator?: () => NodeId;
}

export class TreeStore {
	private state: TreeState;
	private readonly idGenerator: () => NodeId;

	constructor(initialState: TreeState, options: TreeStoreOptions = {}) {
		assertValidState(initialState);
		this.state = cloneTreeState(initialState);
		this.idGenerator = options.idGenerator ?? generateNodeId;
	}

	getState(): TreeState {
		return cloneTreeState(this.state);
	}

	replaceState(state: TreeState): void {
		assertValidState(state);
		this.state = cloneTreeState(state);
	}

	getNode(nodeId: NodeId): TreeNode | null {
		const node = this.state.nodes[nodeId];
		return node ? { ...node } : null;
	}

	findNodeByPath(path: string): TreeNode | null {
		const node = findNodeByPath(this.state, path);
		return node ? { ...node } : null;
	}

	getChildren(parentId: NodeId | null): TreeNode[] {
		return getSiblingIds(this.state, parentId).map((nodeId) => ({ ...this.state.nodes[nodeId]! }));
	}

	addNode(input: AddNodeInput): NodeId {
		const nodeId = input.id ?? this.idGenerator();

		this.commit((candidate) => {
			if (candidate.nodes[nodeId] !== undefined) {
				throw new TreeOperationError("duplicate-node-id", `Node ${nodeId} already exists.`);
			}
			assertPathAvailable(candidate, input.path);

			candidate.nodes[nodeId] = {
				id: nodeId,
				path: input.path,
				order: Number.MAX_SAFE_INTEGER,
			};
			const parentId = getParentNodeId(candidate, candidate.nodes[nodeId]);
			const siblingIds = getSiblingIds(candidate, parentId).filter((id) => id !== nodeId);
			const insertionIndex = resolveInsertionIndex(input.index, siblingIds.length);
			siblingIds.splice(insertionIndex, 0, nodeId);
			assignSiblingOrders(candidate, siblingIds);
		});

		return nodeId;
	}

	moveNode(nodeId: NodeId, parentId: NodeId | null, index?: number): void {
		this.commit((candidate) => {
			const node = requireNode(candidate, nodeId);
			const parent = parentId === null ? null : requireParentNode(candidate, parentId);
			if (
				parentId === nodeId
				|| (parent !== null && isPageInsideSubtree(parent.path, node.path))
			) {
				throw new TreeOperationError(
					"would-create-cycle",
					`Moving node ${nodeId} below ${parentId ?? "root"} would create a cycle.`,
				);
			}

			const oldParentId = getParentNodeId(candidate, node);
			const oldPath = node.path;
			const newPath = movedPagePath(oldPath, parent?.path ?? null);
			const subtreeIds = getSubtreeIds(candidate, oldPath);
			assertSubtreePathsAvailable(candidate, subtreeIds, oldPath, newPath);

			for (const subtreeId of subtreeIds) {
				const subtreeNode = candidate.nodes[subtreeId]!;
				subtreeNode.path = replaceSubtreePath(subtreeNode.path, oldPath, newPath);
			}

			const oldSiblingIds = getSiblingIds(candidate, oldParentId).filter((id) => id !== nodeId);
			assignSiblingOrders(candidate, oldSiblingIds);
			const targetSiblingIds = getSiblingIds(candidate, parentId).filter((id) => id !== nodeId);
			const insertionIndex = resolveInsertionIndex(index, targetSiblingIds.length);
			targetSiblingIds.splice(insertionIndex, 0, nodeId);
			assignSiblingOrders(candidate, targetSiblingIds);
		});
	}

	reorderNode(nodeId: NodeId, index: number): void {
		const node = requireNode(this.state, nodeId);
		this.moveNode(nodeId, getParentNodeId(this.state, node), index);
	}

	removeNode(nodeId: NodeId): void {
		this.commit((candidate) => {
			requireNode(candidate, nodeId);
			delete candidate.nodes[nodeId];
			candidate.collapsedNodeIds = candidate.collapsedNodeIds.filter((id) => id !== nodeId);
		});
	}

	updatePath(nodeId: NodeId, path: string): void {
		this.commit((candidate) => {
			const node = requireNode(candidate, nodeId);
			const oldPath = node.path;
			const subtreeIds = getSubtreeIds(candidate, oldPath);
			assertSubtreePathsAvailable(candidate, subtreeIds, oldPath, path);
			for (const subtreeId of subtreeIds) {
				const subtreeNode = candidate.nodes[subtreeId]!;
				subtreeNode.path = replaceSubtreePath(subtreeNode.path, oldPath, path);
			}
		});
	}

	/** @deprecated Legacy schema support. Runtime UI state belongs to LocalViewState. */
	setCollapsed(nodeId: NodeId, collapsed: boolean): void {
		this.commit((candidate) => {
			requireNode(candidate, nodeId);
			const collapsedIds = new Set(candidate.collapsedNodeIds);
			if (collapsed) collapsedIds.add(nodeId);
			else collapsedIds.delete(nodeId);
			candidate.collapsedNodeIds = [...collapsedIds];
		});
	}

	updateSettings(settings: Partial<TreeSettings>): void {
		this.commit((candidate) => {
			candidate.settings = { ...candidate.settings, ...settings };
		});
	}

	private commit(mutate: (candidate: TreeState) => void): void {
		const candidate = cloneTreeState(this.state);
		mutate(candidate);
		normalizeAllSiblingOrders(candidate);
		candidate.revision = this.state.revision + 1;
		assertValidState(candidate);
		this.state = candidate;
	}
}

function assertValidState(state: TreeState): void {
	const validation = validateTreeState(state);
	if (!validation.valid) throw new TreeValidationError(validation.issues);
}

function requireNode(state: TreeState, nodeId: NodeId): TreeNode {
	const node = state.nodes[nodeId];
	if (!node) {
		throw new TreeOperationError("node-not-found", `Node ${nodeId} does not exist.`);
	}
	return node;
}

function requireParentNode(state: TreeState, parentId: NodeId): TreeNode {
	const parent = state.nodes[parentId];
	if (!parent) {
		throw new TreeOperationError("parent-not-found", `Parent node ${parentId} does not exist.`);
	}
	return parent;
}

function findNodeByPath(state: TreeState, path: string): TreeNode | null {
	const canonicalPath = canonicalVaultPath(path);
	return Object.values(state.nodes).find(
		(candidate) => canonicalVaultPath(candidate.path) === canonicalPath,
	) ?? null;
}

function getParentNodeId(state: TreeState, node: TreeNode): NodeId | null {
	const parentPath = physicalParentPagePath(node.path);
	return parentPath === null ? null : findNodeByPath(state, parentPath)?.id ?? null;
}

function assertPathAvailable(state: TreeState, path: string, exceptNodeIds: Set<NodeId> = new Set()): void {
	const canonicalPath = canonicalVaultPath(path);
	const duplicate = Object.values(state.nodes).find(
		(node) => !exceptNodeIds.has(node.id) && canonicalVaultPath(node.path) === canonicalPath,
	);
	if (duplicate) {
		throw new TreeOperationError(
			"duplicate-path",
			`Path ${path} is already assigned to node ${duplicate.id}.`,
		);
	}
}

function assertSubtreePathsAvailable(
	state: TreeState,
	subtreeIds: NodeId[],
	oldRootPath: string,
	newRootPath: string,
): void {
	const subtreeIdSet = new Set(subtreeIds);
	for (const subtreeId of subtreeIds) {
		const node = state.nodes[subtreeId]!;
		assertPathAvailable(
			state,
			replaceSubtreePath(node.path, oldRootPath, newRootPath),
			subtreeIdSet,
		);
	}
}

function getSubtreeIds(state: TreeState, rootPath: string): NodeId[] {
	return Object.values(state.nodes)
		.filter((node) => (
			canonicalVaultPath(node.path) === canonicalVaultPath(rootPath)
			|| isPageInsideSubtree(node.path, rootPath)
		))
		.map((node) => node.id);
}

function getSiblingIds(state: TreeState, parentId: NodeId | null): NodeId[] {
	return Object.values(state.nodes)
		.filter((node) => getParentNodeId(state, node) === parentId)
		.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path))
		.map((node) => node.id);
}

function assignSiblingOrders(state: TreeState, siblingIds: NodeId[]): void {
	siblingIds.forEach((nodeId, order) => {
		state.nodes[nodeId]!.order = order;
	});
}

function normalizeAllSiblingOrders(state: TreeState): void {
	const parentIds = new Set<NodeId | null>([null]);
	for (const node of Object.values(state.nodes)) {
		parentIds.add(getParentNodeId(state, node));
	}
	for (const parentId of parentIds) {
		assignSiblingOrders(state, getSiblingIds(state, parentId));
	}
}

function resolveInsertionIndex(index: number | undefined, siblingCount: number): number {
	if (index === undefined) return siblingCount;
	if (!Number.isSafeInteger(index) || index < 0 || index > siblingCount) {
		throw new TreeOperationError(
			"invalid-index",
			`Insertion index must be an integer between 0 and ${siblingCount}.`,
		);
	}
	return index;
}
