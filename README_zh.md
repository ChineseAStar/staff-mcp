# staff-mcp

[English](./README.md) | [简体中文](./README_zh.md)

新一代模型上下文协议 (MCP) 服务器，它将普通的 AI 助手转变为一位极具能力的、支持容器化和按角色动态适配的“数字员工”。

内置安全的文件管理、终端执行、基于 LSP 的代码理解能力，以及创新的 **5 级技能与档案生态系统 (Skill & Profile)** 和革命性的 **Docker 透明代理模式**。

---

## 🚀 快速开始

需要 **Node.js 22.22.2 或更高版本**。

**分支状态：** 本文描述未合并、未发布的 `feat/mcp-file-manager` 源码合同，不构成生产部署或全量验收声明。两端应使用匹配且经核实的本分支构建，不要用 registry 的“最新版”替代本分支协议。

在本分支 checkout 中先安装依赖并构建，再使用以下示例中的绝对入口：

```bash
npm install
npm run build
```

将 `/path/to/staff-mcp` 替换为实际构建目录。Docker 只读挂载仍要求兼容的 Node/native ABI/libc；宿主构建的 optional PTY 不保证能在任意镜像内使用。

### 1. 标准宿主机模式
直接在物理机或虚拟环境中运行。
```bash
node /path/to/staff-mcp/dist/src/index.js --working-dir /path/to/your/project
```

### 2. Docker 透明代理模式 (Cyber-Shell)
在兼容的 Docker 镜像中运行 staff-mcp，保留宿主的标准 MCP 控制连接。wrapper 自动挂载项目和程序包；启动仍取决于镜像、Node/native ABI/libc 和挂载权限。本地 stdio 数据自动映射有下述拓扑边界，不保证所有 Docker Desktop 或远程 daemon 可用。

```bash
# 在一个纯净的 Alpine Node 容器里调试你的代码
node /path/to/staff-mcp/dist/src/index.js --docker node:22-alpine

# 在自带逆向工程工具链的镜像里执行安全分析
node /path/to/staff-mcp/dist/src/index.js --docker chineseastar/security:latest --profile android-reverse
```

### 3. Claude Desktop 配置
将以下内容添加到你的 `claude_desktop_config.json`：

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

### 4. Reverse MCP 模式 (内网穿透)
staff 从 NAT/防火墙后主动连接 chat-ai 现有 Web 入口，无需本地入站 listener。控制使用 SSE + POST，文件/终端通过 remote 主动 raw HTTP GET/PUT 走同一 Web 端口。管理员在 chat-ai 显式配置 `MCP_REVERSE_URL`，不从私有端口猜公开地址。断线使用新 session，不重放工具调用、文件句柄或终端输入。

```bash
node /path/to/staff-mcp/dist/src/index.js -t reverse \
  --ru https://chat.example.com/api/mcp/reverse \
  --rt your_secure_token_here \
  --rn my-workstation
```

### 5. 带身份验证的 HTTP 模式

HTTP 身份验证是可选配置。设置 `--ht` / `--http-token` 即可开启，两者等价，建议使用强随机 token：

```bash
node /path/to/staff-mcp/dist/src/index.js -t http -p 3000 \
  --http-token your_secure_token_here --working-dir /path/to/your/project
```

配置 token 后，客户端每次 MCP 控制请求都必须发送 `Authorization: Bearer <token>`。如果配置项接收完整的
Authorization 请求头值，填写 `Bearer <token>`；如果是 Bearer token 配置项，只填写
token。仅发送原始 token、不带 `Bearer` 前缀的请求会被拒绝。缺失或错误的凭证返回
HTTP 401，携带已有 `mcp-session-id` 也不能绕过验证。保护范围包括 `/mcp` 和兼容
路由 `/sse`、`/messages`。CORS `OPTIONS` 预检无需凭证，但无法调用 MCP。
raw `/mcp/data/...` 路由使用协商的连接级 data Bearer token 与 `X-Data-Binding`，
不是 MCP 控制面的共享 token。

不传 `--http-token` 时，HTTP listener 的 MCP 控制面不要求鉴权。任何能够
连接服务的客户端都能调用工具，因此仅应在可信网络中使用此模式。显式传入空 token
或含空白字符的 token 时，服务拒绝启动。`--docker` 仅在提供 token 时将其透传到容器命令。
命令行 token 可能出现在 shell 历史和进程列表中，请限制对这些信息的访问。
Stdio 和 reverse 使用独立的鉴权路径；`--reverse-token` 不用于
HTTP 身份验证。远程访问应通过反向代理启用 HTTPS，普通 HTTP 无法保护传输中的
token。这里使用服务端共享 token，不提供 OAuth 流程。

---

### Reverse v1 与协议边界

自定义协议权威为 `chat-ai/docs/protocol/README.md`（匹配的 `feat/mcp-file-manager` checkout）。chat-ai、staff-mcp 及第三方可自行实现，无指定扩展 SDK。官方 MCP SDK、标准 stdio/Streamable HTTP 和 tools/resources/prompts 不变；无旧 FTE 分块或 WS 回退，不迁移聊天数据库。

Reverse GET `<base>/sse`，携带 `Authorization: Bearer <token>` 与 `X-MCP-Server-Name`；SSE endpoint 事件给出 POST 回送地址，message 事件直接承载 MCP JSON-RPC，无私有信封。源码接受显式 HTTP/HTTPS；HTTP 每次启动警告一次明文风险，不能保护 token 或正文，不可信网络应使用 HTTPS。HTTPS 验证证书与目标身份，不自动降级；配置基址无凭据、query、fragment。无需 WebSocket upgrade、独立 gateway/launcher 或私有 host leg。SDK 初始化、数据面就绪和用户授权是不同事实；短暂连接不重置指数退避。

可配置参数（毫秒，Docker 也透传）：

- `--reverse-connect-timeout`：15000，0 禁用 SSE 建连超时。
- `--reverse-initialization-timeout`：15000，必须正值。
- `--reverse-read-timeout`：45000，心跳活性检测，不是工具执行时长。
- `--reverse-stable-time`：30000，达到稳定时长才重置重试（0 为立即重置）。

`skill` / `read_skill_file` 保留结果级 `_meta: { persistent: true }`；chat-ai 从 `_meta` 而不是 `structuredContent.persistent` 读取该宿主回填提示。这不是 MCP 标准存储选项，不放宽新 reverse/扩展协议的兼容要求，不修改 Chat8/schema9/format7/分享 protocol2。

## 🛠️ 核心能力

扩展**默认全关**。通过 `--extensions files`、`--extensions terminal` 或 `--extensions files,terminal` 启用；apps/data 依赖自动计算，无需单独选择。禁用能力不声明对应 manifest 条目、不注册对应 UI Resource 或业务 handler；全关时无扩展 manifest、应用数据 listener/session，普通 MCP 工具和非 UI Resources 保留。HTTP 模式仍监听原 MCP 服务。

```bash
# 仅文件应用，默认 main 根为 --working-dir
node /path/to/staff-mcp/dist/src/index.js --extensions files -w /workspace
# 仅终端，不隐式启用文件应用
node /path/to/staff-mcp/dist/src/index.js --extensions terminal --shell /bin/bash
# 两种应用，显式文件 roots 替代默认 main 根
node /path/to/staff-mcp/dist/src/index.js --extensions files,terminal -w /workspace \
  --file-root main=/workspace --file-root assets=/srv/assets
# 在适用 Linux 宿主上明确开放全盘文件访问（不是默认值）
node /path/to/staff-mcp/dist/src/index.js --extensions files --file-root system=/
```

`--file-root id=path` 可重复，id 须由小写字母/数字/连字符组成且唯一；相对路径按启动进程 cwd 解析。显式 roots **替代**而非追加默认 `main`，仅 files 启用时影响文件 App 及其标准文件 Resources，不改变标准工具的 `--working-dir` / `--allowed-dir` 范围或终端默认工作区 cwd。显式选择 `/` 开放的是 staff 身份实际可见的文件系统，不提权，也不是 OS 安全边界。库接口 [`ExtensionOptions`](src/extensions/config.ts) 为 `{enabled?:('files'|'terminal')[],fileRoots?:{rootId:string,directory:string}[],shell?:string}`，`enabled` 默认 `[]`。

### 独立文件工作区

启用 `--extensions files` 后，文件管理器通过 `experimental["cc.qqxing/extensions"]` 的 apps/files/data v1 发现，再调用 `cc.qqxing/apps/v1/list`，独立于模型 Tools。文件 CRUD、草稿、附件快照与显式下载保存行为保留；应用和 `transfer_file` 共用 files v1，与 terminal 使用当前连接同一公共 HTTP dataSession：先 `cc.qqxing/data/v1/configure {binding}`，再 open 绑定准备好的资源。本机 stdio lazy loopback、本地 Docker stdio 自动映射、direct HTTP 同 MCP 端口、reverse 主动 GET/PUT 同 Web 端口；raw binary 与累计消费 ACK 使用 256 KiB 滑动窗口，不走 Base64 或逐块 stop-and-wait。客户端未协商 apps 时仍可用普通工具和非 UI Resources；文件 roots 不扩大工具权限，无 FTE 回退。真实方法、授权、生命周期、限额及打包见[文件管理合同与构建说明（英文）](docs/file-manager.md)。

### 人工终端（显式启用扩展）

`--extensions terminal` 须 Linux、可加载的 optional `node-pty`、可执行 shell 及协商 terminal/data v1 后可用的 duplex dataSession，可经本机 stdio/本地 Docker、direct HTTP 或 reverse 接入。显式启用但 Linux/native PTY/shell 不可用时启动失败，不静默隐藏缺依赖；默认关闭时不加载原生 PTY。`--shell` 接受绝对可执行路径，缺省使用有效的绝对 `$SHELL`，否则回退 `/bin/bash`。交互 shell 读取正常启动配置，继承 staff 环境，仅排除[终端合同](docs/terminal.md)列出的精确内部控制 key。chat-ai 沿用当前会话 MCP 授权及同源浏览器请求，不另设终端权限开关或高危确认。终端遵循宿主站点统一的 HTTP/HTTPS 部署策略，不另设终端专用 TLS 门槛或 origin 白名单。建议全站使用 HTTPS 保护登录会话、工具调用及终端流量；允许 HTTP 不代表这些请求已加密。

PTY 默认从 staff 工作区 `main` 启动，与文件 roots 独立，以 staff 的 OS uid 运行；root/cwd 只是起始目录，**不是 sandbox**；shell 的文件和网络副作用不受文件工具路径检查约束。终端输入输出不进入模型或聊天历史。每个 PTY 的浏览器到 chat-ai 交互使用一条同源 WebSocket，输入、输出、resize、presence 和真实 xterm 消费 ACK 共用连接，后端仍是公共 HTTP dataSession。浏览器每 10 秒刷新独立的 120 秒 host presence；host 终端适配器按远端每次返回的租约调度续租，staff 默认 30 秒。点击 Shell App 自动启动一次 PTY，无额外打开按钮或确认；退出、PTY 错误或真实断链后保留 App 壳供手动重连。普通隐藏视图保留 read/ACK/presence，但拒绝新输入和 resize；真正离页、关闭、撤权或到期才清理，后代回收 best effort，不撤销副作用。

当前描述符和 iframe 资源使用 **bridge v2**：文件显式 `scope:"workspace"`，终端 `scope:"chat"`。须匹配宿主与 UI 资源并重新打开 App，不维护 bridge-v1 回退。files-v1 新增自己的 `stat` 用于 force 复制版本检查，不再依赖文件管理 App；chat-ai 的本地字节预算不代表远端业务上限。详见[宿主/桥接边界](docs/file-manager.md#host-boundary-and-bridge-v2)。

背压退出可能输出不完整，当前源码在远端 `status.error` 返回 `{code:"OUTPUT_INCOMPLETE",message:string}`，宿主输出帧则以可选 `outputIncomplete:boolean` 与 `error:{code:string,message:string}` 接续异常 close/status 并提供 UI 警告；布尔字段属于宿主输出帧，不是远端 status 字段；这些字段用于检测和诊断可能的丢失，不恢复缺失字节，也不保证无损输出，即使收到 EOF 或 exit code 0。见[终端 UI 合同（英文）](docs/terminal.md)。

### 1. 无缝容器化支持 (`--docker`)
告别污染宿主机的时代。只要加上 `--docker <image>`，`staff-mcp` 将会：
- 通过只读挂载 (`read-only bind mounts`) 瞬间注入容器（无需网络重下）。
- 自动处理 Windows/Mac 与 Linux 容器之间的路径转换问题。
- 容器名自带启动上下文（例如 `staff-mcp-myproj-3000-a1b2c3` = 工作区 `myproj`、HTTP 端口 `3000`、随机后缀 `a1b2c3`），多个会话并存时在 `docker ps` 中一眼可辨。
- 提供 `--docker-args` 配置兼容的硬件/环境参数（如 ADB USB 调试、GPU）；stdio 自动发布拒绝 host/container 网络与覆盖内部 bootstrap/映射参数。

**本地 Docker stdio 仅在至少启用一种扩展时**，由原 wrapper 自动预留容器私有端口到 **127.0.0.1 随机宿主端口**，仅 inspect 自己 cidfile 的容器；只读挂载宿主 **0600 metadata 文件**提供可达 baseUrl，不改 stdin/stdout，不手找容器 IP，应用 listener 等 `data/v1/configure` 才懒启动。全关时 `dataAuto` 为 false，不分配应用数据发布端口、metadata 挂载或 bootstrap；普通工作区/程序包挂载不变。非 Docker stdio 也在 configure 前无应用 listener。HTTP/reverse 不增加这项发布；全关无 dataSession，HTTP 原 MCP listener 保留。

files 启用时，每个显式 Docker `--file-root id=path` 将对应宿主目录 bind-mount 到 `/opt/staff-file-roots/<id>`。因此 `--file-root system=/` 是明确把宿主根挂到该目录，而不只是指容器根；这是主动扩大文件可见范围，不是自动获得宿主权限或全平台支持承诺，仍受实际 OS/容器权限与 Docker 拓扑约束。默认文件 `main` 与终端 cwd 沿用现有工作区挂载。

此路径要求本地 daemon、客户端与 wrapper 共享可达 loopback、兼容 bridge/端口发布；拒绝 remote/TCP/SSH Docker context 和不兼容网络。不宣称任意 Docker Desktop、network-none、跨 SSH 或额外 sideband/隧道均可用，loopback 发布不是敌对容器隔离保证。容器 uid 须能读 0600 metadata，工作区权限取决于实际 uid/gid，原生 PTY ABI/libc 须匹配镜像；不自动 chown 挂载或按浏览器用户切换身份。退出、失败和启动超时收敛自有容器、映射和 metadata，不提供跨重启资源恢复。

### 2. 技能与工种生态系统 (`--profile`)
`staff-mcp` 充当了"AI 工位配置器"的角色。它采用 **5 级级联寻址架构 (Cascade Resolution)** 动态加载角色专属的技能包 (SOP 与提示词)，统一使用 `.staff` 目录规范：

| 优先级 | 层级 | 路径 | 热更新 |
|:---:|:---|:---|:---:|
| 1 (最高) | 项目级 | \`<cwd>/.staff/skills\` | ✅ 实时（自动创建目录） |
| 2 | 项目角色层 | \`<cwd>/.staff/profiles/<profile>/skills\` | 🔄 需重启 |
| 3 | 全局角色层 | \`~/.staff/profiles/<profile>/skills\` | 🔄 需重启 |
| 4 | 全局默认层 | \`~/.staff/skills\` | 🔄 需重启 |
| 5 (最低) | 内置基建层 | \`staff-mcp/builtin-profiles\` | 🔄 需重启 |

**Profile 是加性参数**——第 1 级和第 4 级不受 profile 影响，永远被加载；第 2、3、5 级根据 profile 值追加对应目录。多层级出现同名 skill 时，高优先级覆盖低优先级（取并集+同名覆盖，而非整层替换）。

只有项目级 `.staff/skills/` 目录被实时监听。目录在启动时如不存在则自动创建，运行中被删除后自动重建并恢复监听。其他层级需重启生效。

在不同角色中自由切换：
```bash
node /path/to/staff-mcp/dist/src/index.js --profile default
node /path/to/staff-mcp/dist/src/index.js --profile android-reverse
```


### 3. 聪明的“技能管家” (`skill-manager`)
系统内置了基础设施技能，AI 助手生来就知道如何管理自己！你可以直接对它说：
> *"请帮我把 Anthropic 官方的 canvas-design 技能安装到当前项目里。"*
它会自动帮你下载、配置并热更新技能文件，全程不需要你动手。

### 4. 增强的终端与代码智能
- **统一命令执行**：所有命令（快速命令、构建、开发服务器）统一走 `execute_command` 入口。命令超过等待窗口（默认 10s）不会被杀死，而是转入后台并返回任务 ID 和近期输出；随后用 `manage_background_task` 跟进（`logs` 支持 `wait` 阻塞等待新输出或退出、`stop` 终止整个进程组、`list` 列出全部）。自动检测并在支持的环境中升级为 `/bin/bash`，完美支持复杂管道命令。
- **LSP 深度集成**：支持提取符号 (Symbols)、获取诊断信息 (Diagnostics)、跳转定义 (Definition) 和查找引用 (References)，大幅提升 AI 理解 TypeScript/Python 等代码的能力。
  - TypeScript/JavaScript LSP 会在 staff-mcp 工具目录保留 TypeScript 5.9.3 作为兼容回退；工作区 TypeScript 可用时仍优先使用，TypeScript 7 暂无 tsserver API 时会自动回退。
- **文件路径边界**：文件操作校验配置 roots 和受保护路径。这不是 Shell/optional PTY 的 OS 沙盒；强隔离需另行配置 OS/容器权限。

---

## 🎛️ CLI 参数说明

| 选项 | 描述 | 默认值 |
| :--- | :--- | :--- |
| `-w, --working-dir` | staff 工作区与默认文件 root / 终端 cwd；不是 OS 沙盒 | `process.cwd()` |
| `-d, --allowed-dir` | 标准工具额外允许目录；不增加文件 App roots | `[]` |
| `-r, --profile` | 当前激活的技能档案/工种 (如 android-reverse) | `default` |
| `--enable-lsp` | 启用 LSP 语言服务器功能 (默认禁用) | `false` |
| `--docker` | 在指定的 Docker 镜像内运行 AI | `undefined` |
| `-D, --docker-args` | 传递给 `docker run` 的自定义底层参数 | `[]` |
| `-t, --transport` | 传输协议 (`stdio`, `http`, 或 `reverse`) | `stdio` |
| `-p, --port` | HTTP 服务的监听端口 | `3000` |
| `-h, --host` | HTTP 服务的监听地址 | `127.0.0.1` |
| `--ht, --http-token` | HTTP 模式可选的 Bearer token | `undefined`（不鉴权） |
| `--ru, --reverse-url` | 显式 HTTP(S) Web `/api/mcp/reverse` 基址 | `undefined` |
| `--rt, --reverse-token` | Reverse MCP 的安全认证令牌 | `undefined` |
| `--rn, --reverse-name` | Reverse MCP 的服务注册名称 | `undefined` |
| `--extensions` | 逗号分隔的 `files`、`terminal` 或两者；自动计算 apps/data 依赖 | `[]`（全关） |
| `--file-root` | 可重复 `id=path`；显式 roots 替代默认值，仅 files 启用时生效 | `main=<working-dir>` |
| `--shell` | PTY shell 的绝对可执行路径 | 有效的绝对 `$SHELL`，否则 `/bin/bash` |
| `--proxy` | 支持的 HTTP 客户端及 reverse 控制/数据 HTTP 请求 的 HTTP(S) 代理 | `undefined` |

### 🌐 代理支持（企业内网）

staff-mcp 的 Undici HTTP 客户端读取 `HTTP_PROXY` / `HTTPS_PROXY`（含小写形式），`NO_PROXY` 支持精确主机/IP、域名后缀、`*`、host:port 和 IPv4/IPv6 CIDR。显式 `--proxy` 对这些客户端及 reverse 连接均优先于环境变量，且不应用 `NO_PROXY`。

Reverse 控制与数据共用注入的 Undici HTTP pool。未显式传 `--proxy` 时通过 `selectProxyForOrigin` 按 HTTP(S) 目标选择环境代理并检查 `NO_PROXY`；HTTPS 优先 `HTTPS_PROXY`，缺失时回退 `HTTP_PROXY`，支持小写形式。显式代理覆盖该选择。代理与目标证书校验保持开启，不跟随重定向；仍须配置代理认证、CA 信任、DNS 与目标可达性。公司 WAN 的 SSE、流式上传/下载和取消须在实际网络验证，本机结果不能替代。

Docker 内对支持的 HTTP 客户端与 reverse 连接应用上述代理设置，可由容器环境或 `--proxy` 提供。TLS 拦截可用 `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` 增加信任，不关闭证书校验；证书文件须在容器内可见，native ABI/libc 兼容仍是部署要求。

### 硬件透传案例 (Android 移动端逆向)
如果你希望 AI 在容器内运行时，仍能连接并控制物理机上的 Android 手机，可单独配置网络 ADB。以下示例不证明 Docker Desktop stdio 数据映射或设备访问可用，ADB 暴露范围须限制为受信任对端：

```bash
# 1. 首先在物理机上启动 ADB Server，允许所有网卡连接：
# adb kill-server && adb -a nodaemon server start

# 2. 启动 staff-mcp 并注入 ADB_SERVER_SOCKET 环境变量
# Mac/Win 环境下，须另验主机名与本地 Docker 拓扑可达：
node /path/to/staff-mcp/dist/src/index.js --docker chineseastar/security:latest -D "-e ADB_SERVER_SOCKET=tcp:host.docker.internal:5037"

# 原生 Linux 环境下使用实际可达的 bridge 地址（以下仅示例）：
node /path/to/staff-mcp/dist/src/index.js --docker chineseastar/security:latest -D "-e ADB_SERVER_SOCKET=tcp:172.17.0.1:5037"

# stdio 自动数据发布不支持 --network host。
```

---

## 📄 License

MIT
