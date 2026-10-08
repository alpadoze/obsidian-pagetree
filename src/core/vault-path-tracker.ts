import { canonicalVaultPath } from "./tree-state";

export interface VaultPathChange {
	before: string[];
	after: string[];
	changes: Array<{ from: string; to: string }>;
	removed: string[];
	added: string[];
}

/** Event-time snapshots: never infer rename identity from names, contents or clocks. */
export class VaultPathTracker {
	private paths = new Map<string, string>();

	reset(paths: string[]): void {
		this.paths = new Map(paths.filter(isManagedMarkdownPath).map((path) => [canonicalVaultPath(path), path]));
	}

	snapshot(): string[] {
		return [...this.paths.values()];
	}

	create(path: string): VaultPathChange {
		const event = this.start();
		if (isManagedMarkdownPath(path) && !this.paths.has(canonicalVaultPath(path))) {
			this.paths.set(canonicalVaultPath(path), path);
			event.added.push(path);
		}
		return this.finish(event);
	}

	rename(from: string, to: string, folder: boolean): VaultPathChange {
		const event = this.start();
		for (const path of event.before) {
			if (!pathMatchesEntry(path, from, folder)) continue;
			const target = folder ? `${to}/${path.split("/").slice(from.split("/").length).join("/")}` : to;
			this.paths.delete(canonicalVaultPath(path));
			if (isManagedMarkdownPath(target)) {
				this.paths.set(canonicalVaultPath(target), target);
				event.changes.push({ from: path, to: target });
			} else {
				event.removed.push(path);
			}
		}
		// A non-Markdown/hidden file can become a visible Markdown page, but is not a rename identity match.
		if (!folder && event.changes.length === 0 && isManagedMarkdownPath(to)
			&& !this.paths.has(canonicalVaultPath(to))) {
			this.paths.set(canonicalVaultPath(to), to);
			event.added.push(to);
		}
		return this.finish(event);
	}

	delete(path: string, folder: boolean): VaultPathChange {
		const event = this.start();
		for (const candidate of event.before) {
			if (!pathMatchesEntry(candidate, path, folder)) continue;
			this.paths.delete(canonicalVaultPath(candidate));
			event.removed.push(candidate);
		}
		return this.finish(event);
	}

	private start(): VaultPathChange {
		return { before: this.snapshot(), after: [], changes: [], removed: [], added: [] };
	}

	private finish(event: VaultPathChange): VaultPathChange {
		event.after = this.snapshot();
		return event;
	}
}

export function isManagedMarkdownPath(path: string): boolean {
	return path.toLowerCase().endsWith(".md") && !path.split("/").some((part) => part.startsWith("."));
}

export function pathMatchesEntry(path: string, entryPath: string, folder: boolean): boolean {
	const canonical = canonicalVaultPath(path);
	const entry = canonicalVaultPath(entryPath);
	return folder ? canonical.startsWith(`${entry}/`) : canonical === entry;
}
