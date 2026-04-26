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

### ⚠️ Security Boundaries & Constraints
- **Workspace ONLY**: As an AI assistant running in a sandboxed environment, you are ONLY permitted to create, modify, or delete skills within the current project workspace (`<cwd>/.staff/skills/` or `<cwd>/.staff/profiles/`).
- **Global & Built-in are Read-Only**: You MUST NOT attempt to use tools to modify user-level (`~/.staff/`) or built-in (`staff-mcp/builtin-profiles/`) skills. Your sandbox strictly prevents this and you will get access denied errors.
- **Provide Instructions for Global**: If the user explicitly asks to install, modify, or delete a global/user-level skill, you must ONLY provide the exact shell commands in a markdown code block and politely instruct the user to run them manually in their own terminal. DO NOT execute the commands yourself.

## Workflows

### 🔍 Search/Discover Skills
To find skills (e.g., Anthropic's official skills):
1. Use `execute_command` with `curl` to query GitHub API: `curl -s "https://api.github.com/orgs/anthropics/repos?per_page=100" | grep '"name"'`
2. Or look inside `https://github.com/anthropics/skills` using git sparse-checkout.

### ⬇️ Install a Skill
When the user asks to install a skill:
1. Ask the user for the target environment if they haven't specified:
   - Global (`~/.staff/skills/`) -> **Provide commands only!**
   - Project (`.staff/skills/`) -> **Automated execution allowed.**
   - Specific Profile (e.g., `.staff/profiles/reverse-engineer/skills/`) -> **Automated execution allowed.**
2. If installing to the **Project** environment, use `execute_command` to:
   - Create a temporary directory.
   - Clone the repository (or download files) containing the `SKILL.md`.
   - Ensure the target path exists with `mkdir -p`.
   - Copy the skill files to the target directory.
   - Clean up the temporary directory.
3. If installing **Globally**, output the corresponding commands (e.g., `mkdir -p ~/.staff/skills && cd ~/.staff/skills && git clone ...`) and ask the user to execute them.

### 🗑️ Uninstall a Skill
1. Use the `skill-manager`'s knowledge of paths to locate the skill directory.
2. Check if the skill is located in the global directory or built-in directory. 
   - If it is global/built-in, output the `rm -rf <path>` command and ask the user to run it.
   - If it is a project-level skill, use `execute_command` with `rm -rf <path-to-skill-directory>` to safely remove it.

### 📝 Create a Custom Skill
1. Ask the user for the name, description, and target level (Project or Global).
2. If Project-level, use `write_file` to create `<target-directory>/<skill-name>/SKILL.md`. Include the essential YAML frontmatter:
   ```yaml
   ---
   name: <skill-name>
   description: <description>
   ---
   ```
   Define instructions under `# Knowledge` and `# Workflows` headers.
3. If Global-level, provide the file content in a code block and instruct the user to save it to `~/.staff/skills/<skill-name>/SKILL.md`.
