# staff-mcp

[English](./README.md) | [简体中文](./README_zh.md)

新一代模型上下文协议 (MCP) 服务器，它将普通的 AI 助手转变为一位极具能力的、支持容器化和按角色动态适配的“数字员工”。

内置安全的文件管理、终端执行、基于 LSP 的代码理解能力，以及创新的 **5 级技能与档案生态系统 (Skill & Profile)** 和革命性的 **Docker 透明代理模式**。

---

## 🚀 快速开始

### 1. 标准宿主机模式
直接在物理机或虚拟环境中运行。
```bash
npx -y staff-mcp@latest --working-dir /path/to/your/project
```

### 2. Docker 透明代理模式 (Cyber-Shell)
以“零侵入”的方式，将 AI 助手瞬间无缝注入到**任意 Docker 容器**中，同时保持与宿主机客户端的协议连接！底层自动挂载你的项目和 `staff-mcp` 程序包——无需 `npm install`，瞬间启动！

```bash
# 在一个纯净的 Alpine Node 容器里调试你的代码
npx -y staff-mcp@latest --docker node:20-alpine

# 在自带逆向工程工具链的镜像里执行安全分析
npx -y staff-mcp@latest --docker chineseastar/security:latest --profile android-reverse
```

### 3. Claude Desktop 配置
将以下内容添加到你的 `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "staff-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "staff-mcp@latest",
        "--working-dir",
        "/path/to/your/project"
      ]
    }
  }
}
```

### 4. Reverse MCP 模式 (内网穿透)
身处 NAT 或防火墙深处？无需公网 IP 和端口映射，主动连回中心化的远端网关 (如 `chat-ai`)！自带断线重连与无限重试机制。

```bash
npx -y staff-mcp@latest -t reverse \
  --ru https://chat.your-domain.com/api/mcp-reverse \
  --rt your_secure_token_here \
  --rn my-macbook-pro
```

---

## 🛠️ 核心能力

### 1. 无缝容器化支持 (`--docker`)
告别污染宿主机的时代。只要加上 `--docker <image>`，`staff-mcp` 将会：
- 通过只读挂载 (`read-only bind mounts`) 瞬间注入容器（无需网络重下）。
- 自动处理 Windows/Mac 与 Linux 容器之间的路径转换问题。
- 提供 `--docker-args` 硬件透传后门（如 ADB USB 调试、GPU 计算、宿主机网络）。

### 2. 技能与工种生态系统 (`--profile`)
`staff-mcp` 充当了“AI 工位配置器”的角色。它采用 **5 级级联寻址架构 (Cascade Resolution)** 动态加载角色专属的技能包 (SOP 与提示词)：
1. **项目级 (最高优)**：\`<cwd>/.staff/skills\`
2. **项目级角色层**：\`<cwd>/.staff/profiles/<profile>/skills\`
3. **全局级角色层**：\`~/.staff/profiles/<profile>/skills\`
4. **全局级默认层**：\`~/.staff/skills\`
5. **内置基建层**：\`staff-mcp/builtin-profiles\` (如系统自带的 \`skill-manager\`)

在不同角色中自由切换：
```bash
npx -y staff-mcp@latest --profile default
npx -y staff-mcp@latest --profile android-reverse
```

### 3. 聪明的“技能管家” (`skill-manager`)
系统内置了基础设施技能，AI 助手生来就知道如何管理自己！你可以直接对它说：
> *"请帮我把 Anthropic 官方的 canvas-design 技能安装到当前项目里。"*
它会自动帮你下载、配置并热更新技能文件，全程不需要你动手。

### 4. 增强的终端与代码智能
- **智能终端执行**：自动检测并在支持的环境中升级为 `/bin/bash`，完美支持复杂的管道命令、后台守护进程 (如开发服务器) 及日志持续读取。
- **LSP 深度集成**：支持提取符号 (Symbols)、获取诊断信息 (Diagnostics)、跳转定义 (Definition) 和查找引用 (References)，大幅提升 AI 理解 TypeScript/Python 等代码的能力。
- **沙盒安全**：将 AI 严格限制在你指定的工作区和允许的目录内，对全局破坏“零容忍”。

---

## 🎛️ CLI 参数说明

| 选项 | 描述 | 默认值 |
| :--- | :--- | :--- |
| `-w, --working-dir` | 沙盒的根目录 (工作区) | `process.cwd()` |
| `-d, --allowed-dir` | 额外允许 AI 访问的宿主机目录 | `[]` |
| `-r, --profile` | 当前激活的技能档案/工种 (如 android-reverse) | `default` |
| `--docker` | 在指定的 Docker 镜像内运行 AI | `undefined` |
| `-D, --docker-args` | 传递给 `docker run` 的自定义底层参数 | `[]` |
| `-t, --transport` | 传输协议 (`stdio`, `http`, 或 `reverse`) | `stdio` |
| `-p, --port` | HTTP 服务的监听端口 | `3000` |
| `-h, --host` | HTTP 服务的监听地址 | `127.0.0.1` |
| `--ru, --reverse-url` | Reverse MCP 网关的远端 URL | `undefined` |
| `--rt, --reverse-token` | Reverse MCP 的安全认证令牌 | `undefined` |
| `--rn, --reverse-name` | Reverse MCP 的服务注册名称 | `undefined` |

### 硬件透传案例 (Android 移动端逆向)
如果你希望 AI 在容器内运行时，仍能连接并控制物理机上的 Android 手机，利用基于网络端口的 ADB 透传是最稳妥的跨平台方案：

```bash
# 1. 首先在物理机上启动 ADB Server，允许所有网卡连接：
# adb kill-server && adb -a nodaemon server start

# 2. 启动 staff-mcp 并注入 ADB_SERVER_SOCKET 环境变量
# Mac/Win 环境下：
npx -y staff-mcp@latest --docker chineseastar/security:latest -D "-e ADB_SERVER_SOCKET=tcp:host.docker.internal:5037"

# 原生 Linux 环境下（若不使用 host 网络，可指向虚拟桥接 IP）：
npx -y staff-mcp@latest --docker chineseastar/security:latest -D "-e ADB_SERVER_SOCKET=tcp:172.17.0.1:5037"

# 原生 Linux 的极简方案（直接与物理机共享网络栈）：
npx -y staff-mcp@latest --docker chineseastar/security:latest -D "--network host"
```

---

## 📄 License

MIT
