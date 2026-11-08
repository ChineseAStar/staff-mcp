# Changelog

## 2.2.0 — 2026-11-08

- Migrate to the official split MCP SDK 2 packages: `client`, `server` and `core` 2.4.0, with `node` 2.1.2. Serve legacy and modern `2026-07-28` clients over stdio, reverse and direct HTTP; nested MCP clients negotiate in the original process without relaunching unknown commands for protocol probes. Preserve ordinary tool names, shared process state, permissions, guarded pagination and per-call output validation.
- Serve modern HTTP through per-request SDK facades without `Mcp-Session-Id` or hidden session headers. Files/PTY/data state instead belongs to a public DATA2 `control:{binding,token}` capability with a separately renewed 90-second lease. APPS/FILES/STREAMS and bridge stay v1; stdio/reverse in both eras and legacy HTTP keep DATA1. This is a paired modern HTTP control-wire upgrade, not a change to raw HTTP bytes, channel tokens or consumption ACKs.
- Validate DATA2 business calls against the enabled server features, original owner grant and current request grant. Fence new work on close/expiry/shutdown and await admitted operations and cleanup; failed cleanup does not report closed or release capacity. Limit listener admission to 64 legacy sessions plus active/closing bindings combined, with a separate 128-total-record DATA2 proof bound. Original-operation status/cleanup within bounded retention cannot restore writes; missing/unknown records do not prove non-publication. No automatic owner replacement, transfer resumption, commit retry or terminal-input replay is added.
- Use `capabilities.extensions` when present, falling back to `experimental` only when that container is absent. Empty/invalid new grants cannot inherit old grants or another modern request's capabilities. Keep canonical file-resource admission and descendant invalidation; the SDK owns subscription filtering, acknowledgements, IDs and cancellation, with HTTP interests scoped to response streams.
- Publish standard Skills through the official Beta `io.modelcontextprotocol/skills` extension (`skills/list`, `skills/get`) and `skill://staff/{+path}` Resource template, using SDK raw-byte sizes and SHA-256 manifests. Preserve SkillManager/profile precedence; omit invalid standard entries without selecting lower-priority duplicates. Bound each skill scan to 512 files and 16 MiB, reject traversal/symlink escapes/special files, and keep nested content inert. Standard discovery and both legacy skill-reading tools resolve current selections on demand; automatic watching remains limited to project `.staff/skills`.
- Keep legacy `skill`, `read_skill_file`, prompts and persistent-result metadata. Mark those two tools with `_meta["chat-ai/skill-compatibility"] = true` so a matching host can consolidate fresh model menus and manual calls into platform skill tools while the server retains old-client compatibility. The paired host exposes authorized skill names/descriptions/sources before the first model request and loads content through read-only built-ins. Reading does not execute scripts, install dependencies or grant tools; subsequent tool calls retain their existing authorization.
- Pair with chat-ai `tmp/inner-mcp-stdio` commit `1d659874f4da0540274ea454f016cebaa6838945` or a compatible successor and matching host/descriptors/UI assets. Older host commits listed under 2.1.0/2.0.7 are not sufficient for modern HTTP DATA2 or standard Skills integration. Update the host and its bundled staff dependency explicitly, then participating staff endpoints, reconnect MCP and reopen Apps. npm publication alone does not deploy or restart them.

The 2.1.0 container/tool boundary and template-only file discovery are retained. Extensions remain off by default; existing file/PTY leases, permissions, commit uncertainty and no-replay rules remain. No new persistent data format or Chat8/schema9/format7/share protocol2 migration is required. Node.js >= 22.22.2 and the `node-pty@1.2.0-beta.18` pin remain. The release target is Linux x64; this entry does not claim new Windows/macOS/musl validation, company-network reverse I/O fixes or full end-to-end acceptance. Publishing continues through the existing release-tag ancestry check against `master` and OIDC workflow; no workflow or master requirement is bypassed.

## 2.1.0 — 2026-11-07

- Use one explicit container mode for instructions and ordinary tool path access. Container file tools and command working directories are no longer limited to the workspace; Host mode keeps its configured directory boundary. The operating-system user, read-only mounts, private staging, configured-root protection, and existing file transaction rules still apply.
- Keep public files/resource roots separate from container tool access; enabling container mode does not publish `/` or broaden files/transfer RPC paths. Platform-managed containers must inject the trusted `STAFF_MCP_IS_DOCKER=1` marker before starting staff; native `--docker` does the same.
- Stop enumerating workspace roots and immediate files in `resources/list`; retain the standard method with an empty result and reject supplied cursors. Discovery no longer scans root directories.
- Keep the existing file URI template per configured root, resource reads/subscriptions, and file App discovery, browsing and explicit attachments unchanged. A single-root workspace exposes one template; independently authorized roots retain separate template identities. Current chat-ai `@` menus no longer offer staff file quick picks; select the file or directory in the file App instead.
- Pair with chat-ai commit `77369efdeeb9defce218fad95145b4dcae99724d` or a compatible descendant for managed container markers, exact empty template expansion and fail-closed handling of unresolved legacy resource denials. Update the host first; its formal bundled dependency update follows separately. This npm release does not merge chat-ai into codex-cloud or deploy other environments.
- Before upgrading a chat-ai instance with legacy name-only resource denials, save its resource permissions against the old catalog to convert those rules to URI identities. Existing URI/template restrictions remain valid; unresolved legacy name denials fail closed in the matching host. No automatic permission migration, host bundle update, endpoint reconnect or side-effect replay is performed.

This release retains MCP SDK 1.32.1, existing MCP/extension protocols, dependency versions and Skills tools. Linux x64 isolated builds, real Docker file/data/PTY checks and permission regressions were verified; no new OS/architecture, real-model or company-network compatibility claims are made.

## 2.0.7 — 2026-11-06

- Carry local/Docker stdio extension data in bounded same-connection Base64 frames: at most 64 KiB decoded per frame and a 256 KiB consumption window per channel/direction. Control and data share one FIFO writer; ACK follows actual consumption, and file ACK is not commit. No data port, listener, endpoint, HTTP ticket, fallback or replay is added. Direct HTTP/reverse configure/open and raw HTTP wire remain unchanged.
- Add optional Linux Bash initialization through `STAFF_MCP_SHELL_INIT`, sourced before each command and new PTY so aliases, functions, exports and directory changes share that shell. The management Node process never sources it; failures prevent user input, and changes affect only subsequent commands/new PTYs. Without the variable, previous startup behavior is unchanged.
- Expand bundled editor syntax coloring to common languages and reuse bounded parsers for Markdown code fences; unknown/large documents and over-budget fences remain plain text. Soft-wrap editor lines at all widths, including explicitly loaded large text, without modifying saved content or undo history.
- Improve Markdown reading with local font controls, a heading outline docked on the right when space permits and a bounded dropdown in narrow views. Preserve current-draft previews, parsing budgets and the isolated no-network/no-raw-HTML policy.
- Separate workspace navigation/transfer history, current-file actions and reading/editing controls. Simplify the tree and empty workspace, keep blank-area actions targeted at the displayed root, and improve bounded file tabs and explicit dirty-draft close confirmations. Existing path/version checks, authorization and text/attachment limits are unchanged.
- Remove the terminal App's duplicate close button; the host close-App action retains existing lifecycle cleanup. Closing does not roll back side effects or guarantee termination of detached descendants.
- Pair with chat-ai commit `5bfa6a4321d258e5129b250da248adff96b6ad42` or a compatible descendant for the matching protocol and permissions. The host's formal bundled dependency update will follow in a compatible descendant. Older stdio hosts may lose optional data-dependent Apps/transfers, not healthy standard MCP tools/resources/prompts. Upgrade both endpoints, reconnect MCP and reopen Apps; running processes/assets do not update automatically.
- Docker template/user-script orchestration, short managed staff commands and dark chat rendering are host-only changes, not features delivered by this npm package alone. All extensions remain explicit opt-in; no persistent data migration, transfer resumption or automatic replay is introduced.

Release verification covers Linux x64 with Chromium, not new Windows/macOS/musl validation or support. Existing Docker ownership/mount/native prerequisites, permissions, leases, commit uncertainty and resource limits remain. Remote-network streaming and I/O remain deployment-specific and require verification in the target network.

## 2.0.6 — 2026-11-04

- Add reference-only file attachments, with a separate bounded content-attachment action. A matching chat-ai host preserves source metadata in formal messages, history, sharing and export; references do not read or copy file contents.
- Let users resize the desktop file tree/editor split by dragging its divider, with bounded pane sizes and unchanged narrow-screen navigation. The width is local to the open App instance.
- Add Markdown previews of the current unsaved draft, with GFM support but no raw HTML execution, external image loads or navigation.
- Add directory-picker uploads that preserve relative paths, with per-file conflict checks and explicit overwrite confirmation. Browser pickers omit empty directories; batches are not atomic, and cancellation does not delete already committed files or created directories.
- Add explicit server-side ZIP downloads for non-root directories, preserving Unicode names and empty directories. ZIP preparation uses disk-backed snapshots and rejects symlinks, protected staging paths and unsupported objects; it is not an atomic snapshot of a concurrently changing directory.
- Start native downloads after preparation without a second routine confirmation; retain a host-confirmed manual-start fallback. Preserve safe file error codes/phases without exposing internal paths or credentials.
- Retain cleaned-up terminal transfer receipts separately from active transfers: 2 active, 128 heavy/unresolved and 4096 total retained records. Final receipts keep their existing five-minute lifetime; unknown publication results are not compacted or automatically replayed.
- Treat structured `BINARY_FILE` text-preview refusals as normal unsupported-preview states, keeping download/reference actions available. Actual permission, missing-file, size and connection errors remain visible.
- Automatically load text up to 512 KiB; larger files below 5 MiB require an explicit Load text action. Previews above the existing 2 MiB editing limit are read-only; files at or above 5 MiB are download-only. Preserve dirty drafts on failed rereads and check the encoded RPC budget without increasing the SDK stdio buffer limit.
- Keep the 2 MiB text-save and 256 KiB content-attachment limits, extension/data protocol versions, native dependency pins, permissions, leases and single-use transfer/commit safeguards unchanged. No persistent data migration is required.
- Upgrade chat-ai to commit `972d26e2df5998f67dbcbab96685f72ef1fadf3cbbf` or a compatible descendant, then update staff-mcp, reconnect MCP and reopen Apps. Background WebSocket heartbeats, upload HTTP diagnostics, command editing and source-bound App merging are host changes, not fixes delivered by this npm package alone.

Existing preparation/lease limits, disk-space requirements, proxy limits and data-consumption timeouts still apply. This release does not add video playback, resumable transfers, or automatic retries of uncertain writes; it does not claim to resolve every large-file/slow-link failure. Remote running processes are not updated automatically.

## 2.0.5 — 2026-10-27

- Remove the 100 MiB whole-file limit from files-v1 read preparation, write preparation and the file App upload queue. File sizes remain nonnegative safe integers; text editing (2 MiB), Resource reads (256 KiB), chunk/window bounds, permissions, staging protection and transfer concurrency are unchanged.
- Snapshot a fixed initial source size in bounded 64 KiB chunks, preserving identity/metadata checks and detecting short reads or source changes. Cancellation, disconnect and lease expiry stop ongoing snapshot copy rather than continuing large unneeded disk I/O.
- Pair with the matching chat-ai native-download host: uploads and cross-MCP relay stream without a whole-file buffer; App downloads stream through the browser's native download manager instead of a page Blob. Prepared means ready to start, not already downloaded. Completion reports verified response transfer, not successful persistence to the user's disk. Inline byte previews remain bounded to 2 MiB.
- Source snapshots and destination staging need sufficient disk space. Existing 30-second preparation RPC/remote lease, streaming progress timeouts, cancellation, commit uncertainty and no-automatic-replay behavior remain. Slow storage, proxy limits or very large preparations can still fail; no unlimited-size/throughput or resumable-transfer guarantee is made.
- Upgrade the chat-ai host and all participating staff-mcp endpoints, reconnect MCP and reopen file Apps. Versions through 2.0.4 still enforce the old remote limit. Extension protocol/data versions and native dependency pins are unchanged; no persistent data migration is needed.

## 2.0.4 — 2026-10-27

- Add opt-in Windows native ConPTY terminal support; all extensions remain off and native PTY code stays unloaded by default. Require Windows build >= 18309 plus compatible native binaries and an executable shell. Keep `node-pty@1.2.0-beta.18` unchanged; N-API/prebuild availability does not validate every OS/architecture. Windows arm64 and macOS remain untested on real hardware; no musl/Alpine terminal support is promised.
- Prefer executable `pwsh.exe`, then `powershell.exe` with `-NoLogo -NoProfile`, then `ComSpec`/system `cmd.exe` with `/d`. Linux retains executable `$SHELL` or `/bin/bash` with `-i` and normal profiles. No public `--shell` option is added; Windows profile suppression does not guarantee absence of shell/program/system history.
- Keep Linux raw fd input/EAGAIN handling. Windows uses the ConPTY UTF-8 input pipe with one bounded write in flight; input ACK follows its write callback, not local buffering or command execution. The public raw-binary data v1 protocol and generic host byte handling are unchanged. Windows close releases the owned ConPTY console best-effort, without rollback or guaranteed cleanup of all detached descendants.
- Check Docker extension prerequisites by Linux-container daemon OS rather than launcher OS, with verified local Unix-socket/`npipe` endpoint checks for HTTP/stdio, allowing eligible Windows Docker Desktop Linux containers. HTTP/stdio still require reachable host loopback; stdio publishes an extra data port. Reverse needs no such stdio mapping but retains Linux-container and existing-mount prerequisites. Translate Windows drive/UNC allowed directories into the POSIX container namespace without bypassing staging protection.
- Pair with chat-ai commit `88f86aeb136bc2440da35b540868f9606d34ac58` or a descendant for Bash/CMD/PowerShell command-generation and copy support: ordinary safe arguments need no unnecessary quotes, special values use shell-specific quoting, and values that cannot be safely inlined produce an error rather than a misleading command. These UI changes are delivered by chat-ai, not the npm package. The Windows features require staff-mcp 2.0.4; dependency pins, extension protocol versions and data formats are unchanged.

## 2.0.3 — 2026-10-26

- Pin optional `node-pty` exactly to official prerelease `1.2.0-beta.18`, with Linux x64/arm64 N-API prebuilds for glibc >= 2.28. System libraries such as `libstdc++`/`libgcc` and an executable shell are still required; no user image upgrade or musl/Alpine terminal support is promised. Docker still mounts the host package/`node_modules`; normal-install prebuilt delivery does not eliminate build leftovers or platform mismatches.
- Keep terminal off and native PTY unloaded by default. Explicit terminal requests now fail startup when platform/native/shell prerequisites are unavailable, including non-Linux Docker launchers and unsupported stdio Docker data topologies, rather than silently disabling terminal. Files degradation remains unchanged.
- Send only responses to recognized standard MCP pings on a separate bounded POST lane; all other POSTs remain FIFO, with no replay, protocol version/flag change or timeout extension. Add queue-wait/POST-elapsed slow-send metadata diagnostics and host App resource-read timing/byte-count diagnostics, without tokens, URLs or bodies.
- Upgrade the matching chat-ai host to commit `352bdb931bff38b5693dd386cd7584220571fd6b` or a descendant for stable App windows during loading/disconnection, cancellation and reopening cleanup, and accessible homepage close controls. These UI changes are delivered by chat-ai, not by the npm package. Extension protocol versions and data formats remain unchanged.

## 2.0.2 — 2026-10-26

- Report reverse control closure with fixed reasons, POST status/byte count/duration and bounded network error codes, without logging payloads, credentials or URLs. No retry/replay behavior changes.
- Reuse workspace (`main`) and deduplicated allowed directories (`extra1`, `extra2`, …) for the optional file UI; explicit `-d` grants now appear there, with no automatic system-root authorization or separate Docker file-root mounts. Path, symlink, protected staging and write safety checks remain unchanged.
- Remove `--file-root` / `ExtensionOptions.fileRoots` and `--shell` / `ExtensionOptions.shell`. PTY selects an executable absolute `$SHELL`, otherwise `/bin/bash`, preserving normal HOME and workspace cwd. Removed flags fail as unknown options; update launch configurations without a compatibility fallback.
- Fix HTTP capacity internally at 64 sessions and remove MCP idle expiry, activity probes and `--http-max-sessions` / `--http-session-idle-ms` configuration. Pending startup and failed/pending cleanup still occupy capacity; DELETE, initialization failure, shutdown and data-session cleanup remain. Clients must close unused sessions. Child MCP limits/start/stop and reverse timeout defaults are unchanged.

## 2.0.1 — 2026-10-26

- Resolve reverse data paths using the configured reverse origin, without requiring a public URL setting on chat-ai. Upgrade chat-ai and staff-mcp together; extension protocol versions remain v1.
- Preserve exact-session, same-origin, ticket and binding checks; HTTP/stdio endpoint behavior is unchanged.
- Require release tags to reference commits already contained in `master` before npm publishing.

## 2.0.0 — 2026-10-26

### Features

- Opt-in file workspace with version-checked editing, attachments and prepared uploads/downloads, independent of model tools.
- Opt-in human terminal with Linux PTY support and rendering-consumption acknowledgements; terminal bytes stay out of model context and chat history.
- Shared raw HTTP data sessions for files and streams across supported stdio, Docker, HTTP and reverse connections.

### Fixes

- Preserve Windows drive/UNC roots during file-path validation without relaxing junction, symlink or workspace boundaries.
- Keep Docker tool caches writable for same-uid non-root containers and isolated from host-native binaries.
- Isolate unavailable or incompatible optional extensions from healthy standard MCP tools/resources/prompts; all extensions remain off by default.
- Tighten HTTP authentication, session capacity/idle expiry and owned-resource cleanup; surface uncertain file publication and potentially incomplete terminal output without automatic replay.

### Breaking changes

- Reverse and extensions require chat-ai commit `66461d16090456d6f1fee21ce19088dceefd6658` or a later compatible version, including matching host/descriptors/UI assets.
- The old reverse handshake is incompatible even with extensions disabled. There is no old-protocol compatibility mode, legacy data fallback or automatic transfer/input resumption after disconnect.
- Node.js **22.22.2 or newer** is required, including in Docker. Linux/local Linux Docker are the primary full-extension environments. Windows native standard MCP (stdio/HTTP) and Windows Docker standard MCP have been validated; non-Linux Docker launchers disable extensions. macOS is untested.
- Standard stdio/Streamable HTTP tools, resources and prompts remain supported. No Chat8/schema9/format7/share protocol2 data migration is required.

### Upgrade

1. Finish in-flight operations and back up normal configuration; no data migration is needed.
2. Upgrade the matching chat-ai host first, then staff-mcp 2.0.0, coordinating downtime for reverse connections.
3. Reconnect MCP, reopen Apps and explicitly enable the extensions you want (`--extensions files`, `--extensions terminal`, or `--extensions files,terminal`).
