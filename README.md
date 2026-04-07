# staff-mcp

[English](./README.md) | [简体中文](./README_zh.md)

A robust Model Context Protocol (MCP) server that provides AI assistants with a secure, cross-platform environment for file management, shell execution, and LSP-powered code intelligence.

---

## 🚀 Usage

Use this section if you want to run the published package.

### Run with npx

Recommended command:

```bash
npx -y staff-mcp@latest --working-dir /path/to/your/project
```

Using `@latest` is the safest option for a published CLI package and avoids resolution issues such as `could not determine executable to run`.

### Configure for Claude Desktop

Add the following to your `claude_desktop_config.json`:

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

### CLI Arguments

| Option | Description | Default |
| :--- | :--- | :--- |
| `--working-dir` | Root directory for the sandbox | `process.cwd()` |
| `--allowed-dir` | Extra directories allowed for access | `[]` |
| `--transport` | Transport type (`stdio` or `http`) | `stdio` |
| `--port` | Port for HTTP server (if using http) | `3000` |

### Skill Loading

`staff-mcp` can work with skill directories if they already exist in your workspace or home directory. To use them, place skill files in any supported location such as:

- `.staff/skills/<skill-name>/SKILL.md`
- `.claude/skills/<skill-name>/SKILL.md`
- `.agents/skills/<skill-name>/SKILL.md`
- `.opencode/skills/<skill-name>/SKILL.md`

The server discovers them automatically at startup.

---

## 🛠️ Core Features

- **File Operations**: Secure read, write, delete, and list operations within the sandbox.
- **Shell Integration**: Execute non-interactive commands or start background tasks (e.g., dev servers).
- **Code Intelligence**: LSP-based symbol extraction and diagnostics for better code understanding.
- **Skill System**: Automatically detects and loads domain-specific instructions from `.staff/skills/`, `.claude/skills/`, and `.agents/skills/`.
- **Environment Awareness**: Native support for Windows (CMD/PowerShell) and Unix-like (Bash/Sh) systems.

### Adding Skills

Create a `SKILL.md` file in `.staff/skills/your-skill/`:

```markdown
---
name: my-skill
description: Custom logic for my project
---
Add your domain-specific instructions or workflows here.
```

---

## 🧪 Development

Use this section only if you want to work on the repository itself.

### Local setup

```bash
git clone https://github.com/your-username/staff-mcp.git
cd staff-mcp
npm install
npm run build
```

### Run the local build

```bash
node dist/src/index.js --working-dir ./test-workspace
```

### Run with npm scripts

```bash
npm start -- --working-dir ./test-workspace
npm run dev -- --working-dir ./test-workspace
```

## ✅ Testing

Examples for verifying the package behavior separately from normal usage:

### Verify the published package

```bash
npx -y staff-mcp@latest --working-dir /tmp
```

### Verify the local build

```bash
npm run build
node dist/src/index.js --working-dir /tmp
```

## 📄 License

MIT
