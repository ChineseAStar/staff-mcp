# Independent file manager extension

This document describes the current source contract, not a deployment or end-to-end acceptance report. The extension is independent of model tool execution and does not require a chat storage migration.

## Tools, file apps, and Resources

- **Tools** retain their existing MCP names and `tools/call` behavior. A host must not infer a file app from tool metadata or wrap file-manager requests as tool calls.
- **File apps** are advertised by an experimental initialize capability. The host reads the declared HTML Resource and supplies a restricted bridge for direct user operations; no model invocation is required.
- **Resources** use standard MCP list, template, read, subscribe, and unsubscribe methods. They work without file-app negotiation, except for the isolated UI Resource itself.

The current server advertises:

```json
{
  "experimental": {
    "cc.qqxing/apps": {
      "version": 1,
      "apps": [{
        "id": "files",
        "title": "文件管理器",
        "resourceUri": "ui://staff-file-manager/v1/index.html",
        "mimeType": "text/html",
        "bridgeVersion": 1,
        "icon": "folder",
        "methods": ["cc.qqxing/file-manager/roots", "cc.qqxing/file-manager/list", "cc.qqxing/file-manager/stat", "cc.qqxing/file-manager/readText", "cc.qqxing/file-manager/saveText", "cc.qqxing/file-manager/createFile", "cc.qqxing/file-manager/mkdir", "cc.qqxing/file-manager/move", "cc.qqxing/file-manager/delete"],
        "transfers": {
          "upload": {"prepare": "cc.qqxing/file-manager/upload/prepare", "commit": "cc.qqxing/file-manager/upload/commit", "release": "cc.qqxing/file-manager/upload/discard"},
          "download": {"prepare": "cc.qqxing/file-manager/download/prepare", "release": "cc.qqxing/file-manager/download/release"}
        }
      }]
    },
    "cc.qqxing/file-transfer": {
      "supported_schemes": ["file", "staff-transfer"],
      "max_chunk_size": 524288
    }
  }
}
```

For extension methods and the UI Resource, the initialized client must advertise `experimental["cc.qqxing/apps"]` with `versions: [1]` and `bridgeVersions: [1]`. Negotiation is checked on the actual SDK session, not inferred from a client name. Unknown versions and unnegotiated calls are rejected. Older clients can continue using ordinary tools, standard file Resources, and legacy FTE; they do not gain access to the file app implicitly.

## App and bridge boundary

The app is served by standard `resources/read` at the declared UI URI. It is not a hosted web URL and is not included in ordinary file resource listings. The current chat-ai host reads that HTML through its SDK, runs it in an opaque-origin `sandbox="allow-scripts"` iframe, blocks network access with CSP, and uses a source-checked MessageChannel handshake. Theme and enabled/connected lifecycle messages come from the host. The theme snapshot includes semantic colors, font families, base font size, and control radius; the app accepts a property-typed allowlist on the authenticated port. Toolbars, tabs, editor surfaces, and progress indicators use those tokens. This does not enable network access or load the host’s external web fonts; font families use locally available fallbacks.

The direct file-manager namespace is `cc.qqxing/file-manager/`. Its ordinary methods are `roots`, `list`, `stat`, `readText`, `saveText`, `createFile`, `mkdir`, `move`, and `delete`. Transfer preparation, finalization, and release are separate methods controlled by the host. The bridge is a generic app host, not an arbitrary tool executor, fetch proxy, shell, or filesystem API. The app translates file actions into its declared full method names; chat-ai does not interpret root/path/editing business parameters. The `mcp-app-ready` / `mcp-app-connect` handshake binds a private MessagePort. Separate app IDs on one MCP are independent launchable workspaces; transport extensions are not UI applications.

## Lazy directory tree

The file navigator uses an on-demand tree for the currently selected root. Opening the app loads only the root’s first page (100 entries); expanding a folder lists only its direct children. Each folder owns its cached pages, loading/error state, cursor, and “Load more” action. After merging pages, the UI sorts that directory’s complete set of loaded entries with directories first and names ascending within the directory and non-directory groups; symlinks remain non-directories. Rendering and keyboard navigation use that same order. The server still paginates by name: until all pages are loaded, the visible entries are not guaranteed to include every directory, and loading another page may insert directories ahead of already-visible files. Sorting does not trigger extra metadata/text reads or fetch unrequested pages. Collapsing a branch hides its descendants without closing file tabs or discarding editor drafts, and reopening an already-loaded branch reuses its cache. No background traversal, eager document reading, filesystem watcher, or full-project index is started.

The tree cache is scoped to the current root and connection availability. Pending reads are fenced when that scope changes or a directory is invalidated, so late replies cannot repopulate an old branch. A failed folder can be retried independently. If the server rejects an expired cursor, that folder must be refreshed rather than appending an inconsistent page. Caches and expansion are not persisted across browser reloads.

The toolbar breadcrumb identifies the current directory, which is the destination for blank-area creation and upload actions; a directory context menu instead targets that directory. There is no separate target-description row. Refresh is an icon in the same toolbar. File names appear in the tree and editor tabs; their full path and listing metadata are available in tooltips instead of repeated headings, an editor-path label or a persistent selection footer. Selecting a folder chooses that folder; selecting a file or activating its editor chooses its parent. Refresh reads that directory’s first page again, resetting only its pagination rather than reloading the entire tree. Save/create/upload refresh their affected parent; rename/move refresh the source and destination parents already loaded by the tree and discard obsolete subtree caches; deletion clears the removed branch and moves an affected destination back to its parent. Open tabs still use their existing version checks, path updates, and draft confirmations. Upload completion refreshes the original upload destination even if navigation changed meanwhile.

On wide views (at least 900 CSS pixels inside the app), the tree and file content appear side by side. Narrow views and phones switch between the tree and content, keeping the same open tabs. Arrow keys move through visible nodes, right/left expand or collapse, and Enter/Space open or select; the existing context-menu key and Shift+F10 continue to work. Activating a tab can expand its ancestors, but never automatically consumes every pagination cursor to locate an item.

The UI renders only expanded branches. Its cost still grows with explicitly loaded, visible entries; this is not a virtualized million-file explorer. The existing server listing implementation reads and sorts a directory’s names before slicing a page, so pagination bounds response size, not the total work of enumerating an exceptionally large single directory. The tree does not change that backend contract or claim to improve network bandwidth. Markdown preview, drag-and-drop moves, Git decorations and recursive search are outside this UI change.

## File actions and adding to a conversation

Tree rows and blank space open contextual menus through desktop right-click, touch/pen long press (about 500 ms), or the keyboard context-menu key / Shift+F10. A hold is cancelled by movement beyond 10 CSS pixels, scrolling, pointer cancellation, navigation, lifecycle changes, or unmounting. It does not prevent ordinary taps or scrolling. After a successful hold only its following synthesized click is consumed; a new physical gesture and keyboard activation are unaffected. The menu supports keyboard navigation and Escape, stays within the iframe viewport, and closes on navigation, scrolling outside the menu, resize, or lifecycle changes. Actions bind to the row that opened the menu, not a previous selection. There are no row “⋯” buttons, tree-local current-directory “⋯”, global file-operation menu, or persistent bottom selection summary. Hover details use the listing metadata; selecting a row does not issue an extra metadata-only stat request. Mutation actions still fetch the latest version before opening their confirmation dialog.

The only menu entry points for creating a file/folder and choosing upload files are directory and blank-area tree context menus. A directory row targets that directory; blank space targets the current breadcrumb directory, including at an empty root. File menus retain their file operations. Transfer history is app-wide, not scoped to a tree location: a dedicated transfer icon beside the toolbar refresh button opens or collapses the existing drawer, including when the directory is empty, read-only, or disconnected. It is not offered in tree context menus. The drawer retains records across directory navigation, its progress/attention indicators, and its existing clear/close actions. The toolbar retains navigation, refresh, and this global transfer control, not create/upload controls. Upload selection captures its root and directory before opening the device picker: changing the selection or current directory while the picker is open cannot redirect the files. A changed root/connection lifetime rejects the old selection instead of reusing stale scope. Read-only/unavailable destinations remain blocked.

The focusable tree also accepts paste events containing actual browser `File` objects. Selecting a directory targets it, selecting a file targets its parent, and an unselected tree targets the current directory. Plain text and pastes into the editor, inline name fields, or other editable elements are not intercepted. FileList and clipboard items are alternate representations, not two upload batches: the populated FileList is preferred, with items as fallback, and duplicate object references are removed without merging distinct same-name files. Default screenshot names such as `image.png` and empty names receive timestamp/random names with an extension; ordinary named files retain their names. No asynchronous clipboard permission API is used, and a paste without file objects never creates an upload or reports success.

External file drops upload only within the tree. A directory row targets that directory, a file row targets its parent, and blank space targets the current directory; a lightweight row/background highlight marks the physical drop location. The target is resolved directly from the drop event, never by changing selection and reading it later. Folder paste/drop payloads are rejected without recursively scanning their contents. Outside the tree, external file drops are prevented from navigating the browser and do not start uploads; ordinary editor text dragging remains available. Picker, paste, and drop all use the existing upload queue, overwrite/version confirmation, cancellation, and refresh of the original destination after completion, even after navigation. Actual uploads expand the existing transfer drawer. None of these inputs broadens the iframe sandbox or changes the bridge/transfer protocol.

New files and folders share an inline name field under the target tree directory, labeled “文件名” for files and “文件夹名” for folders. Only the name is requested: Enter or the explicit Create button confirms, Escape cancels, and IME composition must not submit early. These actions use button clicks and an explicit Enter handler, not form submission, because the iframe does not allow forms. The destination root/directory is captured when naming starts; navigation, root or lifecycle changes cancel the naming UI rather than redirecting a late action. Pending submissions are guarded against duplicate Enter/click requests, and late replies cannot change a newer naming operation.

Creating a file immediately calls the existing atomic `createFile` with empty text; folders use `mkdir`. Existing names are rejected, never overwritten. Success refreshes only the original parent directory and does not open an editor or create an unnamed tab. Users click the created file later to open, edit and save it with the existing version-checked `saveText` flow. All file tabs represent existing server files; unsaved edits keep their existing dirty/close/leave protections. File/folder creation does not add a new backend API or persist browser drafts across reloads.

Open, download, rename, move, copy path, and delete keep their existing business checks. Mutations still fetch a version for the intended target and use the same confirmation flow; deletion is not performed by opening the menu. Directories do not expose file-attachment/download actions, and symlink restrictions remain unchanged.

Regular files can be added to the host conversation from the row menu or editor. The app constructs the canonical `staff-file://` Resource URI by encoding each literal path component once, then invokes the generic bridge `attachResource { uri, title }`. The host reads the actual Resource through the bound MCP and returns `{ attached: true, name }`; the iframe does not supply the attachment body. The existing 256 KiB Resource limit applies, independently of the larger editor/transfer limits. This does not automatically send a message or invoke a model.

If any open tab for that file has unsaved changes, adding is blocked with an explicit save-first message. It never implicitly saves or silently attaches an older server copy. The add button shows its pending state; failures remain visible as errors. Successful adds do not create a persistent confirmation banner or a second attachment-presence state in the file app: the conversation input is the authority for its current attachments. Users return through the host workspace controls. Later external file edits do not update the already-added attachment snapshot.

## Roots, paths, and concurrent edits

Roots come from the existing sandbox: `main` is the workspace and `allowed-N` identifies additional allowed directories. Public paths are root-relative literal names, not host absolute paths or URL-encoded paths. Traversal, symlink traversal, protected roots, and private staging access are checked by the file core. Percent signs in RPC paths are literal filename characters; only the resource URI boundary decodes each component once. Root IDs are session/configuration context, not portable filesystem permissions.

Text reads and edits are capped at **2 MiB**. `saveText` requires the version returned by the read; overwriting an existing upload target likewise requires `expectedVersion`. Shared file-core operations serialize supported writes, recheck versions before publication, and use atomic publication rather than editing a target incrementally. `VERSION_CONFLICT` preserves the editor draft; the UI does not silently force an overwrite. These checks are not a promise to sandbox arbitrary external processes with access to the same filesystem.

`stat` returns metadata without reading/hashing file content by default. Call `stat` with `includeVersion: true` only when a mutation needs a content version; `readText` returns the version along with text. File selection/opening must not hash a large binary merely to display its name. Atomic replacements preserve the target permission bits, including executable bits. Upload copy and download snapshot/hash happen outside the shared write mutex; bounded final source/destination checks remain coordinated. External writers are detected through the documented version/identity checks, not locked out by this service.

Private staging is under the workspace's `.staff/file-manager/`; supported file tools and extension browsing exclude/protect that area. Do not treat staging files or transfer handles as user attachments or ordinary Resources.

## Standard file Resources and attachments

`resources/list` publishes root manifests and immediate regular files at each root, with pagination. It is not a recursive index of all descendants. `resources/templates/list` publishes `staff-file://<rootId>/{+path}` templates for nested paths. A URI encodes each path component once; the server checks canonical encoding and root-relative path validity.

`resources/read` returns real text, Base64 blob content, or a directory manifest. A directory manifest follows the file listing contract, including any next cursor; it is not a recursive archive. The server caps each resource at **256 KiB**, explicitly rejects excess data, and does not truncate. Subscriptions notify clients of changes made through the shared file core; this is not a general filesystem watcher for every external edit.

In chat-ai, adding a file is an explicit action inside the app; the input draft offers a preview of the attached snapshot, without a separate resource workspace. Attachments are snapshots of the returned contents, not URI-only placeholders or live links. Text uses the existing text ContentPart; supported image blobs use data URLs and image ContentParts; other blobs use existing file ContentParts. Source metadata stays in the input draft, while sending uses the normal chat content pipeline. The host also checks the aggregate decoded content limit of 256 KiB and excludes `ui:` and declared app HTML from ordinary attachments. Browsing does not invoke a model or automatically save a message.

## Authorization and cross-chat lifecycle

staff-mcp enforces its configured sandbox and per-session negotiation. It does not interpret chat-ai user roles or chat IDs. A host must enforce its own user identity and current grant before dispatching requests.

The current chat-ai integration uses the authenticated physical user namespace, reads persisted current-chat grants on each operation (including inherited role settings), and uses persisted user defaults for the home/new-chat scope. Runtime bindings include the exact SDK server instance, connection UUID/generation, and app descriptor. Reconnecting invalidates old references, even if the configured server name is unchanged.

The host keeps the iframe mounted across chat routes so in-memory tabs and unsaved drafts can survive a chat switch. An app is not permanently bound to its first chat; reuse still requires the new chat's current permission for the same connection. The current UI cancels active transfers when switching scopes or losing permission/connection rather than promising transparent cross-chat continuation. Apps without the current chat’s MCP grant are hidden from the launcher and workspace, while their iframe drafts remain mounted in the background. Returning to an authorized chat restores access to those drafts. Authorized but disconnected apps can still display drafts for copying, without writing through stale references. Refresh, browser exit, and process restart do not restore drafts or resume transfers.

Cleanup is deliberately narrower than file access: an owner can cancel/close their existing app's temporary transfers even after the grant is revoked, without gaining a new read, write, or commit permission. chat-ai expires idle app bindings after two hours and idle transfers after five minutes.

## Prepared transfers, binary HTTP and FTE compatibility

File-app transfers use opaque prepared handles, not browser-selected `file://` paths. Every prepare returns a common `handle`, `uri`, `size`, `name`; lifecycle calls receive `{ handle }`, and upload commit additionally receives `sha256`.

When using the HTTP listener, prepare also returns a private `{ http: { path, token } }`. The path is `/mcp/transfers/<opaque id>` on the same listener. It is authenticated by a random per-transfer Bearer token, not a credential in the URL. Only a correctly negotiated live session can create a ticket. The ticket is single-use and bound to direction, size, lifetime and session; stream data never selects a filesystem path.

A host can PUT the upload as a continuous raw byte stream, then separately commit it. GET reads the prepared snapshot as a binary stream, followed by release. Node stream backpressure bounds buffering, actual bytes are counted, and cancellation/session disposal abort the pipeline and remove private staging. The data endpoint is routed before JSON parsing. Long network I/O does not hold the global filesystem write mutex.

This HTTP data plane is available only where a host can reach the HTTP listener. stdio/reverse continue to negotiate the private FTE fallback; this change does not add a binary channel to mcp-reverse. Hosts must not advertise a reverse transfer as HTTP streaming merely because their browser-facing response is a stream.

FTE fallback retains this sequence:

1. Upload: `upload/prepare` → private FTE `write/init`, ordered `write/chunk`, `write/close` → SHA-256 verification → `upload/commit`. Cancel/failure discards staging; prepare does not publish the destination.
2. Download: `download/prepare` creates a version-checked snapshot → private FTE read → `download/release`.

Private URIs use `staff-transfer://` and private transfer IDs have a `staff-transfer-` prefix. Both are scoped to one initialized transport session and are invalid after reconnect. The server caps files at **100 MiB**, chunks at **512 KiB**, and prepared transfers at **two per session**, with a five-minute idle TTL and cleanup. A crash/forced process kill can leave staging directories; cleanup is not a cross-restart recovery or disk-quota service. Offsets and states are checked; private completed/aborted transfers cannot be replayed. Retry means starting a new transfer, not replaying an uncertain commit.

The chat-ai host additionally binds transfers to the owning user/app and checks current grants per operation, limits concurrent transfers to two per user, uses bounded raw HTTP upload chunks and a streaming HTTP download, and never opens a local path to implement a remote transfer. The direct-HTTP host path no longer base64-encodes each block into a separate RPC. This remains a relay through the host, not browser-to-server direct transfer. Its current browser download collects stream chunks into a Blob; server streaming is not a claim of zero browser buffering.

The UI expands transfer feedback on download/upload actions. Download preparation has indeterminate progress, receiving reports actual bytes, and a complete validated file waits for an explicit “Save to device” action instead of automatically opening a delayed browser dialog. The generic bridge uses `download` to prepare, `downloadReceive` to acknowledge and start bytes, `downloadSave` to hand the Blob to the browser, and `downloadDiscard` to release it. A cancel during preparation is confirmed only after the late handle is released. Browser handoff does not certify a local disk write. Across all apps, the current host allows two download slots (including receiving, ready files, and short-lived handoff URLs); ready Blobs expire after five minutes, handoff URLs after one minute. Clearing finished records does not discard a ready file.

Image preview is limited to 2 MiB. Cancellation admitted before the final commit prevents publication; once commit has started the host returns `TOO_LATE` rather than claiming an already-issued write was undone.

The transport wrapper routes only private handles to the new SDK handlers. Existing `file://` transfers remain with `mcp-fte` and retain their method/result contract; the file core additionally validates their path boundary. Legacy write requests share the file-core write mutex one request at a time, without holding it across a paused transfer. This boundary relies on the pinned `mcp-fte@1.0.2` synchronous dispatch implementation and must be reviewed when upgrading that dependency. Neither this extension nor its UI replaces the legacy cross-MCP FTE feature.

## Building and shipping the UI

From a development checkout with dependencies installed:

```sh
npm run build
```

The build compiles server TypeScript, type-checks the browser UI via `tsconfig.ui.json`, and runs `scripts/build-file-manager.mjs`. esbuild bundles React, CodeMirror, application code, and CSS into the self-contained `dist/src/file-manager/ui/index.html`. No external CDN or browser network request is required to render it.

The HTML is loaded relative to the compiled extension module. The package includes `dist/src`, so it carries this generated Resource, including when staff-mcp is read-only mounted into a Docker container. `prepublishOnly` runs the build; plain server compilation or `tsx src/index.ts` alone does not create the HTML Resource at the compiled module location. Rebuild and distribute the package for UI changes instead of relying on a developer's working-directory asset.

Updating staff-mcp assets, reconnecting an existing MCP session, opening a new app instance, and deploying host bridge changes are separate steps. An already-open iframe is not hot-replaced by publishing a new package. Build success, package inclusion, protocol tests, service health, and a real logged-in browser flow are distinct checks; this document does not certify unperformed scenarios.
