import { pageFolderPath } from "./page-path";
import type { PhysicalPageMoveAdapter } from "./physical-page-mover";

export interface PhysicalPageDeleteAdapter extends PhysicalPageMoveAdapter {
	trash(path: string): Promise<void>;
}

export type PhysicalPageDeleteErrorCode =
	| "source-not-file"
	| "source-folder-blocked"
	| "trash-failed"
	| "partial-trash-failed"
	| "metadata-commit-failed";

export class PhysicalPageDeleteError extends Error {
	constructor(
		public readonly code: PhysicalPageDeleteErrorCode,
		message: string,
		public readonly originalError?: unknown,
	) {
		super(message);
		this.name = "PhysicalPageDeleteError";
	}
}

export interface PhysicalPageDeletePlan {
	sourcePagePath: string;
	sourceFolderPath: string;
	hasSourceFolder: boolean;
}

export interface PhysicalPageDeleteResult {
	plan: PhysicalPageDeletePlan;
}

export class PhysicalPageDeleter {
	constructor(private readonly adapter: PhysicalPageDeleteAdapter) {}

	async deletePage(
		sourcePagePath: string,
		commitMetadata: (plan: PhysicalPageDeletePlan) => Promise<void>,
	): Promise<PhysicalPageDeleteResult> {
		const plan = this.createPlan(sourcePagePath);

		try {
			await this.adapter.trash(plan.sourcePagePath);
		} catch (error) {
			throw new PhysicalPageDeleteError(
				"trash-failed",
				"The source page could not be moved to the recycle bin.",
				error,
			);
		}

		if (plan.hasSourceFolder) {
			try {
				await this.adapter.trash(plan.sourceFolderPath);
			} catch (error) {
				throw new PhysicalPageDeleteError(
					"partial-trash-failed",
					"The page entered the recycle bin, but its paired folder could not be trashed.",
					error,
				);
			}
		}

		try {
			await commitMetadata(plan);
		} catch (error) {
			throw new PhysicalPageDeleteError(
				"metadata-commit-failed",
				"The physical deletion completed, but metadata persistence failed.",
				error,
			);
		}

		return { plan };
	}

	private createPlan(sourcePagePath: string): PhysicalPageDeletePlan {
		if (this.adapter.getEntryKind(sourcePagePath) !== "file") {
			throw new PhysicalPageDeleteError(
				"source-not-file",
				`The source page ${sourcePagePath} is not a file.`,
			);
		}

		const sourceFolderPath = pageFolderPath(sourcePagePath);
		const sourceFolderKind = this.adapter.getEntryKind(sourceFolderPath);
		if (sourceFolderKind === "file") {
			throw new PhysicalPageDeleteError(
				"source-folder-blocked",
				`The paired source folder ${sourceFolderPath} is a file.`,
			);
		}

		return {
			sourcePagePath,
			sourceFolderPath,
			hasSourceFolder: sourceFolderKind === "folder",
		};
	}
}
