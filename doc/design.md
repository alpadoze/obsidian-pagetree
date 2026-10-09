# PageTree

PageTree organizes Obsidian notes into a page tree, where every page can contain both text and child pages.

Underneath, everything remains ordinary Markdown: each page corresponds to a `.md` file. Its child pages, if any, are stored in a folder alongside it with the same base name.

The page hierarchy follows the actual file and folder structure. No additional structural markers are added to note contents.

Disabling or uninstalling the plugin leaves your notes as ordinary Markdown files that you can continue to read and edit.

Supports Obsidian on Windows, macOS, and iOS. Requires Obsidian 1.8.7 or later.

After enabling the plugin, run **Open PageTree** from the command palette and click **+** to create a page. On desktop, drag pages to change their hierarchy and order; on mobile, use the **…** menu next to a page.

Deleting a page also deletes all its child pages. A confirmation dialog appears before deletion.

This project is licensed under the [MIT License](../LICENSE).

## Why PageTree?

Many document apps organize content into files and folders, but folders cannot hold text of their own; they only act as containers.

Others offer page trees and rich formatting, but store content in proprietary structures that AI tools cannot easily read or write without additional API integration. The content is difficult to read outside the original app, and multi-device sync errors can affect large amounts of content.

Obsidian stores notes as local Markdown files. Some community plugins maintain page hierarchies by adding structural markers to the notes.

PageTree improves on this by using file and folder relationships to maintain the hierarchy, without adding markers to notes.
