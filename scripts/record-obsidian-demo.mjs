import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const port = Number.parseInt(process.argv[2] ?? "9333", 10);
const framesDirectory = process.argv[3];
if (!framesDirectory) throw new Error("Usage: node record-obsidian-demo.mjs <port> <frames-directory>");
await mkdir(framesDirectory, { recursive: true });

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const page = targets.find((target) => target.type === "page" && target.url === "app://obsidian.md/index.html");
if (!page) throw new Error(`No Obsidian page target found on debugging port ${port}.`);

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	socket.addEventListener("open", resolve, { once: true });
	socket.addEventListener("error", reject, { once: true });
});

let nextRequestId = 1;
const pendingRequests = new Map();
socket.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	if (message.id === undefined) return;
	const pending = pendingRequests.get(message.id);
	if (!pending) return;
	pendingRequests.delete(message.id);
	if (message.error) pending.reject(new Error(message.error.message));
	else pending.resolve(message.result);
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = nextRequestId;
	nextRequestId += 1;
	pendingRequests.set(id, { resolve, reject });
	socket.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expression) => {
	const response = await send("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
	});
	if (response.exceptionDetails) {
		throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
	}
	return response.result.value;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
	width: 1440,
	height: 900,
	deviceScaleFactor: 1,
	mobile: false,
});

for (let attempt = 0; attempt < 80; attempt += 1) {
	if (await evaluate("Boolean(globalThis.app?.workspace && globalThis.app?.plugins)")) break;
	await delay(250);
}

const trustAccepted = await evaluate(`(() => {
	const button = [...document.querySelectorAll('button')]
		.find((element) => {
			const label = element.textContent?.trim().toLowerCase() ?? '';
			return element.textContent?.includes('信任仓库作者并启用插件')
				|| (label.includes('trust') && label.includes('enable'));
		});
	if (!button) return false;
	button.click();
	return true;
})()`);
if (trustAccepted) await delay(800);

const initialPluginData = await evaluate(`(async () => {
	const path = '.obsidian/plugins/page-tree/data.json';
	return await app.vault.adapter.exists(path)
		? JSON.parse(await app.vault.adapter.read(path))
		: null;
})()`);
await prepareDemoFixture();
await delay(500);

await evaluate(`(async () => {
	document.body.classList.remove('theme-dark');
	document.body.classList.add('theme-light');
	if (!app.plugins.plugins['page-tree']) await app.plugins.enablePluginAndSave('page-tree');
	app.workspace.rightSplit?.collapse?.();
	app.workspace.leftSplit?.expand?.();
	app.commands.executeCommandById('page-tree:open');
	const file = app.vault.getAbstractFileByPath('PageTree Demo.md');
	if (!file) throw new Error('Demo root page is missing.');
	await app.workspace.getLeaf(false).openFile(file);
})()`);
await delay(900);

await evaluate(`(() => {
	const style = document.createElement('style');
	style.id = 'page-tree-demo-style';
	style.textContent = \`
		#page-tree-demo-caption {
			position: fixed; left: 50%; bottom: 28px; z-index: 10000;
			max-width: 900px; padding: 13px 22px; border-radius: 12px;
			background: rgba(20, 24, 32, 0.9); color: white;
			font: 600 22px/1.35 system-ui, sans-serif; letter-spacing: 0.01em;
			box-shadow: 0 10px 35px rgba(0,0,0,.28);
			transform: translateX(-50%); transition: opacity .22s ease, transform .22s ease;
			pointer-events: none;
		}
		#page-tree-demo-cursor {
			position: fixed; z-index: 10001; width: 28px; height: 36px;
			background: center / contain no-repeat url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='36' viewBox='0 0 28 36'%3E%3Cpath d='M2 2v25l7-6.5L14.5 33l5-2.3-5.7-11.9H24L2 2Z' fill='white' stroke='%23111827' stroke-width='2' stroke-linejoin='round'/%3E%3C/svg%3E");
			filter: drop-shadow(0 2px 3px rgba(0,0,0,.35));
			transition: left .42s ease, top .42s ease;
			pointer-events: none;
		}
		.page-tree-row.is-demo-hover .page-tree-add-child {
			opacity: 1 !important; pointer-events: auto !important; transform: scale(1) !important;
		}
		.workspace-split.mod-left-split { min-width: 380px !important; width: 380px !important; }
		.status-bar { display: none !important; }
	\`;
	document.head.appendChild(style);
	const caption = document.createElement('div');
	caption.id = 'page-tree-demo-caption';
	document.body.appendChild(caption);
	const cursor = document.createElement('div');
	cursor.id = 'page-tree-demo-cursor';
	cursor.style.left = '720px';
	cursor.style.top = '450px';
	document.body.appendChild(cursor);
})()`);

let recording = true;
let frameIndex = 0;
const captureLoop = (async () => {
	while (recording) {
		const startedAt = Date.now();
		const screenshot = await send("Page.captureScreenshot", {
			format: "jpeg",
			quality: 90,
			fromSurface: true,
		});
		const filename = `${String(frameIndex).padStart(6, "0")}.jpg`;
		await writeFile(path.join(framesDirectory, filename), Buffer.from(screenshot.data, "base64"));
		frameIndex += 1;
		await delay(Math.max(0, 100 - (Date.now() - startedAt)));
	}
})();

try {
	await setCaption("1 / 13  Open PageTree: see every Markdown page in a physical tree");
	await hold(3000);

	await setCaption("2 / 13  Open a page: select a tree item to open its Markdown body");
	await clickSelector('.page-tree-row[data-page-path="PageTree Demo/Local Markdown.md"] .page-tree-item');
	await hold(2400);

	await setCaption("3 / 13  Collapse and expand a branch of child pages");
	await clickSelector('.page-tree-row[data-page-path="PageTree Demo.md"] .page-tree-toggle');
	await hold(1100);
	await clickSelector('.page-tree-row[data-page-path="PageTree Demo.md"] .page-tree-toggle');
	await hold(1700);

	await setCaption("4 / 13  Create a root page with the header + button");
	await clickSelector('[aria-label="Create root page"]');
	await waitForVaultPath("Untitled.md");
	await hold(2400);

	await setCaption("5 / 13  Create a child page and its paired folder automatically");
	await hoverRow("PageTree Demo.md");
	await clickSelector('.page-tree-row[data-page-path="PageTree Demo.md"] .page-tree-add-child');
	await waitForVaultPath("PageTree Demo/Untitled.md");
	await hold(2400);

	await setCaption("6 / 13  Reorder siblings precisely by dropping above or below");
	await dragPage(
		"PageTree Demo/Untitled.md",
		"PageTree Demo/Safe Refactoring.md",
		"before",
	);
	await hold(2400);

	await setCaption("7 / 13  Change parent by dropping onto the middle of a page");
	await dragPage("Release Plan.md", "PageTree Demo.md", "inside");
	await waitForVaultPath("PageTree Demo/Release Plan.md");
	await hold(2400);

	await setCaption("8 / 13  Promote a page with the Move to root level drop zone");
	await dragPageToRoot("PageTree Demo/Release Plan.md");
	await waitForVaultPath("Release Plan.md");
	await hold(2400);

	await setCaption("9 / 13  Rename in Obsidian's native title; the full subtree follows");
	await clickSelector('.page-tree-row[data-page-path="PageTree Demo.md"] .page-tree-item');
	await hold(700);
	await renameActiveInlineTitle("PageTree Complete Demo");
	await waitForVaultPath("PageTree Complete Demo/Safe Refactoring.md");
	await hold(2700);

	await setCaption("10 / 13  Delete with confirmation; every child page is deleted too");
	await deletePage("Deletion Demo.md");
	await waitForMissingVaultPath("Deletion Demo.md");
	await waitForMissingVaultPath("Deletion Demo/Child Page.md");
	await hold(2600);

	await setCaption("11 / 13  Check the whole vault and optionally repair missing parent pages");
	await clickSelector('[aria-label="Check page tree"]');
	await waitForSelector(".page-tree-audit-modal");
	await hold(2200);
	await clickSelector(".page-tree-audit-repair");
	await waitForVaultPath("Repair Demo.md");
	await hold(2400);

	await setCaption("12 / 13  Reload the page tree from disk and validate its structure");
	await executeCommand("page-tree:reload");
	await hold(2800);

	await setCaption("13 / 13  Validate the page tree and confirm its structure is healthy");
	await executeCommand("page-tree:validate");
	await hold(3000);

	await setCaption("PageTree complete demo: all 13 actions finished");
	await clickSelector('.page-tree-row[data-page-path="PageTree Complete Demo.md"] .page-tree-item');
	await hold(3500);
} finally {
	recording = false;
	await captureLoop;
	try {
		await cleanupDemoFixture(initialPluginData);
	} finally {
		socket.close();
	}
}

console.log(JSON.stringify({ frameCount: frameIndex, framesDirectory }, null, 2));

async function setCaption(text) {
	await evaluate(`document.querySelector('#page-tree-demo-caption').textContent = ${JSON.stringify(text)}`);
}

async function hoverRow(pagePath) {
	await evaluate(`(() => {
		document.querySelectorAll('.page-tree-row.is-demo-hover')
			.forEach((row) => row.classList.remove('is-demo-hover'));
		const row = document.querySelector(${JSON.stringify(`.page-tree-row[data-page-path="${pagePath}"]`)});
		if (!row) throw new Error(${JSON.stringify(`Demo row not found: ${pagePath}`)});
		row.classList.add('is-demo-hover');
	})()`);
	await moveCursorTo(`.page-tree-row[data-page-path="${pagePath}"] .page-tree-add-child`);
	await hold(700);
}

async function clickSelector(selector) {
	const point = await moveCursorTo(selector);
	await hold(500);
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
	await hold(500);
}

async function moveCursorTo(selector) {
	const point = await evaluate(`(() => {
		const element = document.querySelector(${JSON.stringify(selector)});
		if (!element) throw new Error(${JSON.stringify(`Demo element not found: ${selector}`)});
		element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		const bounds = element.getBoundingClientRect();
		const point = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
		const cursor = document.querySelector('#page-tree-demo-cursor');
		cursor.style.left = point.x + 'px';
		cursor.style.top = point.y + 'px';
		return point;
	})()`);
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
	return point;
}

async function renameActiveInlineTitle(targetTitle) {
	const selector = ".workspace-leaf.mod-active .inline-title";
	const point = await moveCursorTo(selector);
	await hold(600);
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
	await evaluate(`(() => {
		const title = document.querySelector(${JSON.stringify(selector)});
		if (!title) throw new Error('Active inline title disappeared.');
		const range = document.createRange();
		range.selectNodeContents(title);
		const selection = window.getSelection();
		selection.removeAllRanges();
		selection.addRange(range);
	})()`);
	for (const character of [...targetTitle]) {
		await send("Input.insertText", { text: character });
		await hold(70);
	}
	await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
}

async function dragPage(sourcePath, targetPath, position) {
	await moveCursorTo(`.page-tree-row[data-page-path="${sourcePath}"]`);
	await hold(500);
	await evaluate(`(() => {
		const source = document.querySelector(${JSON.stringify(`.page-tree-row[data-page-path="${sourcePath}"]`)});
		const target = document.querySelector(${JSON.stringify(`.page-tree-row[data-page-path="${targetPath}"]`)});
		if (!source || !target) throw new Error('Demo drag row is missing.');
		target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		const bounds = target.getBoundingClientRect();
		const position = ${JSON.stringify(position)};
		const clientY = position === 'before'
			? bounds.top + Math.max(1, bounds.height * 0.1)
			: position === 'after'
				? bounds.bottom - Math.max(1, bounds.height * 0.1)
				: bounds.top + bounds.height * 0.5;
		const dataTransfer = new DataTransfer();
		globalThis.__pageTreeDemoDrag = { source, target, dataTransfer, clientY };
		source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
		target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientY }));
		const cursor = document.querySelector('#page-tree-demo-cursor');
		cursor.style.left = (bounds.left + bounds.width * .55) + 'px';
		cursor.style.top = clientY + 'px';
	})()`);
	await hold(1500);
	await evaluate(`(() => {
		const drag = globalThis.__pageTreeDemoDrag;
		drag.target.dispatchEvent(new DragEvent('drop', {
			bubbles: true, cancelable: true, dataTransfer: drag.dataTransfer, clientY: drag.clientY,
		}));
		drag.source.dispatchEvent(new DragEvent('dragend', {
			bubbles: true, cancelable: true, dataTransfer: drag.dataTransfer,
		}));
		delete globalThis.__pageTreeDemoDrag;
	})()`);
}

async function dragPageToRoot(sourcePath) {
	await moveCursorTo(`.page-tree-row[data-page-path="${sourcePath}"]`);
	await hold(500);
	await evaluate(`(() => {
		const source = document.querySelector(${JSON.stringify(`.page-tree-row[data-page-path="${sourcePath}"]`)});
		const target = document.querySelector('.page-tree-root-drop-zone');
		if (!source || !target) throw new Error('Demo root drag target is missing.');
		const dataTransfer = new DataTransfer();
		source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
		target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		const bounds = target.getBoundingClientRect();
		const point = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
		target.dispatchEvent(new DragEvent('dragover', {
			bubbles: true, cancelable: true, dataTransfer, clientX: point.x, clientY: point.y,
		}));
		const cursor = document.querySelector('#page-tree-demo-cursor');
		cursor.style.left = point.x + 'px';
		cursor.style.top = point.y + 'px';
		globalThis.__pageTreeDemoRootDrag = { source, target, dataTransfer, point };
	})()`);
	await hold(1500);
	await evaluate(`(() => {
		const drag = globalThis.__pageTreeDemoRootDrag;
		drag.target.dispatchEvent(new DragEvent('drop', {
			bubbles: true, cancelable: true, dataTransfer: drag.dataTransfer,
			clientX: drag.point.x, clientY: drag.point.y,
		}));
		drag.source.dispatchEvent(new DragEvent('dragend', {
			bubbles: true, cancelable: true, dataTransfer: drag.dataTransfer,
		}));
		delete globalThis.__pageTreeDemoRootDrag;
	})()`);
}

async function openContextMenu(selector) {
	const point = await moveCursorTo(selector);
	await hold(600);
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "right", clickCount: 1 });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "right", clickCount: 1 });
}

async function clickMenuItem(title) {
	const selector = await evaluate(`(() => {
		const items = [...document.querySelectorAll('.menu-item')];
		const index = items.findIndex((item) => item.textContent?.trim() === ${JSON.stringify(title)});
		if (index < 0) throw new Error(${JSON.stringify(`Demo menu item not found: ${title}`)});
		items[index].dataset.pageTreeDemoMenuItem = 'true';
		return '.menu-item[data-page-tree-demo-menu-item="true"]';
	})()`);
	await clickSelector(selector);
}

async function deletePage(pagePath) {
	await openContextMenu(`.page-tree-row[data-page-path="${pagePath}"]`);
	await hold(650);
	await clickMenuItem("Delete…");
	await hold(2200);
	await clickSelector(".page-tree-delete-confirm");
}

async function prepareDemoFixture() {
	await evaluate(`(async () => {
		const fixturePaths = [
			'PageTree Demo.md', 'PageTree Demo',
			'PageTree Complete Demo.md', 'PageTree Complete Demo',
			'Release Plan.md', 'Release Plan',
			'Deletion Demo.md', 'Deletion Demo',
			'Repair Demo.md', 'Repair Demo',
			'Untitled.md', 'Untitled',
		];
		for (const path of fixturePaths) {
			if (app.vault.getAbstractFileByPath(path)) {
				throw new Error('Demo fixture already exists: ' + path);
			}
		}

		await app.vault.create('PageTree Demo.md', '# PageTree Demo\\n\\nEvery visible tree node is an editable Markdown page.');
		await app.vault.createFolder('PageTree Demo');
		await app.vault.create('PageTree Demo/Local Markdown.md', '# Local Markdown\\n\\nYour page bodies stay as ordinary local Markdown files.');
		await app.vault.create('PageTree Demo/Safe Refactoring.md', '# Safe Refactoring\\n\\nMove and rename complete physical page subtrees.');
		await app.vault.create('Release Plan.md', '# Release Plan\\n\\nA root page ready to be reorganized.');
		await app.vault.create('Deletion Demo.md', '# Deletion Demo\\n\\nDeletion always asks for confirmation.');
		await app.vault.createFolder('Deletion Demo');
		await app.vault.create('Deletion Demo/Child Page.md', '# Child Page\\n\\nChild pages are clearly included in parent deletion.');
		await app.vault.createFolder('Repair Demo');
		await app.vault.create(
			'Repair Demo/Recovered Child.md',
			'# Recovered Child\\n\\nThis page starts without its paired parent Markdown page.',
		);
	})()`);
}

async function cleanupDemoFixture(initialData) {
	await evaluate(`(async () => {
		if (app.plugins.plugins['page-tree']) await app.plugins.disablePlugin('page-tree');
		const paths = [
			'Untitled', 'Untitled.md',
			'PageTree Demo', 'PageTree Demo.md',
			'PageTree Complete Demo', 'PageTree Complete Demo.md',
			'Release Plan', 'Release Plan.md',
			'Deletion Demo', 'Deletion Demo.md',
			'Repair Demo', 'Repair Demo.md',
		];
		for (const path of paths) {
			const entry = app.vault.getAbstractFileByPath(path);
			if (entry) await app.vault.trash(entry, false);
		}
		const dataPath = '.obsidian/plugins/page-tree/data.json';
		const initialData = ${JSON.stringify(initialData)};
		if (initialData === null) {
			if (await app.vault.adapter.exists(dataPath)) await app.vault.adapter.remove(dataPath);
		} else {
			await app.vault.adapter.write(dataPath, JSON.stringify(initialData, null, 2));
		}
		await app.plugins.enablePluginAndSave('page-tree');
		app.commands.executeCommandById('page-tree:open');
	})()`);
}

async function executeCommand(commandId) {
	await evaluate(`(async () => {
		const commandId = ${JSON.stringify(commandId)};
		const result = app.commands.executeCommandById(commandId);
		if (result === false) throw new Error('Demo command was not found: ' + commandId);
		await Promise.resolve(result);
	})()`);
}

async function waitForVaultPath(vaultPath) {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		if (await evaluate(`app.vault.getAbstractFileByPath(${JSON.stringify(vaultPath)}) !== null`)) return;
		await delay(100);
	}
	throw new Error(`Timed out waiting for ${vaultPath}`);
}

async function waitForMissingVaultPath(vaultPath) {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		if (await evaluate(`app.vault.getAbstractFileByPath(${JSON.stringify(vaultPath)}) === null`)) return;
		await delay(100);
	}
	throw new Error(`Timed out waiting for ${vaultPath} to be removed`);
}

async function waitForSelector(selector) {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		if (await evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`)) return;
		await delay(100);
	}
	throw new Error(`Timed out waiting for ${selector}`);
}

async function hold(milliseconds) {
	await delay(milliseconds);
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
