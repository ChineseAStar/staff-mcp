---
name: skill-manager
description: Manage staff-mcp skills and profiles (install, uninstall, search). Use this when the user wants to add, remove, or find skills or configure a role profile.
---

# Skill & Profile Manager

This core skill enables the assistant to manage skills and configure persona profiles for the `staff-mcp` ecosystem.

## Knowledge
Skills are stored as directories containing a `SKILL.md` file. They can be installed at different levels with the following priority (highest to lowest):
1. **Project Level**: `<cwd>/.staff/skills/<skill-name>/SKILL.md`
2. **Project Profile Level**: `<cwd>/.staff/profiles/<profile-name>/skills/<skill-name>/SKILL.md`
3. **Global Profile Level**: `~/.staff/profiles/<profile-name>/skills/<skill-name>/SKILL.md`
4. **Global Level**: `~/.staff/skills/<skill-name>/SKILL.md`
5. **Built-in Infrastructures**: `staff-mcp/builtin-profiles/...`

Profiles are roles or specific context configurations (e.g. `developer`, `reverse-engineer`). 

### ⚠️ Security Boundaries & Default Scope
- **Default to Workspace ONLY**: Unless the user explicitly uses the word "global", you MUST assume all requests (install, uninstall, clear, list) apply ONLY to the current project workspace (`<cwd>/.staff/skills/` or `<cwd>/.staff/profiles/`).
- **DO NOT Locate Global/Built-in Skills**: Do not use tools (`list_dir`, `execute_command`, etc.) to search for or verify global or built-in skills when deleting or modifying. Ignore their existence during these operations to avoid wasting time and access denied errors.
- **Global & Built-in are Read-Only**: You are strictly prohibited from modifying user-level (`~/.staff/`) or built-in (`staff-mcp/builtin-profiles/`) directories.
- **Provide Instructions for Global**: If the user EXPLICITLY asks to install, modify, or delete a global/user-level skill, DO NOT try to locate or execute it. Simply provide the exact shell commands (e.g., `rm -rf ~/.staff/skills/<name>`) in a markdown code block and politely instruct the user to run them manually.

## Workflows

### 🔍 Search/Discover Skills
To find skills to install:
1. Use `execute_command` with `curl` to query GitHub API: `curl -s "https://api.github.com/orgs/anthropics/repos?per_page=100" | grep '"name"'`

### ⬇️ Install a Skill
When the user asks to install a skill:
1. Assume **Project** environment (`<cwd>/.staff/skills/`) by default, unless "global" is specified.
2. **If Project-level**: Use `execute_command` to clone/download the skill into `<cwd>/.staff/skills/<skill-name>`.
3. **If Global-level**: DO NOT execute anything. Output the corresponding commands (e.g., `mkdir -p ~/.staff/skills && cd ~/.staff/skills && git clone ...`) and ask the user to execute them manually.

### 🗑️ Uninstall / Clear Skills
When the user asks to remove, uninstall, or clear skills:
1. **Assume Workspace Only**: ONLY look in and modify the project directories (`<cwd>/.staff/skills/` and `<cwd>/.staff/profiles/`). 
2. Use `execute_command` (e.g., `rm -rf .staff/skills/*`) to delete them directly.
3. **Do NOT** try to find, list, or touch `~/.staff` or built-in skills. Ignore them entirely.
4. If the user EXPLICITLY asks to remove a **global** skill, DO NOT look for it. Just output `rm -rf ~/.staff/skills/<skill-name>` and tell the user to run it themselves.

### 📝 Create a Custom Skill
1. Assume **Project-level** by default. Use `write_file` to create `<cwd>/.staff/skills/<skill-name>/SKILL.md`.
2. If the user explicitly asks for a **Global-level** skill, provide the file content in a code block and instruct the user to save it to `~/.staff/skills/<skill-name>/SKILL.md` manually.
