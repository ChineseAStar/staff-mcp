# staff-mcp

[English](./README.md) | [简体中文](./README_zh.md)

A next-generation Model Context Protocol (MCP) server that transforms any AI assistant into a highly capable, container-aware, and role-adaptable digital employee. 

It provides secure file management, shell execution, LSP-powered code intelligence, a 5-tier Skill & Profile ecosystem, and a revolutionary **Docker Transparent Proxy Mode**.

---

## SDK and protocol compatibility — 2.2.0

staff-mcp 2.2.0 (2026-11-08) uses the split MCP SDK 2 packages (`client`, `server`, `core` 2.4.0 and `node` 2.1.2). The release target is Linux x64. Publishing the npm package does not update the chat-ai runtime pin, deploy a host or upgrade running endpoints; those are separate steps. This documentation does not claim all-platform, company-network or full end-to-end acceptance.

- Stdio, reverse and direct HTTP accept legacy clients and modern `2026-07-28` clients through the official SDK. Legacy HTTP keeps its existing authenticated sessions. Modern HTTP calls the server factory for each request, without `Mcp-Session-Id`, a pooled MCP server or a hidden session header. Ordinary tools retain their shared process state and existing permissions; request facades are not separate OS/user sandboxes.
- Files/Terminal Apps remain available on modern HTTP through the public **DATA2 business binding** contract: a server-minted control capability, a 90-second lease, and independently owned files/PTY/data state. APPS/FILES/STREAMS stay at version 1. Stdio/reverse (both eras) and legacy HTTP keep DATA1. Upgrade the host and staff together for DATA2; use the paired chat-ai version below and explicitly update its bundled staff dependency.
- Modern resource subscriptions retain canonical URI/root/private/symlink admission and directory-descendant invalidation. A thin public transport adapter observes acknowledged URI interests; the SDK still owns filtering, acknowledgements, subscription IDs and cancellation. HTTP interests live only as long as their response streams, with one endpoint event source to avoid duplicate notifications.
- Nested MCP clients negotiate with new and old servers in the original process. An unknown startup command is not launched again for a disposable protocol probe; a peer that exits on discovery fails startup rather than being respawned automatically.
- Extension discovery uses `capabilities.extensions` when present and only falls back to `experimental` when the new container is absent. An empty or invalid new grant does not inherit an old grant. Modern requests carry their own capabilities; they cannot borrow another request's capability context.
- Tools keep complete, guarded pagination and per-call output validation through public SDK APIs. File commit/status, cancellation, existing file/PTY leases and no-replay rules are unchanged; DATA2 adds its separate business-binding lease. Standard Skills publication uses the official SDK Skills extension (Beta); legacy `skill`, `read_skill_file` and prompts remain available. The compatible host advertises authorized skill names, descriptions and sources before the first model request and loads content through two read-only built-ins.

## Compatibility and coordinated upgrades

**Version 2.2.0:** adds MCP SDK 2, modern `2026-07-28` serving, modern HTTP DATA2 business bindings, standard Skills and the legacy skill-tool compatibility marker. Pair with chat-ai `tmp/inner-mcp-stdio` commit `1d659874f4da0540274ea454f016cebaa6838945` or a compatible successor, including matching host/descriptors/UI assets. Older host commits listed for historical releases below are not sufficient for modern HTTP DATA2 or the standard Skills integration. This is a coordinated control-wire upgrade, not a new persistent data format; it adds no skill execution approval or automatic operation/input replay. The 2.1.0 container and file-resource behavior below is retained.

Version 2.1.0 removes the workspace-only boundary from ordinary file tools and command working directories inside an explicitly marked container. Host mode remains restricted to configured directories. Files App/resource roots and file-transfer RPCs still use the published roots; private staging, root protection and file transaction rules remain in force. This is not permission to access the Docker host: OS user permissions and mounts remain the boundary, and writable workspace mounts are persistent. `STAFF_MCP_IS_DOCKER=1` is an operator-controlled launch assertion, not something inferred from the filesystem or selected by a model request. Do not set it for Host processes.

**Version 2.1.0:** file Resource discovery is template-only, with one unchanged URI template per configured root and an empty concrete list. Use the file App's explicit file/directory actions instead of top-level `@` quick picks. This replaces the concrete file directory from 2.0.7 and does not update running endpoints. Pair with chat-ai commit `77369efdeeb9defce218fad95145b4dcae99724d` or a compatible descendant for container-mode propagation and resource authorization safeguards. See [file Resources and upgrade precautions](docs/file-manager.md#standard-file-resources-and-attachments).

**Version 2.0.7:** adds bounded, no-port stdio data frames for local and Docker connections, with no automatic HTTP fallback or replay. Pair with chat-ai commit `5bfa6a4321d258e5129b250da248adff96b6ad42` or a compatible descendant for the matching protocol and permissions. The host's formal bundled dependency update will follow in a compatible descendant; installing this npm package alone does not update it. That DATA1 release did not change HTTP/reverse wire or business authorization; current modern HTTP uses DATA2 as described above. With an older stdio host, optional data-dependent Apps/transfers may be unavailable while healthy standard MCP tools/resources/prompts remain usable.

Version 2.0.7 also adds shared Bash initialization through `STAFF_MCP_SHELL_INIT` for commands and new PTYs (never sourced by the management Node process), common-language syntax and Markdown code highlighting, local reading fonts and an adaptive right-side outline/narrow-view dropdown, soft-wrapped text, and cleaner workspace/file/reading toolbars, root-targeted menus and file tabs. The terminal App removes its duplicate close button in favor of the host App lifecycle. See [file manager](docs/file-manager.md), [terminal](docs/terminal.md) and [CHANGELOG](CHANGELOG.md).

Docker template/user-script orchestration, short managed staff commands and dark chat rendering are host features, not capabilities supplied by this npm package alone. The 2.0.7 verification covered Linux x64 with Chromium; 2.2.0 adds no Windows/macOS/musl validation or support claims. Remote-network availability must still be verified in the target deployment.

**Version 2.0.6:** adds reference-only attachments, Markdown draft previews, directory uploads/ZIP downloads and opt-in large-text previews (automatic up to 512 KiB, read-only above 2 MiB, download-only at or above 5 MiB). Binary files use a neutral preview state and failed rereads preserve unsaved drafts. Pair with chat-ai commit `972d26e2df5998f67dbcbab96685f72ef1fadf3cbbf` or a compatible descendant. Background terminal heartbeats, upload HTTP diagnostics, command editing and App merging are host updates, not features supplied by this npm package alone. See [file manager](docs/file-manager.md) and [CHANGELOG](CHANGELOG.md).

**Version 2.0.5:** removes the 100 MiB file transfer cap. Upgrade chat-ai to commit `cfd7a2815f46d105b2da01d3980987c818ab0d39` or a compatible descendant for streaming App uploads, native browser downloads and cross-MCP relay. Upgrade all participating staff-mcp endpoints as well; inline previews remain limited to 2 MiB. See the large-file limits and release checklist below.

**Version 2.0.4:** adds Windows native ConPTY terminal support and extensions for eligible Windows Docker Desktop Linux containers. It retains the Linux PTY prebuild delivery, explicit terminal startup errors and reverse heartbeat fixes from 2.0.3. Upgrade chat-ai to commit `88f86aeb136bc2440da35b540868f9606d34ac58` or a descendant for the matching Bash/CMD/PowerShell command generator and earlier App window fixes.

**Upgrade from 2.0.3:** the Windows features require staff-mcp 2.0.4; updating chat-ai alone does not add them to an existing staff process. The `node-pty` dependency pin and extension protocol versions are unchanged.

**Breaking release:** reverse connections and optional extensions require a matching chat-ai host: the host must implement reverse v1 and the session-relative data paths described below. Upgrade the host, staff-mcp, descriptors and UI assets together.

Standard stdio/Streamable HTTP tools, resources and prompts remain supported. Extensions are **all off by default**; optional discovery/data negotiation failures preserve an otherwise healthy standard MCP connection. Explicitly requesting terminal with unavailable platform/native/shell prerequisites fails startup instead of silently disabling it; files degradation is unchanged. The old reverse handshake itself is incompatible, even with extensions disabled: extension degradation cannot replace the paired reverse upgrade. There is no old-protocol compatibility mode, automatic transfer resumption or input replay after disconnect.

No Chat8/schema9/format7/share protocol2 data migration is required.

1. Finish in-flight operations and back up your normal configuration; no data conversion is needed.
2. Upgrade the matching chat-ai host first, explicitly update its bundled staff dependency, then upgrade staff-mcp endpoints to 2.2.0, coordinating downtime for reverse connections.
3. Reconnect MCP, reopen Apps and explicitly enable only the extensions you want.

See [CHANGELOG](CHANGELOG.md) for the release summary.

## 🚀 Quick Start

Requires **Node.js 22.22.2 or newer**, including inside Docker images.

Current source supports Linux PTY and Windows native ConPTY, subject to native loading and executable-shell checks. Windows build **18309 or newer** is necessary, not sufficient. Windows Docker Desktop with a verified local Linux-container daemon can enable files/terminal; the launcher OS alone does not decide availability. **Windows arm64 and macOS have not been validated on real hardware; musl/Alpine terminal support is not promised.** Path translation or a shipped N-API prebuild is not a platform-support guarantee.

Run staff-mcp with an explicit package version:

```bash
npx --yes staff-mcp@2.2.0 --working-dir /path/to/your/project
```

For a source checkout, install dependencies and build before using the absolute entrypoint in the examples:

```bash
npm ci
npm run build
```

Replace `/path/to/staff-mcp` with that checkout/build directory. Docker still read-only mounts the host package and `node_modules`, not an isolated container dependency installation. The optional dependency `node-pty` remains pinned exactly to the official prerelease `1.2.0-beta.18`, which includes N-API prebuilds for Linux x64/arm64 with glibc >= 2.28. The runtime still needs system libraries such as `libstdc++` and `libgcc`. This addresses prebuilt delivery for normal installs, not arbitrary local build leftovers or architecture/libc/platform mismatches; N-API does not remove those limits. No user image is upgraded automatically; terminal support is not promised for musl/Alpine.

### 1. Standard Host Mode
Run directly on your physical machine or virtual environment.
```bash
node /path/to/staff-mcp/dist/src/index.js --working-dir /path/to/your/project
```

### 2. Docker Transparent Proxy Mode (Cyber-Shell)
Run staff-mcp inside a compatible Docker image while keeping standard MCP control connected to the host. The wrapper mounts the project and package; image startup, Node/native ABI/libc and mount permissions still apply. Extension preflight checks the daemon OS and endpoint, not the launcher OS: all Docker extensions require a Linux-container daemon; HTTP/stdio additionally require a verified local Unix socket or named pipe (`npipe`) endpoint. This allows Windows Docker Desktop Linux containers, subject to the existing package/native-library and bind-mount prerequisites; Windows containers are not supported for extensions, and macOS is untested.

```bash
# Standard MCP only, no terminal: debug inside an Alpine container
node /path/to/staff-mcp/dist/src/index.js --docker node:22-alpine

# Perform security analysis inside a custom reverse-engineering image
node /path/to/staff-mcp/dist/src/index.js --docker chineseastar/security:latest --profile android-reverse
```

### Docker-compatible Podman launchers

The source preflight also accepts Podman's `host.os` from `docker info --format '{{json .}}'`, alongside Docker's `OSType`. This fixes the Linux reverse-mode startup check when the executable named `docker` on PATH is a Podman-compatible wrapper. Shell aliases alone do not affect this launcher; it invokes the executable directly. The selected executable/connection is queried once, with no engine fallback after permission or connection failures.

This is not a blanket Podman support claim: HTTP/stdio retain the existing verified-local Docker endpoint check, with no new native Podman connection discovery. Container startup, bind mounts, Node/native PTY loading and cleanup must still work on the target engine/image. No host protocol or chat-ai update is needed for this preflight change alone, and no image or running endpoint is updated automatically.

Failed CLI checks now report `DOCKER_CHECK_FAILED` (with a safe exit code or known process error code), `DOCKER_CHECK_TIMEOUT` (the existing 2-second deadline), or `DOCKER_INFO_INVALID`. `DOCKER_UNSUPPORTED_PLATFORM` is reserved for a valid non-Linux OS result. Output, arguments and endpoint details remain suppressed because they may contain credentials. Explicit terminal requests still fail startup; files-only requests retain their existing extension-degradation behavior.

### 3. Claude Desktop Configuration
Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "staff-mcp": {
      "command": "node",
      "args": [
        "/path/to/staff-mcp/dist/src/index.js",
        "--working-dir",
        "/path/to/your/project"
      ]
    }
  }
}
```

### 4. Reverse MCP Mode (Intranet Penetration)
Connect outward from behind NAT/firewalls to chat-ai's existing Web entrypoint, without an inbound listener on staff. Control uses SSE + POST; remote-initiated raw HTTP GET/PUT carries file/terminal bytes on that same Web port. chat-ai provides the current session data path, which staff resolves against the existing `--ru` origin; no public-origin environment variable on chat-ai is required. Reconnect creates fresh sessions and never replays tool calls, transfer handles or terminal input.

```bash
node /path/to/staff-mcp/dist/src/index.js -t reverse \
  --ru https://chat.example.com/api/mcp/reverse \
  --rt your_secure_token_here \
  --rn my-workstation
```

The reverse client resolves the exact session data path against its existing `--ru` origin; chat-ai does not need `MCP_REVERSE_URL` to enable Apps. Only that session path or the already-supported exact absolute URL is accepted, before any data request or business admission; ticket, binding, authorization and redirect restrictions remain unchanged. Direct HTTP still uses an absolute data endpoint; stdio uses same-connection frames without an endpoint. Upgrade chat-ai and staff-mcp together for this fix; no version-specific compatibility layer or extra negotiation flag is added.

### 5. Authenticated HTTP Mode

HTTP authentication is optional. Set `--ht` / `--http-token`
to a strong, random token to require authentication:

```bash
node /path/to/staff-mcp/dist/src/index.js -t http -p 3000 \
  --http-token your_secure_token_here --working-dir /path/to/your/project
```

When a token is configured, clients must send `Authorization: Bearer <token>` on every MCP control request.
For a full Authorization-header field, enter `Bearer <token>`; for a Bearer-token
field, enter only the token. Raw tokens without the `Bearer` scheme are rejected.
Missing or incorrect credentials return HTTP 401, including requests with an
existing `mcp-session-id`. Authentication covers `/mcp` and the legacy `/sse` and
`/messages` routes. CORS `OPTIONS` preflight remains public and cannot invoke MCP.
The raw `/mcp/data/...` routes use their negotiated channel Bearer token plus
`X-Data-Binding`, not the shared MCP control token or the DATA2 owner proof.
Modern HTTP business RPCs additionally require the public DATA2 `control` capability;
this does not replace HTTP authentication.

Omitting `--http-token` leaves MCP control on the HTTP listener unauthenticated.
Anyone who can reach such a server can invoke its tools, so use this mode only
on trusted networks. An explicitly empty token or one containing whitespace is
rejected at startup. `--docker` forwards `--http-token` to the container command
only when provided.
Command-line tokens may be visible in shell history and process listings; keep
access to those restricted. Stdio and reverse use separate authentication paths;
`--reverse-token` does not configure HTTP auth.
Use HTTPS through a reverse proxy for remote access, since plain HTTP does not
protect the token in transit. This is a shared server token, not an OAuth flow.

---

## Reverse v1 and protocol boundary

The authoritative custom protocol is `chat-ai/docs/protocol/README.md` at the compatible host version specified above. chat-ai, staff-mcp and third parties can implement it independently; no extension SDK is required. The official SDK owns standard MCP protocol handling; ordinary tools/resources/prompts retain their business behavior and permissions. There is no old FTE chunk or WS fallback, and no chat database migration.

Reverse GETs `<base>/sse` with `Authorization: Bearer <token>` and `X-MCP-Server-Name`; an SSE endpoint event supplies the POST message URL. SSE message events contain ordinary MCP JSON-RPC, not a private envelope. Explicit HTTP and HTTPS are accepted; HTTP logs one plaintext warning per start and does not protect tokens or payloads. Use HTTPS on untrusted networks; HTTPS verifies CA and target identity without automatic downgrade. The configured base URL has no credentials, query or fragment. No WebSocket upgrade, gateway process, launcher or private host leg is required. SDK initialization, data-session readiness and current user authorization remain separate checks; short-lived connections do not reset exponential backoff.

Only responses to recognized inbound standard MCP `ping` requests use a separate bounded POST send lane. All other POSTs remain FIFO; no request/input replay, protocol version change or extra flag is added, and timeouts are not extended. Slow-send diagnostics distinguish queue wait from POST elapsed time using metadata only, never tokens, URLs or bodies. The host also records App resource-read timing and byte-count metadata.

Optional CLI timeouts (milliseconds, forwarded in Docker mode):

- `--reverse-connect-timeout`: 15000; 0 disables only the SSE connection deadline.
- `--reverse-initialization-timeout`: 15000; must be positive. Starts after the SSE connection and endpoint are established, not while waiting to connect; remains active when the connection deadline is disabled.
- `--reverse-read-timeout`: 45000; heartbeat liveness, not tool execution duration.
- `--reverse-stable-time`: 30000; stable lifetime before retry reset (0 resets immediately).

`skill` / `read_skill_file` continue returning `_meta: { persistent: true }`. chat-ai consumes this host metadata hint, not `structuredContent.persistent`; it is not an MCP storage option. This does not relax the new reverse/extension compatibility requirement or change Chat8/schema9/format7/share protocol2.

The two reverse transport sources (`src/reverse/SseTransport.ts` and chat-ai's `ReverseSseTransport.ts`) can later be extracted into MCP Client (host)/Server (remote) SDKs: SDK/standard-library imports plus injected URL/endpoint, headers and fetch, with transparent JSON-RPC and no data-protocol interception. No SDK package is being split out now. `src/reverse/http.ts` (Undici/TLS/proxy policy), `src/transports/reverse.ts` (server factory, extension/data setup, initialization and reconnect backoff), and host Web auth/management stay in integration, outside the pure transport boundary. The endpoint uses `session`, with no old `sessionId` compatibility or replay.

## 🛠️ Core Capabilities

The behavior below describes staff-mcp 2.2.0. Extensions remain opt-in; npm publication alone does not upgrade a host or running endpoint.

Extensions are **all off by default**. Use `--extensions files`, `--extensions terminal`, or `--extensions files,terminal`; apps/data dependencies and terminal's streams v1 manifest are added automatically, not selected separately. Disabled features advertise no manifest entry and register no corresponding UI Resource or business handler. With both off there is no extension manifest or application data listener/session; ordinary MCP tools and non-UI Resources remain. HTTP mode still opens its normal MCP listener.

```bash
# Files only, with the default main root at --working-dir
node /path/to/staff-mcp/dist/src/index.js --extensions files -w /workspace
# Terminal only; does not enable the file app
node /path/to/staff-mcp/dist/src/index.js --extensions terminal
# Both apps; explicitly authorize assets for tools and the file app
node /path/to/staff-mcp/dist/src/index.js --extensions files,terminal -w /workspace \
  -d /srv/assets
# Explicit full-filesystem authorization for tools and files on a suitable Linux host (not a default)
node /path/to/staff-mcp/dist/src/index.js --extensions files -d /
```

With files enabled, roots reuse the standard tool authorization: `main` is `--working-dir`, followed by the resolved, deduplicated `--allowed-dir` directories in order as `extra1`, `extra2`, etc. Explicit `-d` authorization is therefore visible in the file UI as well as tools; no system root is added automatically. Relative directories resolve from the launching process cwd. `-d /` explicitly authorizes the filesystem visible to staff for both tools and files, subject to OS permissions; it grants no OS privileges or shell sandbox. The library accepts [`ExtensionOptions`](src/extensions/config.ts): `{enabled?:('files'|'terminal')[]}`, with `enabled` defaulting to `[]`.

`--file-root`, `--shell`, `--http-max-sessions` and `--http-session-idle-ms` have been removed and now fail as unknown options. Remove them from launch configurations; use `-w` / `-d` for file authorization. Without shell initialization configured, Linux uses the normal `SHELL` environment; Windows selects PowerShell or CMD automatically as described below. There is no compatibility fallback.

### Independent file workspace

With `--extensions files`, discovery uses `capabilities.extensions["cc.qqxing/extensions"]` (falling back to `experimental` only when the new container is absent), followed by `cc.qqxing/apps/v1/list`, independently of model Tools. APPS/FILES/STREAMS remain v1. DATA is v1 on stdio/reverse in either MCP era and on legacy HTTP, but v2 on modern HTTP. The App and `transfer_file` share files v1 and the same transport-neutral DataSession as terminal, owned by the connection for DATA1 or by the public business binding for DATA2. Stdio explicitly configures `{binding,transport:"stdio"}` and requires `{transport:"stdio"}` in response; control and bounded Base64 data frames share one FIFO writer, with no data listener, endpoint or HTTP ticket. Each frame carries at most 64 KiB of decoded bytes and each channel/direction has a 256 KiB consumption window. Direct HTTP/reverse retain raw channel wire on the MCP/host Web port respectively. Modern HTTP configure/open and associated business RPCs use DATA2 control authorization, not the unchanged DATA1 control contract. ACK follows real consumption, not SDK write/drain; file ACK is not commit. Old/new stdio data mismatch disables only optional data-dependent Apps/transfers on a healthy MCP connection, with no automatic HTTP fallback or replay. Ordinary tools and non-UI Resources remain available; roots do not broaden tool permissions. See [file manager](docs/file-manager.md).

New Apps reusing supported RPC/Resources, files or streams need only their own descriptor, business handlers and UI, not host-core business branches. Truly new host permissions/capabilities require explicit registration at the host discovery/validation, server resource-module and browser-bridge composition roots. Unknown capabilities hide that App; malformed known ones remain validation errors.

### Human terminal (explicit extension opt-in)

`--extensions terminal` needs Linux or Windows (build >= 18309), a loadable optional `node-pty`, an executable shell and negotiated streams v1 and DATA2 on modern HTTP (DATA1 elsewhere), with a usable duplex dataSession over supported local stdio/Docker, direct HTTP or reverse. Unavailable platform/native PTY/shell prerequisites make an explicit terminal request fail startup with an error, including when files is also requested; terminal is not silently omitted. The default disabled state never loads native PTY code. Without shell initialization configured, Linux uses a valid absolute executable `$SHELL`, otherwise `/bin/bash`, with `-i` and normal startup profiles unchanged; if unavailable it fails without further shell fallback. Windows uses native ConPTY, preferring executable `pwsh.exe`, then `powershell.exe` with `-NoLogo -NoProfile`, then `ComSpec`/system `cmd.exe` with `/d`; there is no public `--shell` option. The shell inherits staff's environment except exact internal control keys documented in the [terminal contract](docs/terminal.md). Windows profile loading is disabled, but shell/program/system history recording is not guaranteed absent. chat-ai uses the existing current-chat MCP grant and same-origin browser requests, with no extra terminal permission switch or high-risk confirmation. Terminal follows the host site's HTTP/HTTPS deployment policy without a terminal-specific TLS gate or origin allowlist. HTTPS is recommended for the entire site to protect login sessions, tool calls and terminal traffic; allowing HTTP does not encrypt those requests.

Deployment may set `STAFF_MCP_SHELL_INIT` to an absolute readable Bash script path inside the staff environment (not an MCP argument). When set, Linux `/bin/bash` is required with no `sh` fallback: each `execute_command` and each new PTY sources the same file before user input, preserving aliases, functions, exports and `cd` in that shell. Initialization stdout goes to stderr, not MCP protocol stdout; source diagnostics are suppressed in favor of a fixed failure message, and a nonzero source result prevents the command or interactive prompt. PTYs use a private bootstrap instead of the normal user Bash rc file; `BASH_ENV` is cleared and the init-path marker remains available to descendants. The management Node process never sources the file. Script changes affect only subsequent commands/new PTYs, not existing shells; this is repeated executable initialization, not a one-time install or an environment key/value parser. No automatic retry/replay is added; without the variable all previous shell selection/startup behavior, including Windows, remains unchanged. See [terminal contract](docs/terminal.md#shared-shell-initialization).

The PTY starts at the staff workspace (`main`) by default, independently of file roots, and runs under the staff process's operating-system identity: its starting root/cwd is **not a sandbox** and shell filesystem/network effects are not restricted by file-tool path checks. Terminal bytes never enter model context or chat history. Each stream uses one same-origin browser-to-chat-ai WebSocket at `/api/mcp/app-stream` (`chat-app-stream-v1`) for input, output, resize, presence and real xterm consumption ACKs. The backend remains the shared DataSession (stdio frames or raw HTTP). Browser presence refreshes every 10 seconds with a separate 120-second host deadline; the host generic stream module schedules remote renewal from each returned lease (staff defaults to 30 seconds). Opening the Shell App starts one PTY without another open button or confirmation. Exit, PTY failure or disconnection leaves the app shell for manual reconnect; ordinary hidden views keep read/ACK/presence but reject new input and resize. Actual page exit, close, revocation or expiry cleans up; cleanup is best effort, not rollback. Linux retains TERM-to-KILL cleanup; Windows closes the owned ConPTY console. Neither promises to remove all detached descendants or undo filesystem/network effects.

Current descriptors and iframe assets keep **bridge v1** with explicit `scope:"workspace"` for files and `scope:"chat"` for terminal. The file App declares `capabilities.files:{version:1,upload:true,download:true}`; terminal declares `capabilities.streams:{version:1,purpose,create,renew,status,close,commands}` and requires streams v1 plus the transport-appropriate DATA version (2 on modern HTTP, 1 elsewhere). Its business RPC and data purpose remain `cc.qqxing/terminal`; host lifecycle methods use generic envelopes and opaque metadata, not PTY fields. The 2.0.0 extension contract requires matching host/descriptors/assets; deploy them together and reopen Apps, with no legacy compatibility path. Files-v1 adds its own `stat` for force-copy version checks, independent of the file-manager App; byte budgets owned by chat-ai are not remote business limits. See the [host/bridge boundary](docs/file-manager.md#host-boundary-and-bridge-v1).

Backpressured PTY exit may have incomplete output. Current source reports remote `status.error:{code:"OUTPUT_INCOMPLETE",message:string}` and host generic stream frame `incomplete?:boolean` / `error?:{code:string,message:string}` for abnormal close/status, with UI warning handling. The generic boolean is `incomplete`; the app-local terminal adapter maps it to its own presentation warning. It is not a remote status field. These diagnostics detect possible loss; they do not recover missing bytes or guarantee lossless output, even with exit code 0 or EOF. See [Terminal UI contract](docs/terminal.md).

### 1. Seamless Containerization (`--docker`)
Never pollute your host machine again. By simply appending `--docker <image>`, `staff-mcp`:
- Instantly injects itself into the container via read-only bind mounts (no `npm install` inside the container).
- Automatically translates Windows/Mac paths to Linux container paths.
- Names containers after their launch context (e.g. `staff-mcp-myproj-3000-a1b2c3` = workspace `myproj`, HTTP port `3000`, random suffix `a1b2c3`), so multiple sessions are easy to tell apart in `docker ps`.
- Mounts a dedicated Docker tools cache (`<staff-global>/tools/docker`) at `/opt/.staff/tools`, alongside the existing skills/profiles mounts. A matching non-root uid can write tools without creating directories in the image, and container-installed tools do not overwrite the host tool cache. Existing mount permissions still apply; no automatic chown or chmod.
- Allows `--docker-args` for compatible hardware/environment settings (e.g., ADB USB debugging or GPUs), retaining managed container lifecycle restrictions. Stdio data no longer imposes loopback-publication or network-mode restrictions.

Docker stdio carries control and data through the existing pipe: no `39173` mapping, application-data listener, endpoint, HTTP ticket or bootstrap metadata. The wrapper retains exact owned-container checks, workspace/package/tools/skills/profile mounts, permissions and cleanup. Extensions remain off by default; without negotiation no DataSession is created. HTTP retains its normal MCP listener and HTTP/reverse raw channel wire is unchanged; modern HTTP business control uses DATA2 as described above.

Docker files reuse only the existing workspace (`/workspace`, root `main`) and allowed-directory bind mounts; no separate file-root mounts are created. Explicit `-d /` is deliberately broad host access through the allowed-directory mapping, subject to Docker/OS permissions and topology. Terminal cwd stays `/workspace`, independent of extra roots.

Docker reuses the allowed-directory mounts for both tools and the file UI. A host filesystem root such as `/` is mapped to `/opt/staff-allowed/root-N` because Docker forbids mounting onto container `/`. Windows drive/UNC allowed directories are translated into a POSIX container namespace rather than passed through as Windows paths. Inner `-d` paths and protected staging aliases follow the same mapping; overlapping mounts do not bypass staging protection.

Removing the stdio port does not expand daemon or platform support. Extension preflight still requires a Linux-container daemon; HTTP/stdio still require a verified local Unix socket or `npipe` endpoint. HTTP also needs reachable host loopback; reverse retains valid existing mounts. Windows Docker Desktop Linux containers may meet these prerequisites, not arbitrary Desktop/remote contexts. Mount uid/gid, workspace/global-directory access, package/native ABI/libc and shell requirements remain, with no automatic chown, permission relaxation or browser-user identity switch. An explicit terminal request fails unmet prerequisites; files-only keeps warning-and-disable degradation. Optional data configure failure does not terminate healthy MCP control, fall back to HTTP or replay operations. A `--network=none` stdio check proves no data-network dependency, not remote Docker availability, hostile-container isolation or full platform validation. Normal exit/signals still clean the owned container; cross-restart recovery is not promised.

### Optional negotiation failures versus explicit terminal startup errors

Availability is determined separately for files, terminal and the per-connection data channel. A missing terminal runtime fails startup only when terminal is explicitly requested; with terminal disabled no native PTY is loaded. An unavailable configured file root still disables the optional file extension while preserving the standard workspace tools/resources. Unknown or incompatible extension versions do not enable their handlers or Apps. chat-ai keeps successfully initialized standard tools/resources/prompts if optional Apps discovery or data configuration fails. Warnings go to stderr, never stdio JSON-RPC stdout.

This is not an authentication or lifecycle bypass: malformed CLI arguments, Docker launch failure, invalid credentials, and failed standard MCP transport/initialization remain errors. Workspace/global-mount access errors still fail the affected startup or file/tool operation; optional-extension degradation does not grant access or promise that every directory is prevalidated. Old/new incompatible reverse control protocols still require paired upgrades; optional capability degradation does not make those wire protocols compatible. No failed or uncertain file commit/tool/terminal input is automatically retried.

### 2. Skill & Profile Ecosystem (`--profile`)
`staff-mcp` acts as an "AI Workspace Configurator". It uses a **5-tier Cascade Resolution** architecture to load role-specific skills (SOPs & Prompts) dynamically, all under the unified `.staff` directory convention:

| Priority | Tier | Path | Watch |
|:---:|:---|:---|:---:|
| 1 (Highest) | Project | `<cwd>/.staff/skills` | ✅ 实时生效（自动创建目录） |
| 2 | Project Profile | `<cwd>/.staff/profiles/<profile>/skills` | 🔄 需重启 |
| 3 | Global Profile | `~/.staff/profiles/<profile>/skills` | 🔄 需重启 |
| 4 | Global | `~/.staff/skills` | 🔄 需重启 |
| 5 (Lowest) | Built-in | `staff-mcp/builtin-profiles` | 🔄 需重启 |

**Profile** is an additive parameter — tiers 1 and 4 are always loaded regardless of profile. Tiers 2, 3, and 5 append profile-specific paths. When skills with the same name exist at multiple tiers, the higher-priority one wins (merge with override, not whole-tier replacement).

Only the project-level `.staff/skills/` directory is live-watched. The directory is auto-created on startup if absent, and auto-recovered if deleted at runtime. Other tiers have no automatic change notification; explicit skill calls and standard discovery re-read current selections. Restart refreshes the legacy tool/prompt descriptions for those tiers.

Switch roles on the fly:
```bash
node /path/to/staff-mcp/dist/src/index.js --profile default
node /path/to/staff-mcp/dist/src/index.js --profile android-reverse
```

### Standard Skills publication

The official `io.modelcontextprotocol/skills` extension publishes `skills/list` and `skills/get`, with raw-file manifest sizes and SHA-256 digests generated by the SDK. A `skill://staff/{+path}` resource template serves selected skill files; ordinary file-root templates are unchanged, and `resources/list` still returns no concrete resources and rejects any supplied cursor. Skills do not expand file-tool or File App roots.

The existing SkillManager remains the selection authority, including profile precedence. Invalid standard entries are omitted without selecting a lower-priority duplicate or renaming legacy skills. Per-skill scans are bounded to 512 files and 16 MiB; traversal, symlink escapes and special files are rejected. Nested skill files remain ordinary supporting content of their parent; reading nested markdown does not activate its frontmatter. Reads do not execute scripts, install dependencies or grant tools. The compatible chat host uses current resource permissions, verifies static manifests with the official `SkillsClient`, and keeps origin labels; legacy clients continue using the old tools/prompts. These features are included in 2.2.0; publishing the package does not automatically upgrade the host or endpoints.

The legacy `skill` and `read_skill_file` definitions explicitly carry `_meta["chat-ai/skill-compatibility"] = true`. A paired host that supports standard Skills consolidates fresh model menus and manual calls into platform skill tools; the server retains the original tools for older clients. The marker is a host integration hint, not an MCP-standard permission or a change to the tools' execution contract.

Both legacy skill-reading tools and standard discovery/reads now resolve the current selected skills on demand; only the existing project plural `skills` directory has automatic watching. This does not add host per-skill consent, approval-bound acting windows or execution approval: the paired host's read-only integration is not a claim of full Beta host-safety conformance, and already-authorized command tools remain independently usable.

### HTTP session capacity and lifetime

Each HTTP listener admits at most **64 legacy MCP sessions plus active/closing modern DATA2 bindings combined**. Initializing legacy sessions and owners whose cleanup is pending or failed still count; successful cleanup frees admission. A full listener rejects new legacy initialization with HTTP **429** and new DATA2 configure with the extension capacity error, without evicting existing owners. The DATA2 proof registry has a separate **128 total-record** bound across active, closing and retained closed bindings, not 128 additional closed proofs. Unexpired proofs are not evicted for new owners. These bounds are independent of `--max-mcp-sessions`, which still limits managed child MCP servers and retains explicit start/stop.

Legacy HTTP sessions have **no MCP idle-expiry timer**. They remain until explicit DELETE/SDK close, failed initialization, transport closure or listener shutdown; clients should close unused sessions. File/PTY leases and data-consumption deadlines remain independent. Unknown or closed legacy session IDs return HTTP **404** and do not create replacement sessions. This is not a global quota for background commands, nested MCP sessions or LSP servers.

Modern HTTP has no MCP session ID and creates a fresh server facade per request. Files/PTY/data state belongs to the public DATA2 `control:{binding,token}` returned by configure, with a **90-second lease** renewed separately by the host. Owner proofs stay in host memory, never in the UI/model, configuration or logs; raw channel tokens and consumption ACKs are unchanged. Close, lease expiry and listener shutdown synchronously fence new business work, then wait for admitted CRUD, file preparation/I/O/commit, PTY creation/exit and cleanup. Failed cleanup does not report closed or free capacity. Within bounded retention (five minutes after successful owner cleanup, subject to the original operation record lifetime), the original proof and current authorization permit only original-operation status/cleanup, not renewed access or replay. Missing/unknown records never prove non-publication. Standard tools remain usable if the MCP connection is healthy; DATA lease expiry does not reconfigure, reconnect or replay operations.

### Session shutdown

Normal SDK close, stdio EOF, and CLI SIGINT/SIGTERM/SIGHUP close session resources before process exit. Docker host-pipe EOF follows the same path. Cleanup fences new work immediately, closes skills watchers and debounce timers, and waits for file staging, accepted commits, data sessions and owned PTY exit. Repeated close waits the same cleanup; failures are reported rather than called successful. Synchronous exit cleanup remains a fallback until asynchronous cleanup finishes. SIGKILL/crashes and daemonized descendants are not guaranteed cleanups, and an unsettled underlying operation can delay graceful exit.

A new legacy HTTP session requires a POST initialize request without an MCP session ID. Unknown or closed legacy IDs return HTTP 404; GET/DELETE/malformed requests do not create replacement sessions. Failed initialization releases its resources. Modern HTTP request completion disposes only its SDK facade, not the DATA2 owner. Listener shutdown closes active/initializing legacy sessions and fences and awaits modern owners. Reverse reconnect creates a fresh server after the previous session cleanup completes; it never reuses closed watchers or replays operations. HTTP capacity and the distinct legacy-session/DATA2 lifetimes follow the policy above.

### Managed child MCP sessions

`manage_mcp_session` reserves its session ID and capacity before asynchronous startup. A starting session can be stopped; late connection completion cannot restore it. Stopping attempts owned HTTP process-group cleanup even when SDK close fails, and reports incomplete cleanup as an error while retaining the session for retry. Connection/process exits no longer leave a ready session. These sessions expose standard nested tools, not a transparent Apps/data proxy or per-chat OS sandbox.

### 3. Built-in `skill-manager`
Out of the box, the AI assistant knows how to manage its own skills! You can simply ask it to:
> *"Install the official Anthropic canvas-design skill into my project."*
It will securely download, configure, and reload the skill without you lifting a finger.

### 4. Advanced Shell & Code Intelligence
- **Unified Shell Execution**: A single `execute_command` entry point for everything — quick commands, builds, and dev servers. If a command outlives its wait window (default 10s), it is NOT killed: it moves to the background and returns a task ID with its recent output. Follow up via `manage_background_task` (`logs` with optional blocking `wait`, `stop` kills the whole process group, `list`). Auto-detects and upgrades to `/bin/bash` if available, supporting complex pipelines.
- **LSP Integration**: Extract symbols, get diagnostics, go to definitions, and find references for TypeScript, Python, and more.
  - TypeScript/JavaScript LSP keeps a local TypeScript 5.9.3 fallback toolchain. A usable workspace TypeScript is preferred; TypeScript 7 workspaces fall back because the current LSP ecosystem still depends on the tsserver API.
- **File path boundary**: File operations check configured roots and protected paths. This is not an OS sandbox for shell commands or the optional PTY; use separately configured OS/container isolation for that boundary.

---

## 🎛️ CLI Arguments

| Option | Description | Default |
| :--- | :--- | :--- |
| `-w, --working-dir` | Staff workspace and default file root / terminal cwd; not an OS sandbox | `process.cwd()` |
| `-d, --allowed-dir` | Extra directories authorized for tools and, when enabled, file-app roots | `[]` |
| `-r, --profile` | The active profile for skills (e.g., android-reverse) | `default` |
| `--enable-lsp` | Enable LSP capabilities (disabled by default) | `false` |
| `--docker` | Run inside a Docker container using this image | `undefined` |
| `-D, --docker-args` | Extra args for `docker run` (e.g., `-e FOO=BAR`) | `[]` |
| `-t, --transport` | Transport type (`stdio`, `http`, or `reverse`) | `stdio` |
| `-p, --port` | Port for HTTP server | `3000` |
| `-h, --host` | Host for HTTP server | `127.0.0.1` |
| `--ht, --http-token` | Optional bearer token for HTTP transport | `undefined` (no authentication) |
| `--ru, --reverse-url` | Explicit HTTP(S) Web `/api/mcp/reverse` base endpoint | `undefined` |
| `--rt, --reverse-token` | Security token for Reverse MCP | `undefined` |
| `--rn, --reverse-name` | Server name for Reverse MCP | `undefined` |
| `--extensions` | Comma-separated `files`, `terminal`, or both; apps/data dependencies are automatic | `[]` (all off) |
| `--proxy` | HTTP(S) proxy for supported HTTP clients and reverse control/data HTTP requests | `undefined` |

### 🌐 Proxy Support (Corporate Networks)

staff-mcp configures its Undici HTTP clients from `HTTP_PROXY` / `HTTPS_PROXY` (and lowercase equivalents), with `NO_PROXY` matching for exact hosts/IPs, domain suffixes, `*`, host:port and IPv4/IPv6 CIDRs. Explicit `--proxy` takes precedence for those clients and reverse connections, bypassing `NO_PROXY`.

Reverse control and data share an injected Undici HTTP pool. Without explicit `--proxy`, `selectProxyForOrigin` selects HTTP(S) environment proxies and applies target `NO_PROXY`; HTTPS uses `HTTPS_PROXY` with `HTTP_PROXY` fallback, including lowercase variants. An explicit proxy overrides that selection. Proxy and target certificate verification remain enabled and redirects are not followed. This does not replace proxy authentication, CA trust, DNS or target reachability. Validate corporate WAN streaming/SSE and cancellation in the target network; local results do not establish that path's availability.

In `--docker` mode the HTTP-client and reverse proxy settings are evaluated inside the container; Docker environment injection or explicit `--proxy` can supply them. For TLS interception, `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` adds trust rather than disabling certificate verification; certificate files must be visible inside the container, and native ABI/libc compatibility remains a deployment requirement.

### Hardware Pass-through Example (Android Reverse Engineering)
If you need the AI to interact with an Android device connected via USB while running inside a container, network-based ADB can be configured separately. These examples do not verify Docker Desktop mount/native prerequisites or device access; restrict ADB exposure to trusted peers:

```bash
# 1. Start ADB Server on the host machine listening on all interfaces:
# adb kill-server && adb -a nodaemon server start

# 2. Start staff-mcp with the ADB_SERVER_SOCKET environment variable injected
# On Mac/Windows, if this hostname and the local Docker topology are available:
node /path/to/staff-mcp/dist/src/index.js --docker chineseastar/security:latest -D "-e ADB_SERVER_SOCKET=tcp:host.docker.internal:5037"

# On Native Linux, use the actual reachable bridge address (example only):
node /path/to/staff-mcp/dist/src/index.js --docker chineseastar/security:latest -D "-e ADB_SERVER_SOCKET=tcp:172.17.0.1:5037"

# Network settings remain subject to Docker permissions and mount/native prerequisites.
```

---

## Large file transfers (2.0.5)

files-v1 cross-MCP relay and file App uploads no longer have a 100 MiB per-file hard cap. With the matching chat-ai host, ordinary App downloads use the native browser download manager rather than a whole-file page Blob. Preparation hands the download to the browser; a manual-start action appears only when the host requests it. Verified HTTP transfer is not proof of successful local disk persistence. Inline `readBytes` previews remain bounded to 2 MiB; text/Resource limits are unchanged.

Upgrade the host and all participating endpoints, reconnect MCP and reopen Apps. staff-mcp through 2.0.4 retains the remote cap. Source snapshots and destination staging require disk space. Existing 30-second preparation RPC/remote lease, bounded data windows, cancellation, authorization and no-automatic-replay behavior remain; slow disks and deployment proxy limits can still reject large transfers. There is no unbounded-resource or resumable-transfer guarantee. Source changes are not npm publication.

## Release workflow

Merge the verified release changes into `master` first. From an up-to-date `master` checkout, confirm that implementation commit `885e36d11a9ed208c4ed262b020582be325dcf94` (`TARGET`, SDK/modern/DATA2/Skills/compat marker) and the reviewed `tmp/mcp-sdk-v2` release-branch head are included and all three package/lock versions equal the explicit target version, not merely each other; finalize the changelog, then create and push the new version tag. A check that HEAD belongs to master alone does not prove the feature branch was merged. The checklist stops on any failed command and rejects an existing version/tag. The npm workflow rejects a tag whose commit is not contained in remote `master`. Do not publish from a development branch or move an existing release tag. Merging code alone does not publish to npm. `.github/workflows/publish.yml` runs Node 24 and OIDC trusted publishing with provenance; npm must trust the matching repository/workflow. Run `npm ci`, `npm run build` and `npm pack --dry-run` in the release checkout before tagging. After Actions succeeds, verify the exact version with `npm view staff-mcp@2.2.0 version`, update the package at each endpoint and restart it. See the [step-by-step release checklist](README_zh.md#发版流程); version/tag examples must be advanced for later releases.

## 📄 License

MIT
