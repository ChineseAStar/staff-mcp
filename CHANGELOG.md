# Changelog

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
