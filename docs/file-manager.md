# Independent file manager extension

This document describes the source contract on the unmerged, unpublished `feat/mcp-file-manager` branch, not a production deployment or full acceptance report. The authoritative protocol is `chat-ai/docs/protocol/README.md` (matching `feat/mcp-file-manager` checkout); both endpoints implement it themselves, with no required extension SDK. The official MCP SDK and standard tools/resources/prompts remain. The extension is independent of model tool execution and does not require a chat storage migration.

## Tools, file apps, and Resources

- **Tools** retain their existing MCP names and `tools/call` behavior. A host must not infer a file app from tool metadata or wrap file-manager requests as tool calls.
- **File apps** are advertised by an experimental initialize capability. The host reads the declared HTML Resource and supplies a restricted bridge for direct user operations; no model invocation is required.
- **Resources** use standard MCP list, template, read, subscribe, and unsubscribe methods. They work without file-app negotiation, except for the isolated UI Resource itself.

The initialize capability uses one discovery root:

```json
{
  "experimental": {
    "cc.qqxing/extensions": {
      "version": 1,
      "extensions": {
        "cc.qqxing/apps": { "versions": [1] },
        "cc.qqxing/files": { "versions": [1] }
      }
    }
  }
}
```

A usable, explicitly enabled Linux PTY on reverse binary transport adds `cc.qqxing/terminal: {versions:[1]}`. Negotiation is tied to the actual initialized SDK session, not a client name. Calls to `cc.qqxing/apps/v1/list {}` return `{apps:[...]}`. The `files` descriptor uses `ui://staff-file-manager/v1/index.html`, `mimeType:"text/html"`, `bridgeVersion:1`, `icon:"folder"`, `requiredExtensions:{"cc.qqxing/files":1}`, and the ordinary `cc.qqxing/file-manager/*` methods listed below. Its transfer methods point to `cc.qqxing/files/v1/prepare`, `commit`, and `release`.

Old `experimental["cc.qqxing/apps"]`, `cc.qqxing/file-transfer/*`, private FTE chunks and reverse SSE are not aliases or fallbacks. Ordinary tools and standard non-UI Resources do not require app negotiation; they remain available without granting implicit file-app or terminal access. A files manifest alone does not provide a binary path: stdio cannot transfer files; the host must also have a direct Streamable HTTP ticket endpoint or reverse v1 channel.

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

## files v1 prepared transfers over HTTP and reverse

The file app and chat-ai's existing `transfer_file` tool share `cc.qqxing/files/v1/*`, not separate app and FTE lifecycles. Ordinary file CRUD retains its existing namespace and schemas. Transfer parameters are strict objects:

| Method suffix | Parameters | Result / meaning |
| --- | --- | --- |
| `roots` | `{}` | configured logical roots |
| `resolve` | `{uri}` | `{rootId,path}` after validating a local `file://` URI against those roots |
| `prepare` (read) | `{operationId,mode:"read",rootId,path}` | stable snapshot metadata |
| `prepare` (write) | `{operationId,mode:"write",rootId,path,size,sha256?,overwrite?,expectedVersion?}` | private staging; overwrite defaults false, true requires expectedVersion, false forbids it |
| `commit` | `{operationId,transferId,sha256}` | committed result `{path,size,sha256,version}` or the operation's current state |
| `status` | `{operationId}` | bounded state/result lookup, never resumes a transfer |
| `renew` | `{operationId}` | `{operationId,expiresInMs:30000}` |
| `cancel` / `release` | `{operationId}` | shared cleanup; `TOO_LATE` after commit admission |

The host generates operationId before the first asynchronous prepare. Prepared metadata includes `operationId,transferId,state,loaded,name,size,expiresInMs,recordTtlMs`; reads also return `sha256,version`. The request field is **mode**, not direction; the lease field is **expiresInMs**, not leaseMs. Reads reject write-only fields. Same operation and parameters deduplicate within that live session; changed parameters or commit digest produce `IDEMPOTENCY_CONFLICT`. Cleanup before a delayed prepare leaves a bounded cancellation tombstone.

On reverse, prepare also returns `link:{kind:"channel",purpose:"cc.qqxing/files",resourceId:transferId,direction:"host-to-remote"|"remote-to-host"}`. The host allocates the numeric wire channel ID; the remote binds the prepared resource once. DATA is binary, ordered and credit-limited, not Base64 per-chunk RPC. File completion/commit is separate from channel EOF/credit.

On the HTTP listener, prepare instead supplies private `http:{path,token}` at `/mcp/transfers/<opaque-id>`. A per-transfer random Bearer token authorizes one stream, bound to the session, direction, size and lease. PUT receives raw bytes into staging; GET sends the prepared snapshot. The endpoint is mounted before JSON parsing, counts actual bytes and uses Node backpressure. Ticket URLs are not file Resources or user-selected paths. Session disposal or cancellation aborts the stream and staging. chat-ai accepts tickets only for its configured direct Streamable HTTP origin and endpoint-relative transfer path, with no redirect; connections configured with an MCP proxy currently do not use that HTTP data path. Tokens never reach the iframe.

Both transports use the same TransferManager and commit checks. stdio has no binary plane and prepare returns `CAPABILITY_UNAVAILABLE`; there is no FTE/Base64 fallback. `transfer_file` keeps its original model name/parameters and file URI inputs, but resolves each URI through this service; that is path validation, not an old FTE handler. Source and destination each consume an owner transfer slot and relay with bounded backpressure; the host does not read the whole file or open a remote path locally.

Uploads progress through prepared/streaming/ready before an explicit digest-checked commit. Downloads read a private version-checked snapshot and then release it, never commit or delete the source. Writes publish atomically through the shared file core; network I/O does not hold the global write mutex. A cancellation admitted before commit prevents publication; after commit admission it is `TOO_LATE`. `status` can return preparing, prepared, streaming, ready, complete, committing, committed, released, expired, failed, or unknown as applicable. Explicit failures include `published:false`; unknown or an unavailable record is not proof of no publication. A lost commit receipt must not trigger an automatic write retry, re-prepare or protocol fallback.

Current limits are **100 MiB per file**, **two active transfers per session**, **128 operation records**, a **30-second remote monotonic lease**, and **five-minute final-state record retention**. The host renews after rechecking authorization, normally within ten seconds, and has its own five-minute idle-transfer timeout. Remote record retention is not an idle lease or persistent transaction journal; reconnect/restart invalidates old handles. Process crashes can leave private staging; this is not a disk-quota or cross-restart recovery service. Reverse wire frames cap payload at **64 KiB**, with **256 KiB** windows and **four** channels / **1 MiB** aggregate receive budget per connection.

The current browser download still collects chunks into a Blob; server streaming is not zero browser buffering or a browser-to-staff direct path. Reverse bandwidth and latency depend on the deployment network and consumer speed. Package/native ABI/libc compatibility is a deployment requirement, not a property of the HTML bundle.

The UI expands transfer feedback on download/upload actions. Download preparation has indeterminate progress, receiving reports actual bytes, and a complete validated file waits for an explicit “Save to device” action instead of automatically opening a delayed browser dialog. The generic bridge uses `download` to prepare, `downloadReceive` to acknowledge and start bytes, `downloadSave` to hand the Blob to the browser, and `downloadDiscard` to release it. A cancel during preparation is confirmed only after the late handle is released. Browser handoff does not certify a local disk write. Across all apps, the current host allows two download slots (including receiving, ready files, and short-lived handoff URLs); ready Blobs expire after five minutes, handoff URLs after one minute. Clearing finished records does not discard a ready file.

Image preview is limited to 2 MiB. Cancellation admitted before the final commit prevents publication; once commit has started the host returns `TOO_LATE` rather than claiming an already-issued write was undone.

Terminal is a separate high-risk human app, not an implicit permission of file access. It requires host `allowTerminal:true` (default false), current chat grant, staff `--terminal`, Linux optional `node-pty`, and reverse binary transport; HTTP/stdio cannot create a PTY. Its starting cwd is not an OS sandbox, and it runs as the staff uid. Terminal I/O is not added to model context or chat history. It uses browser long-poll/next-read ACK backpressure and separate 30-second presence/remote leases, not the file app's two-hour TTL. Backpressured process exit can have incomplete output: current source reports remote `status.error:{code:"OUTPUT_INCOMPLETE",message:string}`, and host read `outputIncomplete?:boolean` / `error?:{code:string,message:string}` on abnormal close/status, with UI warning handling. The boolean belongs to host read, not remote status. These diagnostics detect possible loss; they neither recover missing bytes nor guarantee lossless output, even with exit code 0 or EOF. See the [terminal UI contract](terminal.md) and chat-ai's authoritative terminal protocol for lifecycle and limitations.

## Building and shipping the UI

From a development checkout with dependencies installed:

```sh
npm run build
```

The build compiles server TypeScript, type-checks the browser UI via `tsconfig.ui.json`, and runs `scripts/build-file-manager.mjs`. esbuild bundles React, CodeMirror, application code, and CSS into the self-contained `dist/src/file-manager/ui/index.html`. No external CDN or browser network request is required to render it.

The HTML is loaded relative to the compiled extension module. The package includes `dist/src`, so it carries this generated Resource, including when staff-mcp is read-only mounted into a Docker container. `prepublishOnly` runs the build; plain server compilation or `tsx src/index.ts` alone does not create the HTML Resource at the compiled module location. Rebuild and distribute the package for UI changes instead of relying on a developer's working-directory asset.

Updating staff-mcp assets, reconnecting an existing MCP session, opening a new app instance, and deploying host bridge changes are separate steps. An already-open iframe is not hot-replaced by publishing a new package. Build success, package inclusion, protocol tests, service health, and a real logged-in browser flow are distinct checks; this document does not certify unperformed scenarios.
