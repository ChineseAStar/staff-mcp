# staff-mcp

[English](./README.md) | [简体中文](./README_zh.md)

A next-generation Model Context Protocol (MCP) server that transforms any AI assistant into a highly capable, container-aware, and role-adaptable digital employee. 

It provides secure file management, shell execution, LSP-powered code intelligence, a 5-tier Skill & Profile ecosystem, and a revolutionary **Docker Transparent Proxy Mode**.

---

## 🚀 Quick Start

Requires **Node.js 22.22.2 or newer**.

**Branch status:** these instructions describe the source contract on the unmerged, unpublished `feat/mcp-file-manager` branch, not a production deployment or full acceptance report. Use a matching reviewed checkout/build on both ends; do not use a registry “latest” package as a substitute for this branch's protocol.

From a checkout of this branch, install dependencies and build before using the absolute entrypoint in the examples:

```bash
npm install
npm run build
```

Replace `/path/to/staff-mcp` with that checkout/build directory. Docker read-only mounts still require a compatible Node/native ABI/libc; in particular an optional PTY built for a different system is not guaranteed to work inside the image.

### 1. Standard Host Mode
Run directly on your physical machine or virtual environment.
```bash
node /path/to/staff-mcp/dist/src/index.js --working-dir /path/to/your/project
```

### 2. Docker Transparent Proxy Mode (Cyber-Shell)
Seamlessly spawn the AI assistant **inside any Docker container** while keeping the protocol connection with the host. It mounts your project and the `staff-mcp` binary automatically—zero overhead, instant startup!

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
Connect your local machine to a centralized remote gateway (like `chat-ai`) from behind NAT/Firewalls. No local open ports required! It retries disconnects with fresh epochs and never replays tool calls, transfer handles or terminal input. The administrator must supply the explicit public WS/WSS endpoint; chat-ai reads its connection instructions from `CHAT_GATEWAY_PUBLIC_URL`, not a private random gateway port.

```bash
node /path/to/staff-mcp/dist/src/index.js -t reverse \
  --ru wss://gateway.example.com/remote \
  --rt your_secure_token_here \
  --rn my-macbook-pro
```

### 5. Authenticated HTTP Mode

HTTP authentication is optional. Set `--ht` / `--http-token`
to a strong, random token to require authentication:

```bash
node /path/to/staff-mcp/dist/src/index.js -t http -p 3000 \
  --http-token your_secure_token_here --working-dir /path/to/your/project
```

When a token is configured, clients must send `Authorization: Bearer <token>` on every request.
For a full Authorization-header field, enter `Bearer <token>`; for a Bearer-token
field, enter only the token. Raw tokens without the `Bearer` scheme are rejected.
Missing or incorrect credentials return HTTP 401, including requests with an
existing `mcp-session-id`. Authentication covers `/mcp` and the legacy `/sse` and
`/messages` routes. CORS `OPTIONS` preflight remains public and cannot invoke MCP.

Omitting `--http-token` leaves the HTTP listener unauthenticated.
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

The authoritative custom protocol is `chat-ai/docs/protocol/README.md` (matching `feat/mcp-file-manager` checkout). chat-ai and staff-mcp implement it independently; no extension SDK is required. The official MCP SDK and standard tools/resources/prompts remain. Independent `mcp-fte` / `mcp-reverse` dependencies and their runtime instructions have been removed; there is no old FTE chunk or reverse SSE fallback. Old reverse HTTP/SSE endpoints are not WS aliases. Coordinate both endpoints' upgrade; no chat database migration is involved.

Reverse uses subprotocol `cc.qqxing.reverse.v1`, `Authorization: Bearer <token>` and `X-MCP-Server-Name`. Use `wss://.../remote` with certificate verification outside loopback; `ws://127.0.0.1:<port>/remote` is only for local development. No credentials, query or fragment in the URL. A transport pairing is not MCP initialization or user authorization. Readiness is reported only after SDK initialization, and short-lived connections do not reset exponential backoff.

Optional CLI timeouts (milliseconds, forwarded in Docker mode):

- `--reverse-connect-timeout`: 15000; 0 disables the WS connection deadline.
- `--reverse-initialization-timeout`: 15000; must be positive.
- `--reverse-read-timeout`: 45000; heartbeat liveness, not tool execution duration.
- `--reverse-stable-time`: 30000; stable lifetime before retry reset (0 resets immediately).

`skill` / `read_skill_file` continue returning `_meta: { persistent: true }`. chat-ai consumes this host metadata hint, not `structuredContent.persistent`; it is not an MCP storage option. This does not relax the new reverse/extension compatibility requirement or change Chat8/schema9/format7/share protocol2.

## 🛠️ Core Capabilities

### Independent file workspace

The file manager is discovered under `experimental["cc.qqxing/extensions"]` (apps/files v1), then `cc.qqxing/apps/v1/list`, independently of model Tools. File CRUD, drafts, attachments and explicit download saving retain their existing behavior. The app and `transfer_file` share files v1 over direct binary HTTP tickets or reverse binary channels, with no FTE fallback. Stdio has no binary plane: ordinary tools/resources/prompts still work, but file transfer and terminal are unavailable. See [File manager contract and UI build](docs/file-manager.md) for exact methods, lifecycle, limits and packaging.

### Human terminal (explicit high-risk opt-in)

`--terminal` is off by default. It needs Linux, a loadable optional `node-pty`, an administrator-selected executable shell (`--terminal-shell`, default `/bin/bash`) and reverse binary transport. HTTP/stdio do not advertise terminal. Native loading failure leaves ordinary MCP available. chat-ai additionally requires the current chat's MCP grant, separate `allowTerminal:true` (default false), and a secure browser entrypoint; public HTTPS origin policy is configured by `MCP_TERMINAL_HTTPS_ORIGIN` on the host, independently of `CHAT_GATEWAY_PUBLIC_URL`.

The PTY runs as the staff process uid: its starting root/cwd is **not a sandbox** and shell filesystem/network effects are not restricted by file-tool path checks. Terminal bytes never enter model context or chat history. Browser long-poll/next-read ACK propagates backpressure; a separate 30-second presence/remote lease is not the file app's two-hour TTL. Hidden/disconnected UI stops input/renewal and requests cleanup, with no automatic resume; descendant cleanup is best effort, not rollback.

Backpressured PTY exit may have incomplete output. Current source reports remote `status.error:{code:"OUTPUT_INCOMPLETE",message:string}` and host read `outputIncomplete?:boolean` / `error?:{code:string,message:string}` for abnormal close/status, with UI warning handling. The boolean is a host read field, not a remote status field. These diagnostics detect possible loss; they do not recover missing bytes or guarantee lossless output, even with exit code 0 or EOF. See [Terminal UI contract](docs/terminal.md).

### 1. Seamless Containerization (`--docker`)
Never pollute your host machine again. By simply appending `--docker <image>`, `staff-mcp`:
- Instantly injects itself into the container via read-only bind mounts (no `npm install` inside the container).
- Automatically translates Windows/Mac paths to Linux container paths.
- Names containers after their launch context (e.g. `staff-mcp-myproj-3000-a1b2c3` = workspace `myproj`, HTTP port `3000`, random suffix `a1b2c3`), so multiple sessions are easy to tell apart in `docker ps`.
- Provides a `--docker-args` backdoor for hardware pass-through (e.g., ADB USB debugging, GPUs, host network).

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
| `-w, --working-dir` | Root directory for the sandbox | `process.cwd()` |
| `-d, --allowed-dir` | Extra directories allowed for access | `[]` |
| `-r, --profile` | The active profile for skills (e.g., android-reverse) | `default` |
| `--enable-lsp` | Enable LSP capabilities (disabled by default) | `false` |
| `--docker` | Run inside a Docker container using this image | `undefined` |
| `-D, --docker-args` | Extra args for `docker run` (e.g., `-e FOO=BAR`) | `[]` |
| `-t, --transport` | Transport type (`stdio`, `http`, or `reverse`) | `stdio` |
| `-p, --port` | Port for HTTP server | `3000` |
| `-h, --host` | Host for HTTP server | `127.0.0.1` |
| `--ht, --http-token` | Optional bearer token for HTTP transport | `undefined` (no authentication) |
| `--ru, --reverse-url` | Explicit WS/WSS gateway `/remote` endpoint | `undefined` |
| `--rt, --reverse-token` | Security token for Reverse MCP | `undefined` |
| `--rn, --reverse-name` | Server name for Reverse MCP | `undefined` |
| `--terminal` | Opt in to Linux PTY on reverse binary transport (staff uid, cwd is not a sandbox) | `false` |
| `--terminal-shell` | Administrator-selected absolute executable shell | `/bin/bash` |
| `--proxy` | HTTP(S) proxy for supported HTTP clients and reverse WS/WSS CONNECT | `undefined` |

### 🌐 Proxy Support (Corporate Networks)

staff-mcp configures its Undici HTTP clients from `HTTP_PROXY` / `HTTPS_PROXY` (and lowercase equivalents), with `NO_PROXY` matching for exact hosts/IPs, domain suffixes, `*`, host:port and IPv4/IPv6 CIDRs. Explicit `--proxy` takes precedence for those clients and reverse connections, bypassing `NO_PROXY`.

Reverse v1 retains corporate proxy routing through `ws` + `HttpsProxyAgent` (`https-proxy-agent` 7.0.6), not through the Undici dispatcher. Without explicit `--proxy`, it reuses `selectProxyForOrigin`, mapping WSS to HTTPS and WS to HTTP for environment/`NO_PROXY` selection. WSS uses `HTTPS_PROXY`, falling back to `HTTP_PROXY`; lowercase variants are supported. A `NO_PROXY` match or no selected proxy means direct connection; selected HTTP(S) proxies use CONNECT. Proxy and WSS target certificate verification remain enabled. Proxy routing does not replace authentication, certificate trust, DNS or target reachability configuration. Validate corporate WAN reachability in the target network; local results do not establish availability of that path.

In `--docker` mode the HTTP-client and reverse proxy settings are evaluated inside the container; Docker environment injection or explicit `--proxy` can supply them. For TLS interception, `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` adds trust rather than disabling certificate verification; certificate files must be visible inside the container, and native ABI/libc compatibility remains a deployment requirement.

### Hardware Pass-through Example (Android Reverse Engineering)
If you need the AI to interact with an Android device connected via USB while running inside a container, utilizing network-based ADB pass-through is the most reliable cross-platform solution:

```bash
# 1. Start ADB Server on the host machine listening on all interfaces:
# adb kill-server && adb -a nodaemon server start

# 2. Start staff-mcp with the ADB_SERVER_SOCKET environment variable injected
# On Mac/Windows:
node /path/to/staff-mcp/dist/src/index.js --docker chineseastar/security:latest -D "-e ADB_SERVER_SOCKET=tcp:host.docker.internal:5037"

# On Native Linux (If not using --network host, point to the docker bridge IP):
node /path/to/staff-mcp/dist/src/index.js --docker chineseastar/security:latest -D "-e ADB_SERVER_SOCKET=tcp:172.17.0.1:5037"

# Alternative for Native Linux (Share host network stack completely):
node /path/to/staff-mcp/dist/src/index.js --docker chineseastar/security:latest -D "--network host"
```

---

## 📄 License

MIT
