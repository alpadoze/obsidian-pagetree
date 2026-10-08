export const CURRENT_TREE_SCHEMA_VERSION = 3 as const;

export type NodeId = string;

export interface TreeNode {
	id: NodeId;
	path: string;
	order: number;
}

export interface ArchivedOrderRecord {
	node: TreeNode;
	reason: "deleted" | "missing";
	archivedAt: number;
}

export interface TreeSettings {
	showFilePath: boolean;
}

export interface TreeState {
	schemaVersion: typeof CURRENT_TREE_SCHEMA_VERSION;
	revision: number;
	nodes: Record<NodeId, TreeNode>;
	orderHistory: Record<NodeId, ArchivedOrderRecord>;
	/** Legacy schema-v2 data, read only for the first device-local view-state migration. */
	collapsedNodeIds: NodeId[];
	settings: TreeSettings;
}

export function createEmptyTreeState(): TreeState {
	return {
		schemaVersion: CURRENT_TREE_SCHEMA_VERSION,
		revision: 0,
		nodes: {},
		orderHistory: {},
		collapsedNodeIds: [],
		settings: {
			showFilePath: false,
		},
	};
}

export function cloneTreeState(state: TreeState): TreeState {
	const nodes: Record<NodeId, TreeNode> = {};
	for (const [nodeId, node] of Object.entries(state.nodes)) {
		nodes[nodeId] = { ...node };
	}
	const orderHistory: Record<NodeId, ArchivedOrderRecord> = {};
	for (const [nodeId, record] of Object.entries(state.orderHistory)) {
		orderHistory[nodeId] = { ...record, node: { ...record.node } };
	}

	return {
		schemaVersion: state.schemaVersion,
		revision: state.revision,
		nodes,
		orderHistory,
		collapsedNodeIds: [...state.collapsedNodeIds],
		settings: { ...state.settings },
	};
}

export function canonicalVaultPath(path: string): string {
	return path.normalize("NFC").toLowerCase();
}

export function generateNodeId(): NodeId {
	if (typeof globalThis.crypto?.randomUUID !== "function") {
		throw new Error("This environment does not provide crypto.randomUUID().");
	}

	return globalThis.crypto.randomUUID();
}
