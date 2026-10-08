export type PageTreeLanguage = "en" | "zh-cn";

export interface PageTreeTranslations {
	commands: {
		open: string;
		reload: string;
		validate: string;
	};
	view: {
		pageCount(count: number): string;
		checkTree: string;
		checkTreeTitle: string;
		createRoot: string;
		createRootTitle: string;
		treeLabel: string;
		emptyTitle: string;
		emptyDescription: string;
		createPage: string;
		expand(pageTitle: string): string;
		collapse(pageTitle: string): string;
		expandTitle: string;
		collapseTitle: string;
		createChild(pageTitle: string): string;
		createChildTitle: string;
		moveToRoot: string;
		pageActions(pageTitle: string): string;
		loadDegraded(issueCount: number): string;
		loadBackup: string;
	};
	movement: {
		up: string;
		down: string;
		under: string;
		root: string;
		chooseParent: string;
		noAvailableParent: string;
	};
	copy: {
		pageAbsolute: string;
		subtreeAbsolute: string;
		rootPage: string;
		childPages: string;
		pageCopied: string;
		subtreeCopied: string;
		failed: string;
	};
	deletion: {
		menu: string;
		title(pageTitle: string): string;
		description: string;
		childWarning: string;
		cancel: string;
		confirm: string;
	};
	audit: {
		title: string;
		summary(issueCount: number): string;
		missingParents: string;
		extraOrder: string;
		archiveOrder: string;
		archiveOrderConfirm: string;
		archiveOrderNote: string;
		createParents: string;
		createParentsConfirm: string;
		createParentsNote: string;
		orderHistory: string;
		historyNote: string;
		historyDeleted: string;
		historyMissing: string;
		historyArchivedAt(date: string): string;
		historyFileMissing: string;
		historyActiveRecord: string;
		restoreOrder: string;
		undoOrderCleanup: string;
		actionPending: string;
		cancel: string;
		pathConflicts: string;
		pageBodyBlocked(path: string): string;
		pairedFolderBlocked(path: string, pagePath: string): string;
		conflictWarning(conflictCount: number): string;
		close: string;
	};
	notices: {
		validTree: string;
		invalidTree(issueCount: number): string;
		reloadFailed: string;
		auditHealthy: string;
		auditFailed: string;
		orderMaintenanceFailed: string;
		orderHistorySaved: string;
		orderHistoryRestored: string;
		orderHistoryRestoreBlocked: string;
		parentPagesCreated(count: number): string;
		parentPagesCreateFailed: string;
		createdMetadataFailed(pageTitle: string): string;
		createFailed: string;
		deleteSuccess(pageTitle: string): string;
		collapsedSaveFailed: string;
		legacyPluginEnabled: string;
		legacyDataImportFailed: string;
		legacyDataImported: string;
		degradedMutationBlocked: string;
		recoveredBackup: string;
		recoveredPhysical: string;
		reloadSuccess: string;
	};
	errors: {
		moveUnknown: string;
		moveCycle: string;
		moveDestinationExists: string;
		moveFolderBlocked: string;
		moveMissingPage: string;
		moveMetadata: string;
		movePhysical: string;
		moveRollback: string;
		renameUnknown: string;
		renameInvalidTitle: string;
		renameDestinationExists: string;
		renameFolderBlocked: string;
		renameMissingPage: string;
		renameMetadata: string;
		renamePhysical: string;
		renameRollback: string;
		deleteUnknown: string;
		deleteMissingPage: string;
		deleteFolderBlocked: string;
		deleteTrashFailed: string;
		deletePartial: string;
		deleteMetadata: string;
	};
}

const ENGLISH: PageTreeTranslations = {
	commands: {
		open: "Open PageTree",
		reload: "Reload and validate page tree",
		validate: "Validate page tree",
	},
	view: {
		pageCount: (count) => `${count} ${count === 1 ? "page" : "pages"}`,
		checkTree: "Check page tree",
		checkTreeTitle: "Inspect page tree and order history",
		createRoot: "Create root page",
		createRootTitle: "Create untitled root page",
		treeLabel: "PageTree page tree",
		emptyTitle: "No pages yet",
		emptyDescription: "Create a root page to start your page tree.",
		createPage: "Create page",
		expand: (pageTitle) => `Expand ${pageTitle}`,
		collapse: (pageTitle) => `Collapse ${pageTitle}`,
		expandTitle: "Expand",
		collapseTitle: "Collapse",
		createChild: (pageTitle) => `Create child page under ${pageTitle}`,
		createChildTitle: "Create untitled child page",
		moveToRoot: "Move to root level",
		pageActions: (pageTitle) => `Actions for ${pageTitle}`,
		loadDegraded: (issueCount) => `Page order data is unavailable. Rebuilt the tree from physical paths (${issueCount} ${issueCount === 1 ? "issue" : "issues"}).`,
		loadBackup: "Using page order from the last valid state.",
	},
	movement: {
		up: "Move up",
		down: "Move down",
		under: "Move under…",
		root: "Move to root level",
		chooseParent: "Choose a new parent page…",
		noAvailableParent: "PageTree: No other page is available as a parent.",
	},
	copy: {
		pageAbsolute: "Copy page absolute path",
		subtreeAbsolute: "Copy entire subtree absolute paths",
		rootPage: "Root page",
		childPages: "Child pages",
		pageCopied: "PageTree: Page path copied.",
		subtreeCopied: "PageTree: Subtree reference copied.",
		failed: "PageTree: Could not copy the path to the clipboard.",
	},
	deletion: {
		menu: "Delete…",
		title: (pageTitle) => `Delete “${pageTitle}”?`,
		description: "This page and its paired folder will be moved to the trash.",
		childWarning: "This page has child pages. All child pages and their contents will also be deleted.",
		cancel: "Cancel",
		confirm: "Delete",
	},
	audit: {
		title: "Check page tree",
		summary: (issueCount) => `PageTree found ${issueCount} ${issueCount === 1 ? "item" : "items"} to review. Order history is listed separately.`,
		missingParents: "Missing parent pages",
		extraOrder: "Order records whose files are not currently found",
		archiveOrder: "Organize order records",
		archiveOrderConfirm: "Move listed records to history",
		archiveOrderNote: "A file not found at its recorded path may have moved or may still be syncing. Only the listed order records will move to recoverable history. Markdown files and other pages' order records will not be changed.",
		createParents: "Create missing parent pages",
		createParentsConfirm: "Create the listed Markdown pages",
		createParentsNote: "This will create only the empty Markdown parent pages listed below. It will not organize order records or move, overwrite, or delete existing files. Confirm the exact paths before continuing.",
		orderHistory: "Order history",
		historyNote: "Order history does not create or restore page contents. Undo cleanup can return an archived order record even while its file is missing. Restoring order after deletion requires the Markdown file to exist. Both actions require no conflicting active order record.",
		historyDeleted: "Archived after deletion",
		historyMissing: "Archived when the file was not found",
		historyArchivedAt: (date) => `Archived: ${date}`,
		historyFileMissing: "Unavailable: the Markdown file is not currently present. Restore the file separately first.",
		historyActiveRecord: "Unavailable: an active order record already uses this path or record ID.",
		restoreOrder: "Restore order",
		undoOrderCleanup: "Undo cleanup",
		actionPending: "Working…",
		cancel: "Cancel",
		pathConflicts: "Path conflicts requiring manual review",
		pageBodyBlocked: (path) => `${path} cannot be created because that path is already a folder.`,
		pairedFolderBlocked: (path, pagePath) => `${path} is a file and blocks the paired folder for ${pagePath}.`,
		conflictWarning: (conflictCount) => `${conflictCount} ${conflictCount === 1 ? "conflict requires" : "conflicts require"} manual review and will not be changed automatically.`,
		close: "Close",
	},
	notices: {
		validTree: "PageTree: The page tree is valid.",
		invalidTree: (issueCount) => `PageTree: Found ${issueCount} tree structure ${issueCount === 1 ? "issue" : "issues"}.`,
		reloadFailed: "PageTree: Failed to reload tree data. The current view is unchanged.",
		auditHealthy: "PageTree: The physical page tree follows all pairing rules.",
		auditFailed: "PageTree: Could not check the physical page tree.",
		orderMaintenanceFailed: "PageTree: Could not organize order records. Markdown files were not changed.",
		orderHistorySaved: "PageTree: The selected order records were saved to recoverable history. Markdown files were not changed.",
		orderHistoryRestored: "PageTree: The order record was restored. Page contents were not changed.",
		orderHistoryRestoreBlocked: "PageTree: This order record cannot be restored because its file is missing or an active record conflicts. No page contents were restored or overwritten.",
		parentPagesCreated: (count) => `PageTree: Created ${count} empty parent ${count === 1 ? "page" : "pages"}. Order records were not organized.`,
		parentPagesCreateFailed: "PageTree: Could not create all selected parent pages. Existing files were not overwritten or deleted; check the page tree again.",
		createdMetadataFailed: (pageTitle) => `PageTree: “${pageTitle}” remains safe as a Markdown file, but could not be added to the page tree.`,
		createFailed: "PageTree: Could not create an untitled page.",
		deleteSuccess: (pageTitle) => `PageTree: “${pageTitle}” was moved to the trash.`,
		collapsedSaveFailed: "PageTree: Failed to save the collapsed state. Restored the previous state.",
		legacyPluginEnabled: "PageTree: Disable the previous plugin before enabling PageTree. Do not run both plugins together.",
		legacyDataImportFailed: "PageTree: Could not import previous plugin data. Startup stopped; the old installation was not changed.",
		legacyDataImported: "PageTree: Imported previous page order and settings. The old installation was preserved.",
		degradedMutationBlocked: "PageTree: The current tree data is invalid and will not be overwritten until it is repaired or restored.",
		recoveredBackup: "PageTree: The current tree data is invalid. Restored the last valid state.",
		recoveredPhysical: "PageTree: Page order data is unavailable. Rebuilt the tree safely from physical file paths.",
		reloadSuccess: "PageTree: The page tree was reloaded and passed validation.",
	},
	errors: {
		moveUnknown: "PageTree: The page could not be moved. File locations are unchanged.",
		moveCycle: "PageTree: A page cannot be moved under itself or one of its descendants.",
		moveDestinationExists: "PageTree: A page or paired folder with the same name already exists at the destination.",
		moveFolderBlocked: "PageTree: A file blocks the required page folder. Nothing was moved.",
		moveMissingPage: "PageTree: The source page or destination parent no longer exists. Reload and try again.",
		moveMetadata: "PageTree: Failed to save page order. The file move was rolled back.",
		movePhysical: "PageTree: The file move failed. The original location was restored.",
		moveRollback: "PageTree: The move could not be fully rolled back. Files were preserved; check both locations.",
		renameUnknown: "PageTree: Could not synchronize the Obsidian title rename. The original title was restored where possible.",
		renameInvalidTitle: "PageTree: The name is empty, too long, or contains characters that are not valid in file names.",
		renameDestinationExists: "PageTree: A page or paired folder with the new title already exists. The original title was restored.",
		renameFolderBlocked: "PageTree: A file blocks the paired page folder. The original title was restored.",
		renameMissingPage: "PageTree: The source page no longer exists. Reload and try again.",
		renameMetadata: "PageTree: Failed to save page order. The original page name was restored.",
		renamePhysical: "PageTree: The file rename failed. The original name was restored.",
		renameRollback: "PageTree: The rename could not be fully rolled back. Files were preserved; check both locations.",
		deleteUnknown: "PageTree: Deletion failed. Files not confirmed as deleted remain in their original location or the trash.",
		deleteMissingPage: "PageTree: The page no longer exists. Reload and try again.",
		deleteFolderBlocked: "PageTree: A file blocks the paired page folder. Nothing was deleted.",
		deleteTrashFailed: "PageTree: The page could not be moved to the trash. Deletion was not completed.",
		deletePartial: "PageTree: The page was moved to the trash, but its paired folder and child pages could not be deleted.",
		deleteMetadata: "PageTree: File deletion completed, but page order could not be saved. Reload to rebuild the tree from Markdown paths.",
	},
};

const SIMPLIFIED_CHINESE: PageTreeTranslations = {
	commands: {
		open: "打开 PageTree",
		reload: "重新加载并校验页面树",
		validate: "校验页面树",
	},
	view: {
		pageCount: (count) => `${count} 个页面`,
		checkTree: "检查页面树",
		checkTreeTitle: "查看页面树与排序历史",
		createRoot: "新建根页面",
		createRootTitle: "新建未命名根页面",
		treeLabel: "PageTree 页面树",
		emptyTitle: "还没有页面",
		emptyDescription: "新建一个根页面，开始构建页面树。",
		createPage: "新建页面",
		expand: (pageTitle) => `展开 ${pageTitle}`,
		collapse: (pageTitle) => `折叠 ${pageTitle}`,
		expandTitle: "展开",
		collapseTitle: "折叠",
		createChild: (pageTitle) => `在 ${pageTitle} 下新建子页面`,
		createChildTitle: "新建未命名子页面",
		moveToRoot: "移至根层级",
		pageActions: (pageTitle) => `${pageTitle} 的操作菜单`,
		loadDegraded: (issueCount) => `页面排序数据不可用，已根据物理路径重建页面树（${issueCount} 个问题）。`,
		loadBackup: "正在使用最近一次有效的页面排序数据。",
	},
	movement: {
		up: "上移",
		down: "下移",
		under: "移至页面下…",
		root: "移至根层级",
		chooseParent: "选择新的父页面…",
		noAvailableParent: "PageTree：没有可作为父页面的其他页面。",
	},
	copy: {
		pageAbsolute: "复制页面绝对路径",
		subtreeAbsolute: "复制整个子树绝对路径",
		rootPage: "根页面",
		childPages: "子页面目录",
		pageCopied: "PageTree：页面路径已复制。",
		subtreeCopied: "PageTree：子树引用已复制。",
		failed: "PageTree：无法将路径复制到剪贴板。",
	},
	deletion: {
		menu: "删除…",
		title: (pageTitle) => `删除“${pageTitle}”？`,
		description: "此页面及其配对目录将移至回收站。",
		childWarning: "此页面包含子页面。所有子页面及其内容也会一并删除。",
		cancel: "取消",
		confirm: "删除",
	},
	audit: {
		title: "检查页面树",
		summary: (issueCount) => `PageTree 发现 ${issueCount} 个待查看项目。排序历史单独列出，不计为问题。`,
		missingParents: "缺失父页面",
		extraOrder: "暂未找到文件的排序记录",
		archiveOrder: "整理排序记录",
		archiveOrderConfirm: "将所列记录移入历史",
		archiveOrderNote: "暂未在原路径找到文件，可能是文件已移动或同步尚未完成。此操作仅将下列排序记录移入可恢复历史，不修改 Markdown 正文，也不补全其他页面的排序记录。",
		createParents: "补建父页面",
		createParentsConfirm: "创建所列 Markdown 页面",
		createParentsNote: "此操作仅创建下方列出的空白 Markdown 父页面，不整理排序记录，不移动、覆盖或删除已有文件。请确认将创建的完整路径后继续。",
		orderHistory: "排序历史",
		historyNote: "排序历史不会创建或恢复正文。“撤销整理”仅恢复旧排序记录，文件仍不存在时也可撤销；删除后“恢复排序”则须先找回对应 Markdown 文件。两者均不能与当前排序记录冲突。",
		historyDeleted: "删除后归档",
		historyMissing: "暂未找到文件时归档",
		historyArchivedAt: (date) => `归档时间：${date}`,
		historyFileMissing: "暂不可恢复：对应 Markdown 文件尚不存在，请先单独恢复文件。",
		historyActiveRecord: "暂不可恢复：已有当前排序记录占用该路径或记录 ID。",
		restoreOrder: "恢复排序",
		undoOrderCleanup: "撤销整理",
		actionPending: "正在处理…",
		cancel: "取消",
		pathConflicts: "需要人工处理的路径冲突",
		pageBodyBlocked: (path) => `无法创建 ${path}，因为该路径已经是一个文件夹。`,
		pairedFolderBlocked: (path, pagePath) => `${path} 是文件，阻挡了 ${pagePath} 所需的配对目录。`,
		conflictWarning: (conflictCount) => `${conflictCount} 个路径冲突需要人工处理，不会自动改动。`,
		close: "关闭",
	},
	notices: {
		validTree: "PageTree：页面树校验通过。",
		invalidTree: (issueCount) => `PageTree：发现 ${issueCount} 个页面树结构问题。`,
		reloadFailed: "PageTree：重新加载页面树数据失败，当前视图未改变。",
		auditHealthy: "PageTree：物理页面树符合全部配对规则。",
		auditFailed: "PageTree：无法检查物理页面树。",
		orderMaintenanceFailed: "PageTree：无法完成排序记录整理，Markdown 文件未被改动。",
		orderHistorySaved: "PageTree：所选排序记录已保存到可恢复历史，Markdown 文件未被改动。",
		orderHistoryRestored: "PageTree：排序记录已恢复，正文未被改动。",
		orderHistoryRestoreBlocked: "PageTree：文件尚不存在或已有排序记录冲突，无法恢复此排序记录。未恢复或覆盖正文。",
		parentPagesCreated: (count) => `PageTree：已创建 ${count} 个空白父页面，未整理排序记录。`,
		parentPagesCreateFailed: "PageTree：未能创建全部所选父页面。现有文件未被覆盖或删除，请重新检查页面树。",
		createdMetadataFailed: (pageTitle) => `PageTree：“${pageTitle}”已安全保留为 Markdown 文件，但无法加入页面树。`,
		createFailed: "PageTree：无法新建未命名页面。",
		deleteSuccess: (pageTitle) => `PageTree：“${pageTitle}”已移至回收站。`,
		collapsedSaveFailed: "PageTree：保存折叠状态失败，已恢复此前状态。",
		legacyPluginEnabled: "PageTree：请先停用旧插件，再启用 PageTree，不能同时运行两个插件。",
		legacyDataImportFailed: "PageTree：无法导入旧插件数据，已停止启动，旧安装未被修改。",
		legacyDataImported: "PageTree：已导入旧页面排序和设置，旧安装已保留。",
		degradedMutationBlocked: "PageTree：当前页面树数据无效；修复或恢复前不会覆盖这些数据。",
		recoveredBackup: "PageTree：当前页面树数据无效，已恢复最近一次有效状态。",
		recoveredPhysical: "PageTree：页面排序数据不可用，已安全地根据物理文件路径重建页面树。",
		reloadSuccess: "PageTree：页面树已重新加载并通过校验。",
	},
	errors: {
		moveUnknown: "PageTree：无法移动页面，文件位置未改变。",
		moveCycle: "PageTree：页面不能移入自身或自己的后代。",
		moveDestinationExists: "PageTree：目标位置已存在同名页面或配对目录。",
		moveFolderBlocked: "PageTree：有文件阻挡了所需的页面目录，未移动任何内容。",
		moveMissingPage: "PageTree：源页面或目标父页面已不存在，请重新加载后再试。",
		moveMetadata: "PageTree：保存页面排序失败，文件移动已回滚。",
		movePhysical: "PageTree：文件移动失败，已恢复原位置。",
		moveRollback: "PageTree：无法完整回滚移动。文件已保留，请检查源位置和目标位置。",
		renameUnknown: "PageTree：无法同步 Obsidian 标题改名，已尽可能恢复原标题。",
		renameInvalidTitle: "PageTree：名称为空、过长或包含文件名不允许的字符。",
		renameDestinationExists: "PageTree：已存在使用新名称的页面或配对目录，已恢复原标题。",
		renameFolderBlocked: "PageTree：有文件阻挡了配对页面目录，已恢复原标题。",
		renameMissingPage: "PageTree：源页面已不存在，请重新加载后再试。",
		renameMetadata: "PageTree：保存页面排序失败，已恢复原页面名称。",
		renamePhysical: "PageTree：文件改名失败，已恢复原名称。",
		renameRollback: "PageTree：无法完整回滚改名。文件已保留，请检查两个位置。",
		deleteUnknown: "PageTree：删除失败。未确认删除的文件仍位于原位置或回收站。",
		deleteMissingPage: "PageTree：页面已不存在，请重新加载后再试。",
		deleteFolderBlocked: "PageTree：有文件阻挡了配对页面目录，未删除任何内容。",
		deleteTrashFailed: "PageTree：无法将页面移至回收站，删除未完成。",
		deletePartial: "PageTree：页面已移至回收站，但无法删除其配对目录和子页面。",
		deleteMetadata: "PageTree：文件删除已完成，但无法保存页面排序。请重新加载，以根据 Markdown 路径重建页面树。",
	},
};

export function resolvePageTreeLanguage(language: string): PageTreeLanguage {
	return language.trim().toLowerCase().startsWith("zh") ? "zh-cn" : "en";
}

export function getPageTreeTranslations(language: string): PageTreeTranslations {
	return resolvePageTreeLanguage(language) === "zh-cn"
		? SIMPLIFIED_CHINESE
		: ENGLISH;
}
