# staff-mcp

[English](./README.md) | [简体中文](./README_zh.md)

一个功能强大的 Model Context Protocol (MCP) 服务端，提供文件管理、Shell 执行和 LSP 能力。专为 AI 助手（如 Claude Desktop、IDE 插件和自定义 Agent）的无缝集成而设计。

## 🚀 快速开始

### 安装

```bash
npm install
npm run build
```

### 运行服务

**Stdio 模式 (Claude Desktop 推荐方式)**

```bash
# 使用 npm (推荐)
npm start -- --working-dir /你的项目/路径

# 使用 node 直接启动
node dist/src/index.js --working-dir /你的项目/路径
```

**HTTP 模式**

```bash
# 使用 npm
npm start -- --transport http --port 3000

# 使用 node 直接启动
node dist/src/index.js --transport http --port 3000
```

### 命令行参数

| 参数 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `--working-dir` | 沙箱根目录 | `process.cwd()` |
| `--allowed-dir` | 额外允许访问的目录 | `[]` |
| `--transport` | 传输方式 (`stdio` 或 `http`) | `stdio` |
| `--port` | HTTP 服务端口 | `3000` |

---

## 🛠️ 支持的 MCP 特性

- **Tools (工具)**: 提供完整的文件操作、Shell 执行和 LSP（符号/诊断）支持。
- **Skills (技能)**: 兼容 `SKILL.md` 格式。自动检测并注册 `.staff/skills/`、`.claude/skills/` 等目录下的技能及 Prompts。
- **MCP 原生支持**: 实现了 `instructions` 机制，为模型自动提供环境感知（OS、Shell、路径规则）及工具调用建议。

### Skill 文件格式 (`SKILL.md`)

```markdown
---
name: my-skill
description: 技能描述
---
这里是技能的具体指令...
```

---

## 💻 跨平台兼容性

`staff-mcp` 自动处理环境差异：
- **路径**: 根据宿主系统解析 `\` (Windows) 或 `/` (Unix)。
- **Shell**: Windows 使用 `cmd.exe`，Linux/macOS 使用 `sh`。
- **换行符**: 文件操作支持 `CRLF` 和 `LF`。

## 🧪 开发

```bash
npm run dev -- --working-dir ./test-workspace
```

## 📄 开源协议

MIT
