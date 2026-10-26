# Changelog

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
