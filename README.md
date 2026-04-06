# staff-mcp

[English](./README.md) | [简体中文](./README_zh.md)

A powerful Model Context Protocol (MCP) server providing file management, shell execution, and LSP capabilities. Built for seamless integration with AI assistants like Claude Desktop, IDE plugins, and custom agents.

## 🚀 Quick Start

### Installation

```bash
npm install
npm run build
```

### Running the Server

**Stdio Mode (Recommended for Claude Desktop)**

```bash
# Using npm (Recommended)
npm start -- --working-dir /path/to/your/project

# Using node directly
node dist/src/index.js --working-dir /path/to/your/project
```

**HTTP Mode**

```bash
# Using npm
npm start -- --transport http --port 3000

# Using node directly
node dist/src/index.js --transport http --port 3000
```

### CLI Arguments

| Option | Description | Default |
| :--- | :--- | :--- |
| `--working-dir` | Root directory for the sandbox | `process.cwd()` |
| `--allowed-dir` | Extra directories allowed for access | `[]` |
| `--transport` | Transport type (`stdio` or `http`) | `stdio` |
| `--port` | Port for HTTP server | `3000` |

---

## 🛠️ Supported MCP Features

- **Tools**: Comprehensive file operations, shell execution, and LSP support.
- **Skills & Prompts**: Compatible with the `SKILL.md` format. Automatically detects skills in `.staff/skills/`, `.claude/skills/`, etc.
- **MCP Native Support**: Implements the `instructions` mechanism to provide model context for environment awareness (OS, shell, etc.) and tool relationships.

### Skill File Format (`SKILL.md`)

```markdown
---
name: my-skill
description: Skill description
---
Skill instructions here...
```

---

## 💻 Cross-Platform Compatibility

`staff-mcp` handles environment differences automatically:
- **Paths**: Resolves `\` (Windows) and `/` (Unix) based on host OS.
- **Shell**: Uses `cmd.exe` on Windows and `sh` on Linux/macOS.
- **Line Endings**: Supports both `CRLF` and `LF` for file operations.

## 🧪 Development

```bash
npm run dev -- --working-dir ./test-workspace
```

## 📄 License

MIT
