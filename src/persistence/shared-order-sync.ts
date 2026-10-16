import {
	decodeSharedOrder,
	mergeSharedOrders,
	SHARED_ORDER_FORMAT,
	sharedOrderPath,
	type SharedOrderDocument,
	type SharedOrderGroup,
} from "../core/shared-order";
import { generateNodeId } from "../core/tree-state";

export const ORDER_OUTBOX_KEY = "page-tree:order-outbox";

export interface SharedOrderStorage {
	list(): string[];
	read(path: string): Promise<string>;
	/** Create once; retrying identical contents is allowed, overwriting is not. */
	append(path: string, contents: string): Promise<void>;
	loadOutbox(): unknown;
	saveOutbox(documents: SharedOrderDocument[]): void;
}

/** Immutable files prevent simultaneous/offline devices from overwriting one shared JSON. */
export class SharedOrderSync {
	private documents = new Map<string, SharedOrderDocument>();
	private outbox: SharedOrderDocument[];
	private clock = 0;
	private invalid = false;

	constructor(private readonly storage: SharedOrderStorage) {
		const raw = storage.loadOutbox();
		if (raw !== null && raw !== undefined && !Array.isArray(raw)) throw new Error("Invalid order outbox.");
		this.outbox = ((raw ?? []) as unknown[]).map(decodeSharedOrder);
		for (const document of this.outbox) this.clock = Math.max(this.clock, document.clock);
	}

	get active(): boolean { return this.documents.size > 0 || this.outbox.length > 0; }

	get groups(): SharedOrderGroup[] {
		return mergeSharedOrders([...this.documents.values(), ...this.outbox]);
	}

	async reload(): Promise<void> {
		const next = new Map<string, SharedOrderDocument>();
		let invalid = false;
		for (const path of this.storage.list()) {
			try {
				const contents = await this.storage.read(path);
				if (contents.length > 2 * 1024 * 1024) throw new Error("Shared order file is too large.");
				const document = decodeSharedOrder(JSON.parse(contents) as unknown);
				if (sharedOrderPath(document.id) !== path) throw new Error("Shared order filename mismatch.");
				next.set(path, document);
			} catch {
				// A sync client may expose a partial write. Retain the last valid version and retry on modify/reload.
				invalid = true;
				const previous = this.documents.get(path);
				if (previous) next.set(path, previous);
			}
		}
		this.documents = next;
		this.invalid = invalid;
		for (const document of [...next.values(), ...this.outbox]) this.clock = Math.max(this.clock, document.clock);
		if (invalid) throw new Error("Some shared order files are invalid or not fully downloaded. Publishing is paused.");
		await this.flush();
	}

	async publish(groups: SharedOrderGroup[]): Promise<void> {
		if (groups.length === 0) return;
		if (this.invalid) throw new Error("Cannot publish over unreadable shared order files.");
		const document = decodeSharedOrder({
			format: SHARED_ORDER_FORMAT,
			id: generateNodeId(),
			clock: this.clock + 1,
			groups,
		});
		if (JSON.stringify(document, null, 2).length + 1 > 2 * 1024 * 1024) {
			throw new Error("Shared order file is too large.");
		}
		const pending = [...this.outbox, document];
		// Persist the intent before I/O; restarting retries the same ID and clock, not a newer edit.
		this.storage.saveOutbox(pending);
		this.outbox = pending;
		this.clock = document.clock;
		await this.flush();
	}

	private async flush(): Promise<void> {
		while (this.outbox.length > 0) {
			const document = this.outbox[0]!;
			const path = sharedOrderPath(document.id);
			await this.storage.append(path, `${JSON.stringify(document, null, 2)}\n`);
			this.documents.set(path, document);
			const remaining = this.outbox.slice(1);
			this.storage.saveOutbox(remaining);
			this.outbox = remaining;
		}
	}
}
