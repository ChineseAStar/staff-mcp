# staff-mcp

[English](./README.md) | [简体中文](./README_zh.md)

新一代模型上下文协议 (MCP) 服务器，它将普通的 AI 助手转变为一位极具能力的、支持容器化和按角色动态适配的“数字员工”。

内置安全的文件管理、终端执行、基于 LSP 的代码理解能力，以及创新的 **5 级技能与档案生态系统 (Skill & Profile)** 和革命性的 **Docker 透明代理模式**。

---

## SDK／协议兼容范围 — 2.2.1

staff-mcp 2.2.1（2026-11-14）沿用拆包后的 MCP SDK 2：`client`、`server`、`core` 固定 2.4.0，`node` 固定 2.1.2。本次发布目标为 Linux x64；npm 发布不等于 chat-ai 正式运行包 pin 更新、宿主部署或运行端点升级，这些须分别完成。本文不宣称全平台、公司网络或完整端到端验收。

- stdio、reverse 和 direct HTTP 通过官方 SDK 接受 legacy 与现代 `2026-07-28` 客户端。legacy HTTP 保留原鉴权会话；现代 HTTP 每请求调用 server factory，不使用 `Mcp-Session-Id`、共用 MCP server 或暗藏会话 header。普通工具仍共享原进程状态并保留原权限；逐请求 facade 不是独立 OS／用户沙箱。
- 现代 HTTP 通过公开 **DATA2 业务绑定**保留 Files／Terminal Apps：服务端签发 control 凭据，90 秒租约，files／PTY／data 状态各自归属确切 owner。APPS／FILES／STREAMS 仍为 v1；stdio／reverse（两种协议）及 legacy HTTP 仍为 DATA1。DATA2 需宿主与 staff 配套升级，使用下文配套 chat-ai 版本，并显式更新其内置 staff 依赖。
- 现代资源订阅保留 canonical URI、root／private／symlink 准入及目录后代失效通知。薄 transport 适配只观察已确认 URI 兴趣，SDK 仍负责过滤、ACK、订阅 ID 与取消。HTTP 兴趣随响应流释放，端点只有一份事件源，避免并发请求重复通知。
- 内嵌 MCP 客户端在原进程上协商新旧协议，不为短生命周期探测再次启动未知命令。对端因发现请求退出时，本次启动失败，不自动重启。
- 扩展发现优先使用已声明的 `capabilities.extensions`，仅该容器缺省时回退 `experimental`。空或无效的新授权不继承旧授权；现代请求逐次携带能力，不借用其他请求的上下文。
- 完整分页保护、公开 SDK API 的逐次输出校验、文件 commit/status、取消、原文件／PTY 租约与不重放规则保留；DATA2 另有独立业务绑定租约。Skills 标准发布使用官方 SDK 的 Beta 扩展，旧 `skill`、`read_skill_file` 和 prompts 继续兼容。配套宿主在首次模型请求前提供已授权技能的名称、描述和来源，再通过两个只读平台工具按需加载。

## 兼容性与配套升级

**2.2.1 版本：** 保留 2.2.0 的工具、SDK／依赖锁定及协议／数据版本，修复终端流与 Docker 启动问题，增加可选的原 shell 复用和 Files 交互改进，并精简终端界面。原 shell 复用与文件夹拖入需配套 chat-ai 提交 `cc90912a630ec70d5096c58f7deb9c1336e70585` 或兼容后继版本；旧宿主保持原行为。新建 Docker 容器默认 `--ulimit core=0:0`，显式用户设置仍可覆盖。不需要数据迁移。

**2.2.0 版本：** 新增 MCP SDK 2、现代 `2026-07-28` 服务、modern HTTP DATA2 业务绑定、标准 Skills 及旧技能工具兼容标记。请配套 chat-ai `tmp/inner-mcp-stdio` 提交 `1d659874f4da0540274ea454f016cebaa6838945` 或兼容后继版本，以及匹配的宿主／描述符／UI 资源。下文历史版本所列旧宿主提交不足以提供 modern HTTP DATA2 和标准 Skills 集成。本次是需配套升级的控制 wire 变化，不新增持久化数据格式、技能执行审批或操作／输入自动重放；保留下文 2.1.0 的容器与文件资源行为。

2.1.0 移除普通文件工具与命令工作目录的 workspace 边界；Host 仍使用配置目录限制。Files App／资源模板以及文件传输 RPC 仍只公开配置根，不自动增加 `/`。私有 staging、根目录保护和原文件事务规则保留；普通文件工具仍不跟随符号链接，不处理任意设备。操作系统用户权限、只读挂载继续生效，可写工作区挂载会持久修改文件。`STAFF_MCP_IS_DOCKER=1` 是可信启动方的容器环境声明，不从文件系统猜测，也不由模型工具参数切换；Host 进程不要设置此标记。

**2.1.0 版本：** 文件资源只通过模板发现，每个配置根保留原有模板，具体资源列表返回空数组。请在文件 App 中针对文件／目录操作，不再提供顶层文件的 `@` 快捷项。该行为替代 2.0.7 的具体文件目录，不会自动更新运行中的端点。请配套 chat-ai 提交 `77369efdeeb9defce218fad95145b4dcae99724d` 或兼容后继版本，以获得容器标记传递及资源授权保护。升级前若仍有旧的按名称资源拒绝，请先连接旧目录显式保存权限，将规则转换为 URI；详见[文件资源与升级注意事项](docs/file-manager.md#standard-file-resources-and-attachments)。

**2.0.7 版本：** 本机与 Docker stdio 使用有界、无端口的数据帧，不自动回退 HTTP 或重放。请配套 chat-ai 提交 `5bfa6a4321d258e5129b250da248adff96b6ad42` 或兼容后继版本，以获得匹配的协议与权限处理；宿主正式内置依赖将在兼容后继版本中更新，仅安装此 npm 包不会更新宿主依赖。该 DATA1 版本未改变 HTTP/reverse wire 与业务授权；当前 modern HTTP 则使用上文 DATA2。旧 stdio 宿主可能无法使用可选的 data Apps/传输，但健康的标准 MCP tools/resources/prompts 仍可用。

2.0.7 还新增 `STAFF_MCP_SHELL_INIT`，供命令与新 PTY 共用 Bash 初始化（management Node 主进程不 source）；文件 App 增加常用语言语法及 Markdown 代码高亮、本地阅读字号、右侧自适应目录/窄屏下拉、文本软换行，并整理工作区/文件/阅读工具栏层级、以根目录为目标的菜单与文件标签。终端 App 移除重复关闭按钮，沿用宿主 App 生命周期。详见[文件管理](docs/file-manager.md)、[终端](docs/terminal.md)与 [CHANGELOG](CHANGELOG.md)。

Docker 模板/用户脚本编排、受管 staff 短命令与聊天深色渲染属于宿主功能，不由 npm 包单独提供。2.0.7 的验证覆盖 Linux x64 与 Chromium；2.2.0 不新增 Windows/macOS/musl 实测或支持承诺；远程网络的流式传输与可用性仍需在目标部署中验证。

**2.0.6 版本：** 新增文件仅引用、Markdown 草稿预览、文件夹上传与 ZIP 下载，以及大文本手动加载（≤512 KiB 自动加载、>2 MiB 只读、≥5 MiB 仅下载）。二进制文件使用中性预览提示，读取失败保留未保存草稿。请配套 chat-ai 提交 `972d26e2df5998f67dbcbab96685f72ef1fadf3cbbf` 或兼容后继版本；终端后台心跳、上传 HTTP 诊断、命令编辑及 Apps 合并属于宿主更新，不由 npm 包单独提供。详见[文件管理说明](docs/file-manager.md)与 [CHANGELOG](CHANGELOG.md)。

**2.0.5 版本：** 取消文件传输的 100 MiB 硬限制。配套将 chat-ai 升级至提交 `cfd7a2815f46d105b2da01d3980987c818ab0d39` 或兼容后继版本，以获得 App 流式上传、浏览器原生下载及跨 MCP 中转；参与传输的 staff-mcp 端点也须全部升级。内联预览仍限 2 MiB，资源边界与发布步骤见下文。

**2.0.4 版本：** 新增 Windows 原生 ConPTY 终端及符合条件的 Windows Docker Desktop Linux 容器扩展支持，保留 2.0.3 的 Linux PTY 预编译交付、明确终端启动错误和 reverse 心跳修复。配套将 chat-ai 升级至提交 `88f86aeb136bc2440da35b540868f9606d34ac58` 或其后继版本，以获得 Bash/CMD/PowerShell 命令生成器及此前的 App 窗口修复。

**从 2.0.3 升级：** Windows 新功能需要 staff-mcp 2.0.4；仅更新 chat-ai 不会为现有 staff 进程增加这些能力。`node-pty` 依赖锁定与扩展协议版本不变。

**历史 reverse 协议升级：** reverse 连接与可选扩展需要配套 chat-ai 宿主：宿主须实现 reverse v1 与下文的会话相对数据路径合同。宿主、staff-mcp、描述符和 UI 资源须配套升级。

标准 stdio/Streamable HTTP 的工具、资源和提示词继续保留。扩展**默认全关**；可选发现或 data 协商失败仍保留健康的标准 MCP 连接。显式请求 terminal 但平台/native/shell 前提不可用时启动失败，不再静默禁用；files 原降级行为不变。旧 reverse 握手本身不兼容，即使关闭所有扩展也不能解决，必须配套升级两端；不提供旧协议兼容模式，也不在断线后自动续传或重放输入。

本补丁不要求持久化数据迁移。

1. 结束在途操作，备份正常配置；无需转换数据。
2. 先升级配套 chat-ai 宿主并显式更新其内置 staff 依赖，再将 staff-mcp 端点升级到 2.2.1，并协调 reverse 连接的停机窗口。
3. 重新连接 MCP、重新打开 App，仅显式启用需要的扩展。

发布摘要见 [CHANGELOG](CHANGELOG.md)。

## 🚀 快速开始

需要 **Node.js 22.22.2 或更高版本**，Docker 镜像内也须满足。

当前源码支持 Linux PTY 与 Windows 原生 ConPTY，仍须通过原生加载和可执行 shell 检查。Windows **build >= 18309** 是必要而非充分条件。Windows Docker Desktop 经验证的本地 Linux 容器 daemon 可启用 files/terminal，不再仅按 launcher OS 判断。**Windows arm64 与 macOS 未实机验证，不承诺 musl/Alpine terminal 支持。** 路径转换或附带 N-API 预编译产物不等于平台支持承诺。

使用明确版本运行 staff-mcp：

```bash
npx --yes staff-mcp@2.2.1 --working-dir /path/to/your/project
```

从源码 checkout 使用时，先安装依赖并构建，再使用以下示例中的绝对入口：

```bash
npm ci
npm run build
```

将 `/path/to/staff-mcp` 替换为实际构建目录。Docker 仍只读挂载宿主程序包及 `node_modules`，并非容器依赖完全隔离。optional `node-pty` 继续精确锁定为官方预发布版 `1.2.0-beta.18`，内含 Linux x64/arm64、glibc >= 2.28 的 N-API 预编译；运行时仍需要系统 `libstdc++`、`libgcc` 等库。本次解决正常安装的预编译交付，不消除本地构建残留或架构/libc/平台不匹配限制，N-API 也不消除这些限制。不自动升级用户镜像，不承诺 musl/Alpine 的 terminal 支持。

### 1. 标准宿主机模式
直接在物理机或虚拟环境中运行。
```bash
node /path/to/staff-mcp/dist/src/index.js --working-dir /path/to/your/project
```

### 2. Docker 透明代理模式 (Cyber-Shell)
在兼容的 Docker 镜像中运行 staff-mcp，保留宿主的标准 MCP 控制连接。wrapper 自动挂载项目和程序包；启动仍取决于镜像、Node/native ABI/libc 和挂载权限。启动器不再查询 `docker info`，也不按引擎 OS 放行或拒绝扩展。HTTP/stdio 仍须经验证的本地 Unix socket 或命名管道 `npipe` endpoint；reverse 不做独立 daemon 预检查。实际容器启动及容器内扩展检查决定是否可用。wrapper 仍使用 `/workspace`、`/opt/staff-mcp` 等 POSIX 容器路径；取消 OS 门禁不等于新增 Windows 容器路径或启动适配，macOS 仍未实测。

```bash
# 仅普通 MCP，不启用 terminal：在 Alpine Node 容器内调试代码
node /path/to/staff-mcp/dist/src/index.js --docker node:22-alpine

# 在自带逆向工程工具链的镜像里执行安全分析
node /path/to/staff-mcp/dist/src/index.js --docker chineseastar/security:latest --profile android-reverse
```

`--docker` 默认在镜像名前添加 `--ulimit core=0:0`，将 core 文件大小软/硬限制设为 0。若 `-D` / `--docker-args` 已显式设置 core 限制，例如 `-D "--ulimit core=1024:1024"` 或 `-D "--ulimit=core=1024:1024"`，则原样传递，不追加默认值。其他限制（如 `nofile`）不影响 core 默认值；用户传入的非法限制仍交由 Docker 报错，Host 模式不变。该默认值仅作用于新建容器，不修改已有容器或宿主设置。

### Docker 兼容入口与实际能力检查

wrapper 直接执行 PATH 中名为 `docker` 的可执行入口，只有 shell alias 不会改变启动器调用。不再探测 `docker info` 或解析 Docker／Podman 的 OS 字段，因此不会仅因 Podman 返回不同的信息结构而拒绝启动；也不自动切换引擎或重试容器启动。HTTP/stdio 保留本地 endpoint 验证，不新增 Podman 原生连接发现。

是否可用由实际容器启动、挂载、Node／原生 PTY 加载及 shell 检查决定。显式 terminal 请求在实际前提不满足时仍启动失败。仅 files 在本地 endpoint 无法验证时保留警告并禁用扩展的行为；取消 OS 门禁不把容器启动失败视为健康 MCP。这里不承诺所有 Podman 模式、Windows 容器或全部传输组合均受支持。

本地 endpoint 查询失败报告 `DOCKER_CHECK_FAILED`（仅附安全的退出码或已知进程错误码）或 `DOCKER_CHECK_TIMEOUT`（保留原有 2 秒期限）。该检查不输出原始输出、参数及 endpoint 详情，避免泄漏凭据；实际容器启动仍使用既有失败诊断和自有容器清理。仅此修改不需要升级宿主协议或 chat-ai，也不会自动更新镜像和运行中的端点。

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
staff 从 NAT/防火墙后主动连接 chat-ai 现有 Web 入口，无需本地入站 listener。控制使用 SSE + POST，文件/终端通过 remote 主动 raw HTTP GET/PUT 走同一 Web 端口。chat-ai 提供当前会话的数据路径，staff 用已有 `--ru` 的 origin 解析；chat-ai 无需配置公网地址环境变量。断线使用新 session，不重放工具调用、文件句柄或终端输入。

```bash
node /path/to/staff-mcp/dist/src/index.js -t reverse \
  --ru https://chat.example.com/api/mcp/reverse \
  --rt your_secure_token_here \
  --rn my-workstation
```

reverse 客户端用已有 `--ru` 的 origin 解析当前会话的精确数据路径，chat-ai 不再需要通过 `MCP_REVERSE_URL` 配置公网地址来启用 Apps。只接受该会话的精确路径或原本支持的精确绝对 URL，在请求数据、业务准入前完成校验。票据、binding、权限和禁止重定向的约束保持不变。direct HTTP 仍使用绝对数据地址；stdio 使用同连接帧，无数据地址。此修复按 chat-ai/staff-mcp 两端配套升级交付，不增加版本兼容分支、额外能力标记或探测。

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
raw `/mcp/data/...` 路由使用协商的 channel Bearer token 与 `X-Data-Binding`，
不是 MCP 控制面的共享 token，也不是 DATA2 owner proof。现代 HTTP 业务 RPC 另需公开的
DATA2 `control` 凭据，不能替代原 HTTP 身份验证。

不传 `--http-token` 时，HTTP listener 的 MCP 控制面不要求鉴权。任何能够
连接服务的客户端都能调用工具，因此仅应在可信网络中使用此模式。显式传入空 token
或含空白字符的 token 时，服务拒绝启动。`--docker` 仅在提供 token 时将其透传到容器命令。
命令行 token 可能出现在 shell 历史和进程列表中，请限制对这些信息的访问。
Stdio 和 reverse 使用独立的鉴权路径；`--reverse-token` 不用于
HTTP 身份验证。远程访问应通过反向代理启用 HTTPS，普通 HTTP 无法保护传输中的
token。这里使用服务端共享 token，不提供 OAuth 流程。

---

### Reverse v1 与协议边界

自定义协议权威为上述兼容宿主版本的 `chat-ai/docs/protocol/README.md`。chat-ai、staff-mcp 及第三方可自行实现，无指定扩展 SDK。标准 MCP 协议处理仍由官方 SDK 负责，普通 tools/resources/prompts 保留原业务行为与权限；无旧 FTE 分块或 WS 回退，不迁移聊天数据库。

Reverse GET `<base>/sse`，携带 `Authorization: Bearer <token>` 与 `X-MCP-Server-Name`；SSE endpoint 事件给出 POST 回送地址，message 事件直接承载 MCP JSON-RPC，无私有信封。源码接受显式 HTTP/HTTPS；HTTP 每次启动警告一次明文风险，不能保护 token 或正文，不可信网络应使用 HTTPS。HTTPS 验证证书与目标身份，不自动降级；配置基址无凭据、query、fragment。无需 WebSocket upgrade、独立 gateway/launcher 或私有 host leg。SDK 初始化、数据面就绪和用户授权是不同事实；短暂连接不重置指数退避。

仅已识别的入站标准 MCP `ping` 的响应使用独立有界 POST 发送 lane；其他 POST 仍 FIFO，不重放请求/输入、不改变协议版本或新增 flag，也不延长 timeout。慢发送诊断区分排队等待与 POST elapsed，仅记录 metadata，不记录 token、URL 或 body；host 另记录 App resource-read 时间与字节数元数据。

可配置参数（毫秒，Docker 也透传）：

- `--reverse-connect-timeout`：15000，0 仅禁用 SSE 建连超时。
- `--reverse-initialization-timeout`：15000，必须正值。从 SSE 连接及 endpoint 建立后开始计时，不包含等待建连的时间；禁用建连超时不影响此初始化期限。
- `--reverse-read-timeout`：45000，心跳活性检测，不是工具执行时长。
- `--reverse-stable-time`：30000，达到稳定时长才重置重试（0 为立即重置）。

`skill` / `read_skill_file` 保留结果级 `_meta: { persistent: true }`；chat-ai 从 `_meta` 而不是 `structuredContent.persistent` 读取该宿主回填提示。这不是 MCP 标准存储选项，不放宽新 reverse/扩展协议的兼容要求，不修改 Chat8/schema9/format7/分享 protocol2。

两侧 reverse transport（staff `src/reverse/SseTransport.ts`、chat-ai `ReverseSseTransport.ts`）仅依赖官方 SDK/标准库及注入 URL/endpoint、headers、fetch，透明转发 JSON-RPC，不隐藏 data 协议拦截，可未来抽入 MCP Client（host）/Server（remote）SDK；目前不拆包。`src/reverse/http.ts` 的 Undici/TLS/代理策略、`src/transports/reverse.ts` 的工厂/扩展与数据装配/初始化/重连退避，以及 host Web auth/管理都留 integration，不属于纯 transport。endpoint 使用 `session`，不兼容旧 `sessionId`，不重放。

## 🛠️ 核心能力

以下描述 staff-mcp 2.2.1；扩展仍须显式启用，npm 发布不会自动升级宿主或运行端点。

扩展**默认全关**。通过 `--extensions files`、`--extensions terminal` 或 `--extensions files,terminal` 启用；apps/data 依赖及 terminal 对 streams v1 的声明自动计算，无需单独选择。禁用能力不声明对应 manifest 条目、不注册对应 UI Resource 或业务 handler；全关时无扩展 manifest、应用数据 listener/session，普通 MCP 工具和非 UI Resources 保留。HTTP 模式仍监听原 MCP 服务。

```bash
# 仅文件应用，默认 main 根为 --working-dir
node /path/to/staff-mcp/dist/src/index.js --extensions files -w /workspace
# 仅终端，不隐式启用文件应用
node /path/to/staff-mcp/dist/src/index.js --extensions terminal
# 两种应用；显式授权 assets，工具与文件应用共用
node /path/to/staff-mcp/dist/src/index.js --extensions files,terminal -w /workspace \
  -d /srv/assets
# 在适用 Linux 宿主上明确向工具和文件应用授权全盘（不是默认值）
node /path/to/staff-mcp/dist/src/index.js --extensions files -d /
```

files 启用时直接复用标准工具目录授权：`main` 是 `--working-dir`，其后按解析、去重后的 `--allowed-dir` 顺序生成 `extra1`、`extra2` 等根。显式 `-d` 授权因此也在文件 UI 可见，不自动添加系统根。相对目录按启动进程 cwd 解析。`-d /` 是向工具及文件应用显式授权 staff 身份可见的文件系统，仍受 OS 权限约束，不提权，也不是 shell 沙箱。库接口 [`ExtensionOptions`](src/extensions/config.ts) 为 `{enabled?:('files'|'terminal')[]}`，默认 `[]`。

`--file-root`、`--shell`、`--http-max-sessions`、`--http-session-idle-ms` 已删除，传入时明确报 unknown option。请从启动配置移除，文件目录改用 `-w` / `-d`；未配置 shell 初始化时，Linux 使用正常的 `SHELL` 环境变量，Windows 按下文规则自动选择 PowerShell 或 CMD；不提供兼容回退。

### 独立文件工作区

启用 `--extensions files` 后，通过 `capabilities.extensions["cc.qqxing/extensions"]`（仅新容器缺省时回退 `experimental`）及 `cc.qqxing/apps/v1/list` 发现，独立于模型 Tools。APPS／FILES／STREAMS 仍为 v1；stdio／reverse 无论 MCP era 以及 legacy HTTP 均为 DATA1，modern HTTP 为 DATA2。应用和 `transfer_file` 共用 files v1，与 terminal 共用传输中立 DataSession：DATA1 归属连接，DATA2 归属公开业务绑定。stdio 显式 configure `{binding,transport:"stdio"}` 并要求响应 `{transport:"stdio"}`；控制与有界 Base64 帧共用 FIFO writer，不创建数据 listener、endpoint 或 HTTP 票据。每帧解码后最多 64 KiB，每通道每方向 256 KiB 消费窗口；direct HTTP/reverse 保留原 MCP/Web 端口的 raw channel wire；modern HTTP 的 configure/open 及关联业务 RPC 使用 DATA2 control 授权，不能描述为 DATA1 控制 wire 不变。ACK 等真实消费，不把 SDK write/drain 当消费，文件 ACK 不是 commit。新旧 stdio data 不匹配仅使可选 DATA Apps/传输不可用，保留健康的标准 MCP，不自动回退 HTTP 或重放。未协商 apps 仍可用普通工具和非 UI Resources；roots 不扩大工具权限。详见[文件管理合同](docs/file-manager.md)。

新增 App 复用已有 RPC/Resource、files 或 streams 能力时，只增加自己的描述符、业务 handlers 与 UI，不改 host 通用核心。真正新增 host 权限/能力必须在发现校验、服务端资源模块、浏览器桥接的明确 composition roots 注册。未知 capability 隐藏该 App，已知 capability 畸形仍报校验错误。

### 人工终端（显式启用扩展）

`--extensions terminal` 须 Linux 或 Windows（build >= 18309）、可加载的 optional `node-pty`、可执行 shell，以及协商 streams v1 和 modern HTTP 的 DATA2（其他接入为 DATA1）后可用的 duplex dataSession，可经受支持的本机 stdio/本地 Docker、direct HTTP 或 reverse 接入。显式请求 terminal 但平台/native PTY/shell 不可用时明确报错并启动失败，即使同时请求 files 也不静默移除 terminal。默认关闭时不加载原生 PTY。未配置 shell 初始化时，Linux 自动使用有效的绝对可执行 `$SHELL`，否则 `/bin/bash`，以 `-i` 启动，正常 profile 行为不变；若不可用则失败，不再尝试其他 shell。Windows 使用原生 ConPTY，优先可执行 `pwsh.exe`、其次 `powershell.exe`（`-NoLogo -NoProfile`），再 `ComSpec`/系统 `cmd.exe`（`/d`），无公共 `--shell` 参数。继承 staff 环境，仅排除[终端合同](docs/terminal.md)列出的精确内部控制 key。Windows 不加载 profile，但不保证 shell、程序或系统完全不记录 history。chat-ai 沿用当前会话 MCP 授权及同源浏览器请求，不另设终端权限开关或高危确认。终端遵循宿主站点统一的 HTTP/HTTPS 部署策略，不另设终端专用 TLS 门槛或 origin 白名单。建议全站使用 HTTPS 保护登录会话、工具调用及终端流量；允许 HTTP 不代表这些请求已加密。

部署可设置 `STAFF_MCP_SHELL_INIT` 为 staff 环境内绝对、可读的 Bash 脚本路径（不是 MCP 参数）。配置后必须使用 Linux `/bin/bash`，不静默回退 `sh`；每次 `execute_command` 和每个新 PTY 都先 source 同一文件，alias、function、export 和 `cd` 在该 shell 内生效。初始化 stdout 转 stderr，不污染 MCP 协议 stdout；source 诊断被固定失败消息替代，返回非零则不执行用户命令或进入交互提示。PTY 使用私有 bootstrap 替代正常的用户 Bash rc 文件；清除 `BASH_ENV`，保留初始化路径标记供后代使用。management Node 主进程不 source 文件。脚本修改仅影响后续命令/新 PTY，不更新已有 shell；这是重复执行的初始化代码，不是一次性安装或键值解析。不新增自动重试/重放；未配置时包括 Windows 在内的既有 shell 选择及启动行为不变。详见[终端合同](docs/terminal.md#shared-shell-initialization)。

PTY 默认从 staff 工作区 `main` 启动并继承 staff 的 OS 身份；cwd **不是 sandbox**，终端字节不进入模型或聊天历史。配套未发布源码支持原 shell 复用：关闭 App 或断线仅脱离，重新打开同一授权上下文优先接回原会话，“结束会话”单独终止 shell。离线会话最多保留两小时，factory 合计最多 32 个 PTY；离线输出读取后丢弃，不归档、不回放。不承诺 Staff／容器／host 重启恢复。每次附着仍使用新同源 WS、当前 DATA 授权、默认 30 秒租约、独立 browser presence 与真实 xterm 消费 ACK。普通隐藏保留 read/ACK/presence 并限制新输入/resize。确认撤权立即禁止后续访问，但不可达的离线程序可能继续到远端保留期结束；清理 best effort，不保证后代全部结束或副作用回滚。详见[终端合同](docs/terminal.md)。

当前描述符和 iframe 资源保持 **bridge v1**：文件显式 `scope:"workspace"`，终端 `scope:"chat"`。文件声明 `capabilities.files:{version:1,upload:true,download:true}`；终端声明 `capabilities.streams:{version:1,purpose,create,renew,status,close,commands}` 并要求 streams v1 与对应 DATA 版本（modern HTTP 为 2，其余为 1）。终端业务 RPC 和 data purpose 保持 `cc.qqxing/terminal`，不再声明 terminal manifest；host 仅校验通用信封，PTY 参数与 metadata 由 staff handler/UI adapter 解释。2.0.0 扩展合同要求宿主、描述符与 UI 资源配套部署并重新打开 App，不提供旧实现兼容路径。files-v1 新增自己的 `stat` 用于 force 复制版本检查，不再依赖文件管理 App；chat-ai 的本地字节预算不代表远端业务上限。详见[宿主/桥接边界](docs/file-manager.md#host-boundary-and-bridge-v1)。

背压退出可能输出不完整，当前源码在远端 `status.error` 返回 `{code:"OUTPUT_INCOMPLETE",message:string}`，宿主通用流结果则以可选 `incomplete:boolean` 与 `error:{code:string,message:string}` 接续异常 close/status 并提供 UI 警告；通用布尔字段为 incomplete，App 本地终端 adapter 再映射完整性警告，不是远端 status 字段；这些字段用于检测和诊断可能的丢失，不恢复缺失字节，也不保证无损输出，即使收到 EOF 或 exit code 0。见[终端 UI 合同（英文）](docs/terminal.md)。

### 1. 无缝容器化支持 (`--docker`)
告别污染宿主机的时代。只要加上 `--docker <image>`，`staff-mcp` 将会：
- 通过只读挂载 (`read-only bind mounts`) 瞬间注入容器（无需网络重下）。
- 自动处理 Windows/Mac 与 Linux 容器之间的路径转换问题。
- 容器名自带启动上下文（例如 `staff-mcp-myproj-3000-a1b2c3` = 工作区 `myproj`、HTTP 端口 `3000`、随机后缀 `a1b2c3`），多个会话并存时在 `docker ps` 中一眼可辨。
- 将独立的 Docker 工具缓存 `<staff-global>/tools/docker` 挂到 `/opt/.staff/tools`，并保留原 skills/profiles 挂载。同 uid 非 root 可直接写工具目录，不覆盖宿主原工具缓存；仍受原有挂载权限限制，不自动 chown/chmod。
- 提供 `--docker-args` 配置兼容的硬件/环境参数（如 ADB USB 调试、GPU），保留受管容器生命周期限制；stdio 数据不再要求 loopback 发布或特定容器网络模式。

Docker stdio 控制与数据共用既有管道：不再映射 `39173`，无应用数据 listener、endpoint、HTTP 票据或 bootstrap metadata。wrapper 保留确切自有容器校验、工作区/程序包/tools/skills/profile 挂载、权限和清理。扩展默认全关，未协商时不创建 DataSession；HTTP 保留原 MCP listener，HTTP/reverse raw channel wire 不变；modern HTTP 业务控制改用上文 DATA2。

Docker 文件根仅复用已有工作区（`/workspace`，`main`）与 allowed-directory 挂载，不创建第二套 file-root 挂载。显式 `-d /` 会通过已有授权目录映射主动扩大宿主文件访问范围，仍受 Docker/OS 权限与拓扑约束。终端 cwd 始终为 `/workspace`，不受额外文件根影响。

Docker 中普通工具与文件应用复用允许目录挂载。宿主文件系统根（如 `/`）映射到 `/opt/staff-allowed/root-N`，因为 Docker 禁止挂载到容器 `/`。Windows drive/UNC 额外目录转换为容器内 POSIX namespace，不直接透传 Windows 路径；容器内 `-d` 和受保护暂存别名使用同一映射，重叠挂载不绕过 staging 保护。

移除 stdio 数据端口不扩大 daemon 或平台支持。不再预检容器 OS，HTTP/stdio 仍要求经验证的本地 Unix socket/`npipe` endpoint；HTTP 还须可达宿主 loopback，reverse 保留有效既有挂载要求。符合前提的 Windows Docker Desktop Linux 容器可用，不承诺任意 Desktop/remote context。挂载 uid/gid、工作区/全局目录权限、程序包/native ABI/libc 和 shell 限制仍在，不自动 chown、放宽权限或切换浏览器用户身份。显式 terminal 前提不满足仍启动报错，仅 files 保留原警告/禁用行为。可选 data configure 失败不终止健康 MCP，不回退 HTTP、不重放。`--network=none` 的 stdio 验证只证明数据不依赖网络，不证明 remote Docker、敌对容器隔离或全部平台可用。正常退出及信号仍清理自有容器，不承诺跨重启恢复。

### 可选协商降级与显式 terminal 启动错误

files、terminal 和当前连接的数据通道分别判断可用性。缺少终端运行时在显式请求 terminal 时导致启动失败；默认关闭时不加载原生 PTY。可选文件根不可用仍只禁用 files，标准工作区工具/资源保留。未知或不匹配的扩展版本不开放对应 handlers/App。chat-ai 在标准 initialize 成功后，即使 Apps 发现或 data configure 失败，仍保留正常的 tools/resources/prompts。降级原因写 stderr，不混入 stdio 的 JSON-RPC stdout。

这不是绕过鉴权或生命周期：CLI 参数语法错误、Docker 自身启动失败、凭据错误和标准 MCP 控制连接/初始化失败仍须报错。工作区/全局挂载的权限错误仍在相关启动或文件/工具操作中返回错误；扩展降级不授予额外访问，也不表示启动时已预检所有目录。新旧 reverse 控制协议不兼容仍需两端配套升级，不能用可选能力降级掩盖；文件提交、工具副作用和终端输入也不会自动重试。

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

只有项目级 `.staff/skills/` 目录被实时监听。目录在启动时如不存在则自动创建，运行中被删除后自动重建并恢复监听。其他层级不自动发变更通知；显式技能调用及标准发现会重新读取当前选择，重启可刷新其旧工具／prompt 描述。

在不同角色中自由切换：
```bash
node /path/to/staff-mcp/dist/src/index.js --profile default
node /path/to/staff-mcp/dist/src/index.js --profile android-reverse
```


### 标准 Skills 发布

官方 `io.modelcontextprotocol/skills` 扩展提供 `skills/list`、`skills/get`，由 SDK 按原始文件字节计算 manifest 的大小及 SHA-256。新增 `skill://staff/{+path}` 技能资源模板；原文件根模板不变，`resources/list` 仍返回空列表并拒绝任何已提供的 cursor。技能目录不扩大普通文件工具或 File App 的公开根。

原 SkillManager 仍决定技能选择及 profile 优先级。标准不合格条目不发布，不换成低优先级同名技能，也不改旧技能名称。每个技能的扫描最多 512 个文件、16 MiB；拒绝路径越界、符号链接逃逸及特殊文件。嵌套技能文件仍是父技能的普通附属内容，读取其 Markdown 不自动激活 frontmatter。读取不执行脚本、不安装依赖、不授予工具权限。配套 chat 宿主使用当前资源权限、官方 `SkillsClient` 静态 manifest 校验与来源标记；旧宿主继续使用原工具／prompts。这些功能纳入 2.2.0；npm 发布不代表宿主或远端实例已自动升级。

旧 `skill` 和 `read_skill_file` 的工具定义显式携带 `_meta["chat-ai/skill-compatibility"] = true`。支持标准 Skills 的配套宿主将新会话模型菜单和人工调用统一到平台技能入口，服务端仍兼容旧客户端的原工具调用。该标记只是宿主集成提示，不是 MCP 标准权限，也不改变原工具执行合同。

两个旧技能读取工具及标准发现／读取现在均按需解析当前选中的技能；自动监听仍只覆盖原项目复数 `skills` 目录。本次不增加宿主逐技能同意、绑定审批的 acting-window 或执行批准机制：配套宿主的只读集成不代表完整满足 Beta 的全部宿主安全要求，原本已获授权的命令工具仍独立可用。

### HTTP 会话容量与生命周期

每个 HTTP 监听器的 **legacy MCP sessions 与 modern DATA2 active/closing bindings 合计最多 64 个**。初始化中的 legacy 会话、清理未完成或失败的 owner 都占名额，清理成功后才释放。满额时 legacy 新初始化返回 HTTP **429**，DATA2 新 configure 返回扩展容量错误，不驱逐已有 owner。DATA2 proof registry 另限 **128 条总记录**，包含 active、closing 和保留期内 closed 记录，不是额外容纳 128 条 closed proof；不会为新 owner 驱逐未过期 proof。这些限制与受管子 MCP 的 `--max-mcp-sessions` 独立，子 MCP 显式 start/stop 不变。

legacy HTTP 会话**没有 MCP 空闲回收定时器**。显式 DELETE/SDK close、初始化失败、传输关闭或监听器 shutdown 才清理；客户端应主动关闭不用的会话。文件／PTY 租约及数据消费期限仍独立生效。未知或已关闭 legacy session ID 返回 HTTP **404**，不会创建替代会话。此容量不是后台命令、受管子 MCP 或 LSP 的全局配额。

modern HTTP 无 MCP session ID，每请求创建独立 server facade。Files／PTY／data 状态归属 configure 返回的公开 DATA2 `control:{binding,token}`，具有由宿主单独续期的 **90 秒租约**。owner proof 只留宿主内存，不进入 UI／模型、配置或日志；raw channel token 和消费 ACK 保持不变。close、租约到期和 listener shutdown 同步拒绝新业务，再等待已受理 CRUD、文件准备／I/O／commit、PTY 创建／退出及 cleanup；清理失败不报告 closed、不释放容量。有限保留期内（owner 清理成功后五分钟，原操作仍受其记录期限限制），可凭原 proof 和当前授权查询原操作 status／执行 cleanup，但不能恢复操作权限或重放；unknown／记录缺失不证明未发布。健康的标准 MCP 普通工具保持可用；DATA 到期不自动 configure、重连或重放。

### 会话关闭

正常 SDK close、stdio EOF 及 CLI SIGINT/SIGTERM/SIGHUP 都先清理会话资源，再退出进程；Docker 宿主管道 EOF 走同一路径。清理立即拒绝新操作，关闭 skills 监听器及防抖定时器，并等待文件暂存、已受理提交、数据会话和自有 PTY 退出。重复 close 等待同一清理过程，失败明确报告，不伪报成功。异步清理结束前保留同步 exit 兜底。SIGKILL、崩溃和 daemonize 后代不保证清理，未兑现的底层操作也可能延迟正常退出。

新 legacy HTTP 会话只能由不带 MCP session ID 的 POST initialize 创建。未知或已关闭 legacy ID 返回 404；GET/DELETE/无效请求不会创建替代会话。初始化失败释放资源。modern HTTP 请求结束只销毁该次 SDK facade，不关闭 DATA2 owner；监听器 shutdown 等待活动／初始化中的 legacy 会话，并 fence、等待 modern owner 清理。reverse 重连等待旧会话清理后创建新 server，不复用已关闭的监听器、不重放操作。HTTP 容量、legacy session 与 DATA2 的不同生命周期遵循上节规则。

### 受管子 MCP 会话

`manage_mcp_session` 在异步启动前占用会话 ID 和名额。启动中的会话可以停止，迟到的连接完成不能将其恢复为 ready。停止时即使 SDK close 失败，仍尝试清理自有 HTTP 进程组；清理未完成会明确报错并保留会话供重试，不伪报成功。连接或进程退出后不再保留 ready 状态。这些会话提供标准嵌套工具，不是 Apps/data 透明代理，也不是每个 chat 独立的 OS 沙箱。

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
| `-d, --allowed-dir` | 工具及已启用文件 App 共用的额外授权目录 | `[]` |
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
| `--proxy` | 支持的 HTTP 客户端及 reverse 控制/数据 HTTP 请求 的 HTTP(S) 代理 | `undefined` |

### 🌐 代理支持（企业内网）

staff-mcp 的 Undici HTTP 客户端读取 `HTTP_PROXY` / `HTTPS_PROXY`（含小写形式），`NO_PROXY` 支持精确主机/IP、域名后缀、`*`、host:port 和 IPv4/IPv6 CIDR。显式 `--proxy` 对这些客户端及 reverse 连接均优先于环境变量，且不应用 `NO_PROXY`。

Reverse 控制与数据共用注入的 Undici HTTP pool。未显式传 `--proxy` 时通过 `selectProxyForOrigin` 按 HTTP(S) 目标选择环境代理并检查 `NO_PROXY`；HTTPS 优先 `HTTPS_PROXY`，缺失时回退 `HTTP_PROXY`，支持小写形式。显式代理覆盖该选择。代理与目标证书校验保持开启，不跟随重定向；仍须配置代理认证、CA 信任、DNS 与目标可达性。公司 WAN 的 SSE、流式上传/下载和取消须在实际网络验证，本机结果不能替代。

Docker 内对支持的 HTTP 客户端与 reverse 连接应用上述代理设置，可由容器环境或 `--proxy` 提供。TLS 拦截可用 `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` 增加信任，不关闭证书校验；证书文件须在容器内可见，native ABI/libc 兼容仍是部署要求。

### 硬件透传案例 (Android 移动端逆向)
如果你希望 AI 在容器内运行时，仍能连接并控制物理机上的 Android 手机，可单独配置网络 ADB。以下示例不证明 Docker Desktop 挂载/原生依赖或设备访问可用，ADB 暴露范围须限制为受信任对端：

```bash
# 1. 首先在物理机上启动 ADB Server，允许所有网卡连接：
# adb kill-server && adb -a nodaemon server start

# 2. 启动 staff-mcp 并注入 ADB_SERVER_SOCKET 环境变量
# Mac/Win 环境下，须另验主机名与本地 Docker 拓扑可达：
node /path/to/staff-mcp/dist/src/index.js --docker chineseastar/security:latest -D "-e ADB_SERVER_SOCKET=tcp:host.docker.internal:5037"

# 原生 Linux 环境下使用实际可达的 bridge 地址（以下仅示例）：
node /path/to/staff-mcp/dist/src/index.js --docker chineseastar/security:latest -D "-e ADB_SERVER_SOCKET=tcp:172.17.0.1:5037"

# 网络设置仍须满足 Docker 权限、挂载及原生依赖前提。
```

---

## 大文件传输（2.0.5）

files-v1 跨 MCP 中转与文件应用上传不再设置 100 MiB 单文件硬限制。配套 chat-ai 宿主的普通下载使用浏览器原生下载管理器，不再把整个文件收进网页 Blob；准备完成后交给浏览器开始下载；只有宿主确认需要时才显示手动开始入口。页面只显示传输进度，是否已成功写入磁盘请以浏览器下载记录为准。`readBytes` 小型预览仍限 2 MiB，文本编辑和标准 Resource 限制不变。

需要升级源端、目标端和宿主，重新连接 MCP 并重开应用。2.0.4 及更早 staff-mcp 仍拒绝超过 100 MiB 的文件。源快照和目标暂存需要磁盘空间；保留准备请求 30 秒超时、远端租约、背压和权限检查，不提供断点续传或副作用自动重放。代理请求体／超时限制和慢盘仍可能导致失败。“无 100 MiB 硬限”不等于无限资源。新源码须完成以下发布流程后才会出现在 npm。

## 发版流程

1. 在临时开发分支完成改动、补齐 CHANGELOG 发布日期，确认 `package.json`、`package-lock.json` 顶层及 `packages[""].version` 都是本次目标版本，提交并推送该分支。
2. 运行以下 **Bash** 检查流程。先核对 `VERSION`、`RELEASE_BRANCH` 与实现提交 `TARGET`，并确认该分支头已包含发布文档与版本变更。示例为 2.2.1；`TARGET` 是已存在且可核对的 Docker／Files／终端修复与交互改进实现提交，不是尚未知的发版提交。该版本发布后不可原样重跑。任何一步失败都应先排查，不要跳过检查继续打标签。

```bash
(
set -euo pipefail
VERSION=2.2.1
RELEASE_BRANCH=fix/docker-core-limit-default
TARGET=04c9ed9d5f96062bcb401cb41c3b83b22c8b73a8

git fetch origin --tags
git cat-file -e "$TARGET^{commit}"
git merge-base --is-ancestor "$TARGET" "origin/$RELEASE_BRANCH"
test -z "$(git status --porcelain)"
git switch master
git pull --ff-only origin master
# 必须实际合入新功能；只检查 HEAD 属于 master 不能证明功能已合入。
git merge --ff-only "origin/$RELEASE_BRANCH"
# 同时校验最新实现提交及已审阅的发布分支头（含文档/版本变更）。
git merge-base --is-ancestor "$TARGET" HEAD
git merge-base --is-ancestor "origin/$RELEASE_BRANCH" HEAD

RELEASE_VERSION="$VERSION" node --input-type=commonjs <<'JS'
const assert = require("node:assert/strict");
const p = require("./package.json");
const l = require("./package-lock.json");
const expected = process.env.RELEASE_VERSION;
assert.equal(p.version, expected, "package.json is not the target release");
assert.equal(l.version, expected);
assert.equal(l.packages[""].version, expected);
console.log("Verified release version:", expected);
JS

# 已有标签或 npm 版本都必须停止；正常发布流程不删除或移动标签。
if git show-ref --verify --quiet "refs/tags/v$VERSION"; then
  echo "Tag v$VERSION already exists; stop." >&2
  exit 1
fi
npm view staff-mcp versions --json | RELEASE_VERSION="$VERSION" node -e '
  const assert = require("node:assert/strict");
  const versions = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  assert(![].concat(versions).includes(process.env.RELEASE_VERSION), "Version already published");
'

npm ci
NODE_OPTIONS="--max-old-space-size=2048" npm run build
npm pack --dry-run
test -z "$(git status --porcelain)"
git push origin master
git fetch --no-tags origin master
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)"
git tag -a "v$VERSION" -m "Release staff-mcp $VERSION"
git push origin "refs/tags/v$VERSION"
)
```

若不能快进合并，在临时分支先处理与最新 `master` 的集成并重新验收；不要用强推绕过。已推送但错误的标签只能在核实 npm 尚未发布、相关发布任务已停止且获得明确确认后单独修复，不属于每次发版步骤。

标签触发 `.github/workflows/publish.yml` 的 **Publish to npm**。工作流使用 Node 24、OIDC trusted publishing 和 `npm publish --provenance --access public`；npm 包设置中的 trusted publisher 必须对应仓库和 `publish.yml` 工作流文件。发布任务会验证标签对应提交已包含于远端 `master`，并校验三处版本；仅 push/合并 `master` 不会发布 npm。禁止从未合入的开发分支发版、移动已发布标签或重用已发布版本。

成功后检查 Actions 和 `npm view staff-mcp@2.2.1 version`，再按原安装方式更新（如 `npm install -g staff-mcp@2.2.1` 或 `npx -y staff-mcp@2.2.1 ...`），并重启各 MCP 进程；已运行进程和已打开的 App 不会自动替换。版本号与标签示例需随每次后续发布更新。

## 📄 License

MIT
