export function isPageEffectivelyCollapsed(
	storedCollapsed: boolean,
	isActiveAncestor: boolean,
	autoRevealSuppressed: boolean,
): boolean {
	return storedCollapsed && (!isActiveAncestor || autoRevealSuppressed);
}
