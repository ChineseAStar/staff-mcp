# staff-mcp

[English](./README.md) | [简体中文](./README_zh.md)

A next-generation Model Context Protocol (MCP) server that transforms any AI assistant into a highly capable, container-aware, and role-adaptable digital employee. 

It provides secure file management, shell execution, LSP-powered code intelligence, a 5-tier Skill & Profile ecosystem, and a revolutionary **Docker Transparent Proxy Mode**.

---

## Compatibility and coordinated upgrades

**Breaking release:** reverse connections and optional extensions require a matching chat-ai host: the host must implement reverse v1 and the session-relative data paths described below. Upgrade the host, staff-mcp, descriptors and UI assets together.

Standard stdio/Streamable HTTP tools, resources and prompts remain supported. Extensions are **all off by default**; unavailable or incompatible optional capabilities must not break an otherwise healthy standard MCP connection. The old reverse handshake itself is incompatible, even with extensions disabled: extension degradation cannot replace the paired reverse upgrade. There is no old-protocol compatibility mode, automatic transfer resumption or input replay after disconnect.

No Chat8/schema9/format7/share protocol2 data migration is required.

1. Finish in-flight operations and back up your normal configuration; no data conversion is needed.
2. Upgrade the matching chat-ai host first, then staff-mcp 2.0.1, coordinating downtime for reverse connections.
3. Reconnect MCP, reopen Apps and explicitly enable only the extensions you want.

See [CHANGELOG](CHANGELOG.md) for the release summary.

## 🚀 Quick Start

Requires **Node.js 22.22.2 or newer**, including inside Docker images.

Linux and Linux-host local Docker Engine are the primary full-extension environments, subject to the prerequisites below. Windows native standard MCP (stdio and HTTP) and Windows Docker standard MCP have been validated, not full extensions. Non-Linux Docker launchers disable optional extensions. **macOS has not been tested**; path translation is not a claim of platform support.

Run staff-mcp 2.0.1 with an explicit package version:

```bash
npx --yes staff-mcp@2.0.1 --working-dir /path/to/your/project
```

For a source checkout of staff-mcp 2.0.1, install dependencies and build before using the absolute entrypoint in the examples:

```bash
npm ci
npm run build
```

Replace `/path/to/staff-mcp` with that checkout/build directory. Docker read-only mounts still require a compatible Node/native ABI/libc; in particular an optional PTY built for a different system is not guaranteed to work inside the image.

### 1. Standard Host Mode
Run directly on your physical machine or virtual environment.
```bash
node /path/to/staff-mcp/dist/src/index.js --working-dir /path/to/your/project
```

### 2. Docker Transparent Proxy Mode (Cyber-Shell)
Run staff-mcp inside a compatible Docker image while keeping standard MCP control connected to the host. The wrapper mounts the project and package; image startup, Node/native ABI/libc and mount permissions still apply. Linux host + local Docker Engine is the full-extension path. Non-Linux Docker launchers disable optional Apps/files/terminal extensions with a warning; Windows Docker standard MCP has been validated, while macOS is untested; base Docker connectivity still requires a reachable daemon and valid bind mounts.

```bash
# Debug a Node.js project inside a pure Alpine container
node /path/to/staff-mcp/dist/src/index.js --docker node:22-alpine

# Perform security analysis inside a custom reverse-engineering image
node /path/to/staff-mcp/dist/src/index.js --docker chineseastar/security:latest --profile android-reverse
```

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
Connect outward from behind NAT/firewalls to chat-ai's existing Web entrypoint, without an inbound listener on staff. Control uses SSE + POST; remote-initiated raw HTTP GET/PUT carries file/terminal bytes on that same Web port. chat-ai provides the current session data path, which staff resolves against the existing `--ru` origin; `MCP_REVERSE_URL` is only an optional connection hint on chat-ai, not a data-channel prerequisite. Reconnect creates fresh sessions and never replays tool calls, transfer handles or terminal input.

```bash
node /path/to/staff-mcp/dist/src/index.js -t reverse \
  --ru https://chat.example.com/api/mcp/reverse \
  --rt your_secure_token_here \
  --rn my-workstation
```

The reverse client resolves the exact session data path against its existing `--ru` origin; chat-ai does not need `MCP_REVERSE_URL` to enable Apps. Only that session path or the already-supported exact absolute URL is accepted, before any data request or business admission; ticket, binding, authorization and redirect restrictions remain unchanged. HTTP and stdio still use absolute data endpoints. Upgrade chat-ai and staff-mcp together for this fix; no version-specific compatibility layer or extra negotiation flag is added.

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
The raw `/mcp/data/...` routes use their own negotiated, connection-bound data
Bearer token plus `X-Data-Binding`, not the shared MCP control token.

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

The authoritative custom protocol is `chat-ai/docs/protocol/README.md` at the compatible host version specified above. chat-ai, staff-mcp and third parties can implement it independently; no extension SDK is required. The official MCP SDK, standard stdio/Streamable HTTP and tools/resources/prompts remain unchanged. There is no old FTE chunk or WS fallback, and no chat database migration.

Reverse GETs `<base>/sse` with `Authorization: Bearer <token>` and `X-MCP-Server-Name`; an SSE endpoint event supplies the POST message URL. SSE message events contain ordinary MCP JSON-RPC, not a private envelope. Explicit HTTP and HTTPS are accepted; HTTP logs one plaintext warning per start and does not protect tokens or payloads. Use HTTPS on untrusted networks; HTTPS verifies CA and target identity without automatic downgrade. The configured base URL has no credentials, query or fragment. No WebSocket upgrade, gateway process, launcher or private host leg is required. SDK initialization, data-session readiness and current user authorization remain separate checks; short-lived connections do not reset exponential backoff.

Optional CLI timeouts (milliseconds, forwarded in Docker mode):

- `--reverse-connect-timeout`: 15000; 0 disables only the SSE connection deadline.
- `--reverse-initialization-timeout`: 15000; must be positive. Starts after the SSE connection and endpoint are established, not while waiting to connect; remains active when the connection deadline is disabled.
- `--reverse-read-timeout`: 45000; heartbeat liveness, not tool execution duration.
- `--reverse-stable-time`: 30000; stable lifetime before retry reset (0 resets immediately).

`skill` / `read_skill_file` continue returning `_meta: { persistent: true }`. chat-ai consumes this host metadata hint, not `structuredContent.persistent`; it is not an MCP storage option. This does not relax the new reverse/extension compatibility requirement or change Chat8/schema9/format7/share protocol2.

The two reverse transport sources (`src/reverse/SseTransport.ts` and chat-ai's `ReverseSseTransport.ts`) can later be extracted into MCP Client (host)/Server (remote) SDKs: SDK/standard-library imports plus injected URL/endpoint, headers and fetch, with transparent JSON-RPC and no data-protocol interception. No SDK package is being split out now. `src/reverse/http.ts` (Undici/TLS/proxy policy), `src/transports/reverse.ts` (server factory, extension/data setup, initialization and reconnect backoff), and host Web auth/management stay in integration, outside the pure transport boundary. The endpoint uses `session`, with no old `sessionId` compatibility or replay.

## 🛠️ Core Capabilities

Extensions are **all off by default**. Use `--extensions files`, `--extensions terminal`, or `--extensions files,terminal`; apps/data dependencies and terminal's streams v1 manifest are added automatically, not selected separately. Disabled features advertise no manifest entry and register no corresponding UI Resource or business handler. With both off there is no extension manifest or application data listener/session; ordinary MCP tools and non-UI Resources remain. HTTP mode still opens its normal MCP listener.

```bash
# Files only, with the default main root at --working-dir
node /path/to/staff-mcp/dist/src/index.js --extensions files -w /workspace
# Terminal only; does not enable the file app
node /path/to/staff-mcp/dist/src/index.js --extensions terminal --shell /bin/bash
# Both apps, with explicit file roots replacing the default main root
node /path/to/staff-mcp/dist/src/index.js --extensions files,terminal -w /workspace \
  --file-root main=/workspace --file-root assets=/srv/assets
# Explicit full-filesystem file access on a suitable Linux host (not a default)
node /path/to/staff-mcp/dist/src/index.js --extensions files --file-root system=/
```

`--file-root id=path` may repeat; IDs must be unique lowercase letters/digits/hyphens, and relative paths resolve from the launching process cwd. Explicit roots replace, rather than append to, the default `main`. They affect the file app and its standard file Resources only when files is enabled, not the standard tools' `--working-dir` / `--allowed-dir` scope or terminal's default workspace cwd. Selecting `/` explicitly exposes the filesystem visible to the staff identity; it does not elevate privileges or create an OS security boundary. The library accepts [`ExtensionOptions`](src/extensions/config.ts): `{enabled?:('files'|'terminal')[],fileRoots?:{rootId:string,directory:string}[],shell?:string}`, with `enabled` defaulting to `[]`.

### Independent file workspace

With `--extensions files`, the file manager is discovered under `experimental["cc.qqxing/extensions"]` (apps/files/data v1), then `cc.qqxing/apps/v1/list`, independently of model Tools. File CRUD, drafts, attachments and explicit download saving retain their existing behavior. The app and `transfer_file` share files v1 and the same public HTTP dataSession used by terminal: `cc.qqxing/data/v1/configure {binding}`, then `open` binds a prepared resource. Local stdio lazily opens loopback, local Docker stdio maps it automatically, direct HTTP shares the MCP port, and reverse actively GETs/PUTs the host Web port. Raw binary and cumulative consumption ACKs use a 256 KiB sliding window, not Base64 or per-chunk stop-and-wait. Clients that do not negotiate apps can still use ordinary tools and non-UI Resources. File roots do not broaden tool permissions; no FTE fallback. See [File manager contract and UI build](docs/file-manager.md) for exact methods, lifecycle, limits and packaging.

New Apps reusing supported RPC/Resources, files or streams need only their own descriptor, business handlers and UI, not host-core business branches. Truly new host permissions/capabilities require explicit registration at the host discovery/validation, server resource-module and browser-bridge composition roots. Unknown capabilities hide that App; malformed known ones remain validation errors.

### Human terminal (explicit extension opt-in)

`--extensions terminal` needs Linux, a loadable optional `node-pty`, an executable shell and negotiated streams/data v1 with a usable duplex dataSession over local stdio/Docker, direct HTTP or reverse. If Linux/native PTY/shell requirements are unavailable, staff warns on stderr and omits terminal/streams from discovery; standard MCP and an available files extension remain usable. The default disabled state never loads the native PTY. `--shell` accepts an absolute executable path; otherwise a valid absolute executable `$SHELL` is used, falling back to `/bin/bash`. The interactive shell honors normal startup files and inherits staff's environment except exact internal control keys documented in the [terminal contract](docs/terminal.md). chat-ai uses the existing current-chat MCP grant and same-origin browser requests, with no extra terminal permission switch or high-risk confirmation. Terminal follows the host site's HTTP/HTTPS deployment policy without a terminal-specific TLS gate or origin allowlist. HTTPS is recommended for the entire site to protect login sessions, tool calls and terminal traffic; allowing HTTP does not encrypt those requests.

The PTY starts at the staff workspace (`main`) by default, independently of file roots, and runs as the staff process uid: its starting root/cwd is **not a sandbox** and shell filesystem/network effects are not restricted by file-tool path checks. Terminal bytes never enter model context or chat history. Each stream uses one same-origin browser-to-chat-ai WebSocket at `/api/mcp/app-stream` (`chat-app-stream-v1`) for input, output, resize, presence and real xterm consumption ACKs. The backend remains the shared HTTP dataSession. Browser presence refreshes every 10 seconds with a separate 120-second host deadline; the host generic stream module schedules remote renewal from each returned lease (staff defaults to 30 seconds). Opening the Shell App starts one PTY without another open button or confirmation. Exit, PTY failure or disconnection leaves the app shell for manual reconnect; ordinary hidden views keep read/ACK/presence but reject new input and resize. Actual page exit, close, revocation or expiry cleans up; descendant cleanup is best effort, not rollback.

Current descriptors and iframe assets keep **bridge v1** with explicit `scope:"workspace"` for files and `scope:"chat"` for terminal. The file App declares `capabilities.files:{version:1,upload:true,download:true}`; terminal declares `capabilities.streams:{version:1,purpose,create,renew,status,close,commands}` and requires streams/data v1. Its business RPC and data purpose remain `cc.qqxing/terminal`; host lifecycle methods use generic envelopes and opaque metadata, not PTY fields. The 2.0.0 extension contract requires matching host/descriptors/assets; deploy them together and reopen Apps, with no legacy compatibility path. Files-v1 adds its own `stat` for force-copy version checks, independent of the file-manager App; byte budgets owned by chat-ai are not remote business limits. See the [host/bridge boundary](docs/file-manager.md#host-boundary-and-bridge-v1).

Backpressured PTY exit may have incomplete output. Current source reports remote `status.error:{code:"OUTPUT_INCOMPLETE",message:string}` and host generic stream frame `incomplete?:boolean` / `error?:{code:string,message:string}` for abnormal close/status, with UI warning handling. The generic boolean is `incomplete`; the app-local terminal adapter maps it to its own presentation warning. It is not a remote status field. These diagnostics detect possible loss; they do not recover missing bytes or guarantee lossless output, even with exit code 0 or EOF. See [Terminal UI contract](docs/terminal.md).

### 1. Seamless Containerization (`--docker`)
Never pollute your host machine again. By simply appending `--docker <image>`, `staff-mcp`:
- Instantly injects itself into the container via read-only bind mounts (no `npm install` inside the container).
- Automatically translates Windows/Mac paths to Linux container paths.
- Names containers after their launch context (e.g. `staff-mcp-myproj-3000-a1b2c3` = workspace `myproj`, HTTP port `3000`, random suffix `a1b2c3`), so multiple sessions are easy to tell apart in `docker ps`.
- Mounts a dedicated Docker tools cache (`<staff-global>/tools/docker`) at `/opt/.staff/tools`, alongside the existing skills/profiles mounts. A matching non-root uid can write tools without creating directories in the image, and container-installed tools do not overwrite the host tool cache. Existing mount permissions still apply; no automatic chown or chmod.
- Allows `--docker-args` for compatible hardware/environment settings (e.g., ADB USB debugging or GPUs). Unsupported stdio data topologies disable optional extensions, not the MCP control connection; overrides of managed bootstrap/mapping and container lifecycle controls remain errors.

For **supported Linux local Docker stdio with at least one effective extension enabled**, the existing wrapper reserves a private container port published to a random **127.0.0.1** host port and inspects only its own cidfile container. A read-only mount of a host **0600 metadata file** supplies the reachable base URL without rewriting stdin/stdout or asking users to discover container IPs. The application listener remains lazy until `data/v1/configure`. With all extensions off, `dataAuto` is false: no application-data port publication, metadata mount or bootstrap is created. Ordinary workspace/package mounts are unchanged. Non-Docker stdio also has no application listener before configure. HTTP/reverse add no such publication; disabled extensions create no dataSession, while HTTP retains its MCP listener.

When files is enabled, each explicit Docker `--file-root id=path` bind-mounts that host path at `/opt/staff-file-roots/<id>`. Thus `--file-root system=/` explicitly binds the host root there, rather than referring only to the container root. This is a deliberate wide filesystem exposure, not automatic host privilege acquisition or a claim of support across all platforms; actual OS/container permissions and Docker topology still apply. Default file `main` and terminal cwd use the existing workspace mount.

This application-data path requires a local daemon and the host client/wrapper sharing reachable loopback, with compatible bridge/port publication. Non-Linux Docker launchers and incompatible stdio data topologies (remote/TCP/SSH daemon or host/container networking) warn and omit optional extensions; they retain ordinary MCP control/tools when Docker itself can start. HTTP/reverse do not need this stdio mapping. A failed data bootstrap or unavailable data configuration must not terminate an otherwise healthy MCP connection: data-dependent Apps stay unavailable, with no legacy byte fallback or operation replay. Loopback publication is not isolation from hostile containers. Metadata stays 0600 and must be readable by the container uid; workspace/global-directory permissions and PTY ABI/libc still apply. No automatic chown, permission relaxation or browser-user identity switch is performed. Normal exit/signals still clean the owned container, publication and metadata; no cross-restart resource recovery is promised.

### Optional extensions do not define MCP connectivity

Availability is determined separately for files, terminal and the per-connection data channel. A missing terminal runtime disables terminal only; an unavailable configured file root disables the optional file extension while preserving the standard workspace tools/resources. Unknown or incompatible extension versions do not enable their handlers or Apps. chat-ai keeps successfully initialized standard tools/resources/prompts if optional Apps discovery or data configuration fails. Warnings go to stderr, never stdio JSON-RPC stdout.

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

Only the project-level `.staff/skills/` directory is live-watched. The directory is auto-created on startup if absent, and auto-recovered if deleted at runtime. All other tiers require restart.

Switch roles on the fly:
```bash
node /path/to/staff-mcp/dist/src/index.js --profile default
node /path/to/staff-mcp/dist/src/index.js --profile android-reverse
```

### HTTP session capacity and idle expiry

Each HTTP listener admits at most **64 sessions** by default. Starting sessions and sessions whose cleanup is still pending or failed count toward that limit. A full listener returns HTTP **429** for new initialization without evicting an existing session; successful cleanup frees the slot. Use `--http-max-sessions <positive integer>` to configure it. This is independent of `--max-mcp-sessions`, which limits managed child MCP servers.

An HTTP session becomes eligible for cleanup after **30 minutes of observed inactivity** (`--http-session-idle-ms <milliseconds>`, 1..2147483647). A single sweep runs at most once per minute (or at the shorter configured timeout). A valid incoming MCP control message restarts the idle grace. Idle GET/SSE connections, server notifications, invalid HTTP requests and unauthenticated data attempts do not keep a session alive.

Running request handlers (even after HTTP disconnect/cancellation), file preparation/valid leases/in-flight writes or commits, pending data setup/open channels, and owned PTYs or output/exit draining prevent idle eviction. These facts come from their existing owners; the idle policy does not renew business leases or equate cancellation with completion. After activity settles, the next idle observation starts a full grace interval. Completed result records and an empty configured data session alone do not pin the connection.

An expired session ID returns HTTP **404**, including with an initialize body. Reconnect explicitly without the old ID; no tool, file commit or terminal input is replayed. Keeping an App iframe or an unsaved browser draft open does not pin an otherwise inactive server connection. The draft stays client-owned, but server operations require a new connection/App after expiry. This timeout applies only to HTTP listener sessions, not stdio or reverse. Docker HTTP forwards both flags. It is not a global quota for process-owned background commands, nested MCP sessions or LSP servers, and genuinely unsettled work/failed cleanup can continue occupying a slot.

```bash
node /path/to/staff-mcp/dist/src/index.js -t http -p 3000 \
  --http-token your_secure_token_here \
  --http-max-sessions 64 --http-session-idle-ms 1800000
```

### Session shutdown

Normal SDK close, stdio EOF, and CLI SIGINT/SIGTERM/SIGHUP close session resources before process exit. Docker host-pipe EOF follows the same path. Cleanup fences new work immediately, closes skills watchers and debounce timers, and waits for file staging, accepted commits, data listeners and owned PTY exit. Repeated close waits the same cleanup; failures are reported rather than called successful. Synchronous exit cleanup remains a fallback until asynchronous cleanup finishes. SIGKILL/crashes and daemonized descendants are not guaranteed cleanups, and an unsettled underlying operation can delay graceful exit.

A new HTTP session requires a POST initialize request without an MCP session ID. Unknown or closed IDs return HTTP 404; GET/DELETE/malformed requests do not create replacement sessions. Failed initialization releases its resources. Listener shutdown closes active and initializing sessions. Reverse reconnect creates a fresh server after the previous session cleanup completes; it never reuses closed watchers or replays operations. HTTP listener capacity and idle expiry follow the policy above; stdio and reverse are not idle-evicted.

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
| `-d, --allowed-dir` | Extra directories for standard tools; does not add file-app roots | `[]` |
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
| `--file-root` | Repeatable `id=path`; explicit file roots replace the default and apply only when files is enabled | `main=<working-dir>` |
| `--shell` | Absolute executable PTY shell path | Valid absolute `$SHELL`, otherwise `/bin/bash` |
| `--proxy` | HTTP(S) proxy for supported HTTP clients and reverse control/data HTTP requests | `undefined` |

### 🌐 Proxy Support (Corporate Networks)

staff-mcp configures its Undici HTTP clients from `HTTP_PROXY` / `HTTPS_PROXY` (and lowercase equivalents), with `NO_PROXY` matching for exact hosts/IPs, domain suffixes, `*`, host:port and IPv4/IPv6 CIDRs. Explicit `--proxy` takes precedence for those clients and reverse connections, bypassing `NO_PROXY`.

Reverse control and data share an injected Undici HTTP pool. Without explicit `--proxy`, `selectProxyForOrigin` selects HTTP(S) environment proxies and applies target `NO_PROXY`; HTTPS uses `HTTPS_PROXY` with `HTTP_PROXY` fallback, including lowercase variants. An explicit proxy overrides that selection. Proxy and target certificate verification remain enabled and redirects are not followed. This does not replace proxy authentication, CA trust, DNS or target reachability. Validate corporate WAN streaming/SSE and cancellation in the target network; local results do not establish that path's availability.

In `--docker` mode the HTTP-client and reverse proxy settings are evaluated inside the container; Docker environment injection or explicit `--proxy` can supply them. For TLS interception, `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` adds trust rather than disabling certificate verification; certificate files must be visible inside the container, and native ABI/libc compatibility remains a deployment requirement.

### Hardware Pass-through Example (Android Reverse Engineering)
If you need the AI to interact with an Android device connected via USB while running inside a container, network-based ADB can be configured separately. These examples do not verify Docker Desktop stdio data mapping or device access; restrict ADB exposure to trusted peers:

```bash
# 1. Start ADB Server on the host machine listening on all interfaces:
# adb kill-server && adb -a nodaemon server start

# 2. Start staff-mcp with the ADB_SERVER_SOCKET environment variable injected
# On Mac/Windows, if this hostname and the local Docker topology are available:
node /path/to/staff-mcp/dist/src/index.js --docker chineseastar/security:latest -D "-e ADB_SERVER_SOCKET=tcp:host.docker.internal:5037"

# On Native Linux, use the actual reachable bridge address (example only):
node /path/to/staff-mcp/dist/src/index.js --docker chineseastar/security:latest -D "-e ADB_SERVER_SOCKET=tcp:172.17.0.1:5037"

# stdio automatic data publication does not support --network host.
```

---

## Release workflow

Merge the verified release changes into `master` first. From an up-to-date `master` checkout, confirm that `package.json`, the root package-lock versions and the release tag agree; finalize the changelog, then create and push the new version tag. The npm workflow rejects a tag whose commit is not contained in remote `master`. Do not publish from a development branch or move an existing release tag. Merging code alone does not publish to npm.

## 📄 License

MIT
