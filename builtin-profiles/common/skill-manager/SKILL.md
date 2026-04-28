---
name: skill-manager
description: Manage staff-mcp skills and profiles (install, uninstall, search). Use this when the user wants to add, remove, or find skills or configure a profile.
---

# Skill & Profile Manager

This core skill enables the assistant to manage skills and configure profiles for the `staff-mcp` ecosystem.

## Knowledge
Skills are stored as directories containing a `SKILL.md` file. They can be installed at different levels with the following priority (highest to lowest):
1. **Project Level**: `<cwd>/.staff/skills/<skill-name>/SKILL.md` (Primary target for assistant operations)
2. **Project Profile Level**: `<cwd>/.staff/profiles/<profile-name>/skills/<skill-name>/SKILL.md`
3. **Global Profile Level**: `~/.staff/profiles/<profile-name>/skills/<skill-name>/SKILL.md`
4. **Global Level**: `~/.staff/skills/<skill-name>/SKILL.md`
5. **Built-in Infrastructures**: `staff-mcp/builtin-profiles/...`

**Profiles** are specific context configurations (e.g. `default`, `android-reverse`). They act as complete environments that can contain not only skills but also future configurations like `agent.md` (for MCP instructions overrides). 

### ⚠️ Security Boundaries & Default Scope
- **Default to Workspace ONLY**: Unless the user explicitly says otherwise, you MUST assume all requests (install, uninstall, clear) apply ONLY to the standard project workspace (`<cwd>/.staff/skills/`).
- **Profiles are User-Managed**: DO NOT attempt to write, modify, or delete skills inside `<cwd>/.staff/profiles/` or `~/.staff/profiles/` unless explicitly instructed to modify a profile. Profiles are generally managed by the user.
- **DO NOT Locate Global/Built-in Skills**: Do not use tools (`list_dir`, `execute_command`, etc.) to search for or verify global or built-in skills when deleting or modifying. Ignore their existence to avoid wasting time and access denied errors.
- **Global & Built-in are Read-Only**: You are strictly prohibited from modifying user-level (`~/.staff/`) or built-in (`staff-mcp/builtin-profiles/`) directories.
- **Provide Instructions for Global**: If the user EXPLICITLY asks to modify a global skill or profile, DO NOT try to locate or execute it. Simply provide the exact shell commands in a markdown code block and politely instruct the user to run them manually.

## Workflows

### 🔍 Search/Discover Skills
To find skills to install:
1. **Analyze the source**: A skill can come from anywhere: a local directory path, a GitHub URL, an npm package, a zip file, or another public repository.
2. **If the user provides an exact path or URL**: Use that directly to fetch the skill.
3. **If the user does not provide enough information**: Do NOT assume it is from Anthropic or GitHub. Ask the user politely for the exact URL, Git repository, or local folder path where the skill is located.
4. **Example searches (Optional)**: If the user explicitly asks for "Anthropic official skills", you can use `curl -s "https://api.github.com/orgs/anthropics/repos?per_page=100" | grep '"name"'` as an example, but NEVER restrict yourself to this organization unless requested.

### ⬇️ Install a Skill
When the user asks to install a skill:
1. **Determine the source**: Ensure you know exactly where to get the skill from. If unsure, ask the user.
2. **Assume Project environment** (`<cwd>/.staff/skills/`) by default.
3. **If Project-level**: 
   - Use `execute_command` to fetch the skill (e.g., `git clone <url> <cwd>/.staff/skills/<skill-name>` or `cp -r <local-path> <cwd>/.staff/skills/<skill-name>`).
   - Ensure the directory contains a `SKILL.md` file.
4. **If Global-level or Profile-level**: DO NOT execute anything. Output the corresponding commands (e.g., `mkdir -p ~/.staff/skills && cd ~/.staff/skills && git clone <url> <name>`) and ask the user to execute them manually.

### 🗑️ Uninstall / Clear Skills
When the user asks to remove, uninstall, or clear skills:
1. **Assume Workspace Only**: ONLY look in and modify the standard project directory (`<cwd>/.staff/skills/`). Do NOT touch `.staff/profiles/` unless specifically told to do so.
2. Use `execute_command` (e.g., `rm -rf .staff/skills/*`) to delete them directly.
3. **Do NOT** try to find, list, or touch `~/.staff` or built-in skills. Ignore them entirely.
4. If the user EXPLICITLY asks to remove a **global** or **profile** skill, DO NOT look for it. Just output the command and tell the user to run it themselves.

### 📝 Create a Custom Skill
1. Assume **Project-level** by default. Use `write_file` to create `<cwd>/.staff/skills/<skill-name>/SKILL.md`.
2. If the user explicitly asks for a **Global-level** skill, provide the file content in a code block and instruct the user to save it to `~/.staff/skills/<skill-name>/SKILL.md` manually.
