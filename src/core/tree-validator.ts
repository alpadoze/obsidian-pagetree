import {
	CURRENT_TREE_SCHEMA_VERSION,
	canonicalVaultPath,
	type ArchivedOrderRecord,
	type NodeId,
	type TreeNode,
	type TreeState,
} from "./tree-state";

export type TreeValidationCode =
	| "invalid-state"
	| "unsupported-schema-version"
	| "invalid-revision"
	| "invalid-nodes"
	| "invalid-node"
	| "invalid-node-id"
	| "node-id-mismatch"
	| "invalid-path"
	| "duplicate-path"
	| "invalid-order"
	| "invalid-order-history"
	| "invalid-archived-order"
	| "duplicate-history-node-id"
	| "invalid-archive-reason"
	| "invalid-archived-at"
	| "invalid-collapsed-nodes"
	| "invalid-collapsed-node"
	| "duplicate-collapsed-node"
	| "invalid-settings";

export interface TreeValidationIssue {
	code: TreeValidationCode;
	message: string;
	nodeId?: NodeId;
}

export interface TreeValidationResult {
	valid: boolean;
	issues: TreeValidationIssue[];
}

export interface TreeDecodeResult extends TreeValidationResult {
	state: TreeState | null;
}

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function validateTreeState(state: TreeState): TreeValidationResult {
	const issues: TreeValidationIssue[] = [];

	if (state.schemaVersion !== CURRENT_TREE_SCHEMA_VERSION) {
		issues.push({
			code: "unsupported-schema-version",
			message: `Expected schema version ${String(CURRENT_TREE_SCHEMA_VERSION)}, received ${String(state.schemaVersion)}.`,
		});
	}

	if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
		issues.push({
			code: "invalid-revision",
			message: "Revision must be a non-negative safe integer.",
		});
	}

	const nodeIdByCanonicalPath = new Map<string, NodeId>();
	for (const [nodeId, node] of Object.entries(state.nodes)) {
		validateNodeIdentityAndPath(nodeId, node, nodeIdByCanonicalPath, issues);
		validateNodeOrder(nodeId, node, issues);
	}

	validateOrderHistory(state, issues);
	validateCollapsedNodes(state, issues);

	if (typeof state.settings.showFilePath !== "boolean") {
		issues.push({
			code: "invalid-settings",
			message: "settings.showFilePath must be a boolean.",
		});
	}

	return { valid: issues.length === 0, issues };
}

export function decodeTreeState(value: unknown): TreeDecodeResult {
	if (!isRecord(value)) {
		return invalidDecode("invalid-state", "Tree data must be a JSON object.");
	}

	const shapeIssues: TreeValidationIssue[] = [];
	const schemaVersion = value.schemaVersion;
	const revision = value.revision;
	const rawNodes = value.nodes;
	const rawOrderHistory = schemaVersion === 2 ? {} : value.orderHistory;
	const rawCollapsedNodeIds = value.collapsedNodeIds;
	const rawSettings = value.settings;

	if (schemaVersion !== 2 && schemaVersion !== CURRENT_TREE_SCHEMA_VERSION) {
		shapeIssues.push({
			code: "unsupported-schema-version",
			message: `Expected schema version 2 or ${CURRENT_TREE_SCHEMA_VERSION}.`,
		});
	}

	if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
		shapeIssues.push({
			code: "invalid-revision",
			message: "Revision must be a non-negative safe integer.",
		});
	}

	if (!isRecord(rawNodes)) {
		shapeIssues.push({ code: "invalid-nodes", message: "nodes must be a JSON object." });
	}
	if (!isRecord(rawOrderHistory)) {
		shapeIssues.push({ code: "invalid-order-history", message: "orderHistory must be a JSON object." });
	}

	if (!Array.isArray(rawCollapsedNodeIds) || !rawCollapsedNodeIds.every((id) => typeof id === "string")) {
		shapeIssues.push({
			code: "invalid-collapsed-nodes",
			message: "collapsedNodeIds must be an array of node IDs.",
		});
	}

	if (!isRecord(rawSettings) || typeof rawSettings.showFilePath !== "boolean") {
		shapeIssues.push({
			code: "invalid-settings",
			message: "settings.showFilePath must be a boolean.",
		});
	}

	const nodes: Record<NodeId, TreeNode> = {};
	if (isRecord(rawNodes)) {
		for (const [nodeId, rawNode] of Object.entries(rawNodes)) {
			if (!isRecord(rawNode)) {
				shapeIssues.push({ code: "invalid-node", message: "Node must be a JSON object.", nodeId });
				continue;
			}

			if (
				typeof rawNode.id !== "string"
				|| typeof rawNode.path !== "string"
				|| !Number.isSafeInteger(rawNode.order)
			) {
				shapeIssues.push({
					code: "invalid-node",
					message: "Node must contain string id/path and integer order.",
					nodeId,
				});
				continue;
			}

			Object.defineProperty(nodes, nodeId, { enumerable: true, configurable: true, writable: true, value: {
				id: rawNode.id,
				path: rawNode.path,
				order: rawNode.order as number,
			} });
		}
	}
	const orderHistory: Record<NodeId, ArchivedOrderRecord> = {};
	if (isRecord(rawOrderHistory)) {
		for (const [nodeId, rawRecord] of Object.entries(rawOrderHistory)) {
			if (!isArchivedOrderRecordShape(rawRecord)) {
				shapeIssues.push({
					code: "invalid-archived-order",
					message: "Archived order must contain a node, reason, and archivedAt timestamp.",
					nodeId,
				});
				continue;
			}
			Object.defineProperty(orderHistory, nodeId, { enumerable: true, configurable: true, writable: true, value: {
				node: { id: rawRecord.node.id, path: rawRecord.node.path, order: rawRecord.node.order },
				reason: rawRecord.reason,
				archivedAt: rawRecord.archivedAt,
			} });
		}
	}

	if (shapeIssues.length > 0) {
		return { valid: false, issues: shapeIssues, state: null };
	}

	const state: TreeState = {
		schemaVersion: CURRENT_TREE_SCHEMA_VERSION,
		revision: revision as number,
		nodes,
		orderHistory,
		collapsedNodeIds: [...(rawCollapsedNodeIds as NodeId[])],
		settings: {
			showFilePath: (rawSettings as Record<string, unknown>).showFilePath as boolean,
		},
	};
	const validation = validateTreeState(state);

	return {
		...validation,
		state: validation.valid ? state : null,
	};
}

function validateNodeIdentityAndPath(
	nodeId: NodeId,
	node: TreeNode,
	nodeIdByCanonicalPath: Map<string, NodeId>,
	issues: TreeValidationIssue[],
): void {
	if (!NODE_ID_PATTERN.test(nodeId) || !NODE_ID_PATTERN.test(node.id)) {
		issues.push({
			code: "invalid-node-id",
			message: "Node IDs may contain only letters, numbers, underscores, and hyphens.",
			nodeId,
		});
	}

	if (node.id !== nodeId) {
		issues.push({
			code: "node-id-mismatch",
			message: `Node key ${nodeId} does not match embedded ID ${node.id}.`,
			nodeId,
		});
	}

	if (!isValidVaultMarkdownPath(node.path)) {
		issues.push({
			code: "invalid-path",
			message: `Invalid Markdown vault path: ${node.path}`,
			nodeId,
		});
		return;
	}

	const canonicalPath = canonicalVaultPath(node.path);
	const duplicateNodeId = nodeIdByCanonicalPath.get(canonicalPath);
	if (duplicateNodeId !== undefined) {
		issues.push({
			code: "duplicate-path",
			message: `Path ${node.path} is already used by node ${duplicateNodeId}.`,
			nodeId,
		});
	} else {
		nodeIdByCanonicalPath.set(canonicalPath, nodeId);
	}
}

function validateNodeOrder(
	nodeId: NodeId,
	node: TreeNode,
	issues: TreeValidationIssue[],
): void {
	if (!Number.isSafeInteger(node.order) || node.order < 0) {
		issues.push({
			code: "invalid-order",
			message: "Sibling order must be a non-negative safe integer.",
			nodeId,
		});
	}
}


function validateOrderHistory(state: TreeState, issues: TreeValidationIssue[]): void {
	if (!isRecord(state.orderHistory)) {
		issues.push({ code: "invalid-order-history", message: "orderHistory must be a JSON object." });
		return;
	}
	for (const [nodeId, record] of Object.entries(state.orderHistory)) {
		if (!isArchivedOrderRecordShape(record)) {
			issues.push({ code: "invalid-archived-order", message: "Archived order record has an invalid shape.", nodeId });
			continue;
		}
		// History may contain multiple former occupants of a path, including its current occupant.
		validateNodeIdentityAndPath(nodeId, record.node, new Map(), issues);
		validateNodeOrder(nodeId, record.node, issues);
		if (Object.prototype.hasOwnProperty.call(state.nodes, nodeId)) {
			issues.push({ code: "duplicate-history-node-id", message: "An active node ID cannot also be archived.", nodeId });
		}
		if (record.reason !== "deleted" && record.reason !== "missing") {
			issues.push({ code: "invalid-archive-reason", message: "Archive reason must be deleted or missing.", nodeId });
		}
		if (!Number.isSafeInteger(record.archivedAt) || record.archivedAt < 0) {
			issues.push({ code: "invalid-archived-at", message: "Archive timestamp must be a non-negative safe integer.", nodeId });
		}
	}
}

function isArchivedOrderRecordShape(value: unknown): value is ArchivedOrderRecord {
	return isRecord(value) && isRecord(value.node)
		&& typeof value.node.id === "string" && typeof value.node.path === "string"
		&& typeof value.node.order === "number" && typeof value.reason === "string"
		&& typeof value.archivedAt === "number";
}

function validateCollapsedNodes(state: TreeState, issues: TreeValidationIssue[]): void {
	const seen = new Set<NodeId>();
	for (const nodeId of state.collapsedNodeIds) {
		if (!Object.prototype.hasOwnProperty.call(state.nodes, nodeId)) {
			issues.push({
				code: "invalid-collapsed-node",
				message: `Collapsed node ${nodeId} does not exist.`,
				nodeId,
			});
		}
		if (seen.has(nodeId)) {
			issues.push({
				code: "duplicate-collapsed-node",
				message: `Collapsed node ${nodeId} is listed more than once.`,
				nodeId,
			});
		}
		seen.add(nodeId);
	}
}

function isValidVaultMarkdownPath(path: string): boolean {
	if (path.length === 0 || path.startsWith("/") || path.includes("\\") || !path.toLowerCase().endsWith(".md")) {
		return false;
	}

	const segments = path.split("/");
	return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function invalidDecode(code: TreeValidationCode, message: string): TreeDecodeResult {
	return { valid: false, issues: [{ code, message }], state: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
