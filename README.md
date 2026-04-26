# staff-mcp

[English](./README.md) | [简体中文](./README_zh.md)

A next-generation Model Context Protocol (MCP) server that transforms any AI assistant into a highly capable, container-aware, and role-adaptable digital employee. 

It provides secure file management, shell execution, LSP-powered code intelligence, a 5-tier Skill & Profile ecosystem, and a revolutionary **Docker Transparent Proxy Mode**.

---

## 🚀 Quick Start

### 1. Standard Host Mode
Run directly on your physical machine or virtual environment.
```bash
npx -y staff-mcp@latest --working-dir /path/to/your/project
```

### 2. Docker Transparent Proxy Mode (Cyber-Shell)
Seamlessly spawn the AI assistant **inside any Docker container** while keeping the protocol connection with the host. It mounts your project and the `staff-mcp` binary automatically—zero overhead, instant startup!

```bash
# Debug a Node.js project inside a pure Alpine container
npx -y staff-mcp@latest --docker node:20-alpine

# Perform security analysis inside a custom reverse-engineering image
npx -y staff-mcp@latest --docker reverse-engineer:v3 --profile reverse-engineer
```

### 3. Claude Desktop Configuration
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

---

## 🛠️ Core Capabilities

### 1. Seamless Containerization (`--docker`)
Never pollute your host machine again. By simply appending `--docker <image>`, `staff-mcp`:
- Instantly injects itself into the container via read-only bind mounts (no `npm install` inside the container).
- Automatically translates Windows/Mac paths to Linux container paths.
- Provides a `--docker-args` backdoor for hardware pass-through (e.g., ADB USB debugging, GPUs, host network).

### 2. Skill & Profile Ecosystem (`--profile`)
`staff-mcp` acts as an "AI Workspace Configurator". It uses a **5-tier Cascade Resolution** architecture to load role-specific skills (SOPs & Prompts) dynamically:
1. **Project Level**: \`<cwd>/.staff/skills\` (Highest priority)
2. **Project Profile Level**: \`<cwd>/.staff/profiles/<profile>/skills\`
3. **Global Profile Level**: \`~/.staff/profiles/<profile>/skills\`
4. **Global Level**: \`~/.staff/skills\`
5. **Built-in Infrastructure**: \`staff-mcp/builtin-profiles\` (e.g., the built-in \`skill-manager\`)

Switch roles on the fly:
```bash
npx -y staff-mcp@latest --profile developer
npx -y staff-mcp@latest --profile reverse-engineer
```

### 3. Built-in `skill-manager`
Out of the box, the AI assistant knows how to manage its own skills! You can simply ask it to:
> *"Install the official Anthropic canvas-design skill into my project."*
It will securely download, configure, and reload the skill without you lifting a finger.

### 4. Advanced Shell & Code Intelligence
- **Intelligent Shell Execution**: Auto-detects and upgrades to `/bin/bash` if available, supporting complex pipelines and background tasks (e.g., starting dev servers and tailing logs).
- **LSP Integration**: Extract symbols, get diagnostics, go to definitions, and find references for TypeScript, Python, and more.
- **Secure Sandbox**: Strictly confines the AI to the specified working directory and user-defined allowed paths.

---

## 🎛️ CLI Arguments

| Option | Description | Default |
| :--- | :--- | :--- |
| `-w, --working-dir` | Root directory for the sandbox | `process.cwd()` |
| `-d, --allowed-dir` | Extra directories allowed for access | `[]` |
| `-r, --profile` | The active profile for skills (e.g., developer) | `default` |
| `--docker` | Run inside a Docker container using this image | `undefined` |
| `-D, --docker-args` | Extra args for `docker run` (e.g., `-e FOO=BAR`) | `[]` |
| `-t, --transport` | Transport type (`stdio` or `http`) | `stdio` |
| `-p, --port` | Port for HTTP server | `3000` |
| `-h, --host` | Host for HTTP server | `127.0.0.1` |

### Hardware Pass-through Example (Android Reverse Engineering)
If you need the AI to interact with an Android device connected via USB while running inside a container:

```bash
# Mac/Win (ADB Server Pass-through)
npx -y staff-mcp@latest --docker reverse-engineer:v1 -D "-e ADB_SERVER_SOCKET=tcp:host.docker.internal:5037"

# Native Linux (USB Direct Pass-through)
npx -y staff-mcp@latest --docker reverse-engineer:v1 -D "--privileged" "-v /dev/bus/usb:/dev/bus/usb"
```

---

## 🧪 Custom Skills Development

Want to teach the AI a new trick? Just create a `SKILL.md` inside your project:
\`\`\`bash
mkdir -p .staff/skills/my-workflow
touch .staff/skills/my-workflow/SKILL.md
\`\`\`

Add the YAML frontmatter and your instructions:
\`\`\`markdown
---
name: my-workflow
description: Standard operating procedure for deploying this app
---
# Knowledge
Deployments are handled via...

# Workflows
1. Run `npm run build`
2. ...
\`\`\`
The AI will immediately detect the file change and make the \`my-workflow\` tool available!

---

## 📄 License

MIT
