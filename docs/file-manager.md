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
    "cc.qqxing/file-manager": {
      "version": 1,
      "apps": [{
        "id": "files",
        "title": "文件管理器",
        "resourceUri": "ui://staff-file-manager/v1/index.html",
        "mimeType": "text/html",
        "bridgeVersion": 1
      }]
    },
    "cc.qqxing/file-transfer": {
      "supported_schemes": ["file", "staff-transfer"],
      "max_chunk_size": 524288
    }
  }
}
```

For extension methods and the UI Resource, the initialized client must advertise `experimental["cc.qqxing/file-manager"]` with `versions: [1]` and `bridgeVersions: [1]`. Negotiation is checked on the actual SDK session, not inferred from a client name. Unknown versions and unnegotiated calls are rejected. Older clients can continue using ordinary tools, standard file Resources, and legacy FTE; they do not gain access to the file app implicitly.

## App and bridge boundary

The app is served by standard `resources/read` at the declared UI URI. It is not a hosted web URL and is not included in ordinary file resource listings. The current chat-ai host reads that HTML through its SDK, runs it in an opaque-origin `sandbox="allow-scripts"` iframe, blocks network access with CSP, and uses a source-checked MessageChannel handshake. Theme and enabled/connected lifecycle messages come from the host.

The direct file-manager namespace is `cc.qqxing/file-manager/`. Its ordinary methods are `roots`, `list`, `stat`, `readText`, `saveText`, `createFile`, `mkdir`, `move`, and `delete`. Transfer preparation, finalization, and release are separate methods controlled by the host. The bridge is not an arbitrary tool executor, fetch proxy, shell, or filesystem API.

## Roots, paths, and concurrent edits

Roots come from the existing sandbox: `main` is the workspace and `allowed-N` identifies additional allowed directories. Public paths are root-relative literal names, not host absolute paths or URL-encoded paths. Traversal, symlink traversal, protected roots, and private staging access are checked by the file core. Percent signs in RPC paths are literal filename characters; only the resource URI boundary decodes each component once. Root IDs are session/configuration context, not portable filesystem permissions.

Text reads and edits are capped at **2 MiB**. `saveText` requires the version returned by the read; overwriting an existing upload target likewise requires `expectedVersion`. Shared file-core operations serialize supported writes, recheck versions before publication, and use atomic publication rather than editing a target incrementally. `VERSION_CONFLICT` preserves the editor draft; the UI does not silently force an overwrite. These checks are not a promise to sandbox arbitrary external processes with access to the same filesystem.

Private staging is under the workspace's `.staff/file-manager/`; supported file tools and extension browsing exclude/protect that area. Do not treat staging files or transfer handles as user attachments or ordinary Resources.

## Standard file Resources and attachments

`resources/list` publishes root manifests and immediate regular files at each root, with pagination. It is not a recursive index of all descendants. `resources/templates/list` publishes `staff-file://<rootId>/{+path}` templates for nested paths. A URI encodes each path component once; the server checks canonical encoding and root-relative path validity.

`resources/read` returns real text, Base64 blob content, or a directory manifest. A directory manifest follows the file listing contract, including any next cursor; it is not a recursive archive. The server caps each resource at **256 KiB**, explicitly rejects excess data, and does not truncate. Subscriptions notify clients of changes made through the shared file core; this is not a general filesystem watcher for every external edit.

In chat-ai, resource preview and attachment are separate explicit actions. Attachments are snapshots of the returned contents, not URI-only placeholders or live links. Text uses the existing text ContentPart; supported image blobs use data URLs and image ContentParts; other blobs use existing file ContentParts. Source metadata stays in the input draft, while sending uses the normal chat content pipeline. The host also checks the aggregate decoded content limit of 256 KiB and excludes `ui:` and declared app HTML from ordinary attachments. Browsing does not invoke a model or automatically save a message.

## Authorization and cross-chat lifecycle

staff-mcp enforces its configured sandbox and per-session negotiation. It does not interpret chat-ai user roles or chat IDs. A host must enforce its own user identity and current grant before dispatching requests.

The current chat-ai integration uses the authenticated physical user namespace, reads persisted current-chat grants on each operation (including inherited role settings), and uses persisted user defaults for the home/new-chat scope. Runtime bindings include the exact SDK server instance, connection UUID/generation, and app descriptor. Reconnecting invalidates old references, even if the configured server name is unchanged.

The host keeps the iframe mounted across chat routes so in-memory tabs and unsaved drafts can survive a chat switch. An app is not permanently bound to its first chat; reuse still requires the new chat's current permission for the same connection. The current UI cancels active transfers when switching scopes or losing permission/connection rather than promising transparent cross-chat continuation. Disabled or disconnected drafts can be copied but cannot write through stale references. Refresh, browser exit, and process restart do not restore drafts or resume transfers.

Cleanup is deliberately narrower than file access: an owner can cancel/close their existing app's temporary transfers even after the grant is revoked, without gaining a new read, write, or commit permission. chat-ai expires idle app bindings after two hours and idle transfers after five minutes.

## Private FTE and legacy compatibility

File-app transfers use opaque prepared handles, not browser-selected `file://` paths:

1. Upload: `upload/prepare` → private FTE `write/init`, ordered `write/chunk`, `write/close` → SHA-256 verification → `upload/commit`. Cancel/failure discards staging; prepare does not publish the destination.
2. Download: `download/prepare` creates a version-checked snapshot → private FTE read → `download/release`.

Private URIs use `staff-transfer://` and private transfer IDs have a `staff-transfer-` prefix. Both are scoped to one initialized transport session and are invalid after reconnect. The server caps files at **100 MiB**, chunks at **512 KiB**, and prepared transfers at **two per session**, with a five-minute idle TTL and cleanup. Offsets and states are checked; private completed/aborted transfers cannot be replayed. Retry means starting a new transfer, not replaying an uncertain commit.

The chat-ai host additionally binds transfers to the owning user/app and checks current grants per operation, limits concurrent transfers to two per user, uses bounded raw HTTP upload chunks and a streaming HTTP download, and never opens a local path to implement a remote transfer. Its current browser download collects stream chunks into a Blob; server streaming is not a claim of zero browser buffering. Image preview is limited to 2 MiB. Cancellation admitted before the final commit prevents publication; once commit has started the host returns `TOO_LATE` rather than claiming an already-issued write was undone.

The transport wrapper routes only private handles to the new SDK handlers. Existing `file://` transfers remain with `mcp-fte` and retain their method/result contract; the file core additionally validates their path boundary. Legacy write requests share the file-core write mutex one request at a time, without holding it across a paused transfer. This boundary relies on the pinned `mcp-fte@1.0.2` synchronous dispatch implementation and must be reviewed when upgrading that dependency. Neither this extension nor its UI replaces the legacy cross-MCP FTE feature.

## Building and shipping the UI

From a development checkout with dependencies installed:

```sh
npm run build
```

The build compiles server TypeScript, type-checks the browser UI via `tsconfig.ui.json`, and runs `scripts/build-file-manager.mjs`. esbuild bundles React, CodeMirror, application code, and CSS into the self-contained `dist/src/file-manager/ui/index.html`. No external CDN or browser network request is required to render it.

The HTML is loaded relative to the compiled extension module. The package includes `dist/src`, so it carries this generated Resource, including when staff-mcp is read-only mounted into a Docker container. `prepublishOnly` runs the build; plain server compilation or `tsx src/index.ts` alone does not create the HTML Resource at the compiled module location. Rebuild and distribute the package for UI changes instead of relying on a developer's working-directory asset.

Updating staff-mcp assets, reconnecting an existing MCP session, opening a new app instance, and deploying host bridge changes are separate steps. An already-open iframe is not hot-replaced by publishing a new package. Build success, package inclusion, protocol tests, service health, and a real logged-in browser flow are distinct checks; this document does not certify unperformed scenarios.
