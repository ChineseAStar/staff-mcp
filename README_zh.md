# staff-mcp

[English](./README.md) | [简体中文](./README_zh.md)

一个稳健的 Model Context Protocol (MCP) 服务端，为 AI 助手提供安全、跨平台的文件管理、Shell 执行和基于 LSP 的代码智能环境。

---

## 🚀 使用

这一节用于说明如何直接使用已发布的包，而不是如何开发或测试这个仓库。

### 使用 npx 运行

推荐命令：

```bash
npx -y staff-mcp@latest --working-dir /你的项目/路径
```

对于已发布的 CLI 包，显式使用 `@latest` 更稳妥，也可以避免类似 `could not determine executable to run` 的解析问题。

### 在 Claude Desktop 中配置

将以下内容添加到你的 `claude_desktop_config.json` 文件中：

```json
{
  "mcpServers": {
    "staff-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "staff-mcp@latest",
        "--working-dir",
        "/你的项目/路径"
      ]
    }
  }
}
```

### 命令行参数

| 参数 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `--working-dir` | 沙箱根目录 | `process.cwd()` |
| `--allowed-dir` | 额外允许访问的目录 | `[]` |
| `--transport` | 传输方式 (`stdio` 或 `http`) | `stdio` |
| `--port` | HTTP 服务端口 (如果使用 http 模式) | `3000` |

### Skill 加载方式

如果你的工作区或用户目录里已经存在 skill 目录，`staff-mcp` 会在启动时自动发现并加载。可用目录示例：

- `.staff/skills/<skill-name>/SKILL.md`
- `.claude/skills/<skill-name>/SKILL.md`
- `.agents/skills/<skill-name>/SKILL.md`
- `.opencode/skills/<skill-name>/SKILL.md`

---

## 🛠️ 核心特性

- **文件操作**: 在沙箱范围内提供安全的读、写、删除和列表操作。
- **Shell 集成**: 执行非交互式命令或启动后台任务（如开发服务器）。
- **代码智能**: 基于 LSP 的符号提取和诊断，帮助 AI 更好地理解代码结构。
- **技能系统 (Skills)**: 自动检测并加载 `.staff/skills/`、`.claude/skills/` 和 `.agents/skills/` 目录下的领域特定指令。
- **环境感知**: 原生支持 Windows (CMD/PowerShell) 和 Unix-like (Bash/Sh) 系统。

### 如何添加技能

在 `.staff/skills/your-skill/` 目录下创建一个 `SKILL.md` 文件：

```markdown
---
name: my-skill
description: 我的项目专属逻辑
---
在此处添加你的领域特定指令或工作流。
```

---

## 🧪 开发

这一节只面向要修改仓库源码的开发者。

### 本地准备

```bash
git clone https://github.com/your-username/staff-mcp.git
cd staff-mcp
npm install
npm run build
```

### 运行本地构建产物

```bash
node dist/src/index.js --working-dir ./test-workspace
```

### 使用 npm 脚本运行

```bash
npm start -- --working-dir ./test-workspace
npm run dev -- --working-dir ./test-workspace
```

## ✅ 测试

这一节单独用于说明如何验证包是否可用，而不是日常使用方式。

### 验证已发布包

```bash
npx -y staff-mcp@latest --working-dir /tmp
```

### 验证本地构建

```bash
npm run build
node dist/src/index.js --working-dir /tmp
```

## 📄 开源协议

MIT
