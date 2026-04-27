import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { SecurityManager } from "../security.js";
import { getWorkspaceArtifactPolicy } from "../policies/workspace-artifact-policy.js";

/**
 * Returns a concise instruction string for the MCP server to guide tool usage.
 * Focuses on environment context and tool relationships rather than defining identity.
 */
export function getMcpInstructions(workingDir: string, security: SecurityManager): string {
  const platform = os.platform();
  const isWin = platform === "win32";
  
  // Use the same logic as shell-tools.ts to determine the actual shell being used
  let shell = isWin ? "cmd.exe or PowerShell" : "/bin/sh";
  if (!isWin) {
    if (process.env.STAFF_MCP_IS_DOCKER === "1") {
       // If running in Docker, we dynamically probed bash in shell-tools.
       // We can assume if /bin/bash exists, it's used.
       shell = fs.existsSync('/bin/bash') ? "/bin/bash" : "/bin/sh";
    } else {
       shell = process.env.SHELL || (fs.existsSync('/bin/bash') ? "/bin/bash" : "/bin/sh");
    }
  }

  const allowedDirs = security.getAllowedDirs();
  const isDocker = process.env.STAFF_MCP_IS_DOCKER === "1";

  const environmentContext = isDocker ? `
[🐳 Docker Sandbox Environment]
- You are running inside an ISOLATED and EPHEMERAL Docker container.
- The host system is COMPLETELY PROTECTED. You CANNOT damage the user's host machine.
- You have root/admin privileges within this sandbox.
- It is SAFE and ENCOURAGED to aggressively install missing dependencies (e.g., \`apt-get install\`, \`apk add\`, \`pip install\`, \`npm install -g\`) via 'execute_command' if needed to accomplish your task.
- It is SAFE to modify system configurations (\`/etc\`) or use advanced/unsafe flags in tools (e.g., \`--unsafe\` in idalib-mcp).
- Feel free to experiment fearlessly. If the environment breaks, the container can be easily destroyed and recreated.
- Note on Files: While you can modify system paths via commands, file tools ('read_file', 'write_file') are STILL RESTRICTED to the Access Constraints below.
` : `
[💻 Host Environment]
- You are running directly on the user's host system.
- Exercise CAUTION when executing commands, installing global packages, or modifying files outside the immediate working directory.
- Avoid commands that could permanently alter or damage the host OS configuration.
`;

  return `
# MCP Context: staff-mcp
Environment:
- OS: ${platform}
- Default Shell: ${shell}
- Working Directory: ${workingDir}
- Access Constraints: Only paths within [${allowedDirs.join(", ")}] are accessible.
- Path Separator: '${path.sep}'

${environmentContext.trim()}

Tool Usage Guidance:
1. File Navigation: Always start by using 'list_dir' to understand the project structure before reading files.
2. Content Inspection: 
   - Use 'read_file' for specific files. 
   - Use 'search_workspace' (search_type: "content") to find patterns or usage across the codebase.
   - Use 'search_workspace' (search_type: "path") to find files by name/glob.
   - Use 'get_document_symbols' for a quick structural overview of a file.
3. Command Execution:
   - For quick, non-interactive tasks, use 'execute_command'.
   - For long-running processes (e.g., dev servers), use 'manage_background_task' (action: "start") and follow up with action "logs".
   - ${isWin ? "Critical: Use Windows-compatible commands (e.g., 'dir', 'copy', 'del', 'type'). Use backslashes '\\\\' for paths in commands." : "Critical: Use POSIX-compatible commands (e.g., 'ls', 'cp', 'rm', 'cat'). Use forward slashes '/' for paths."}
4. Specialized Skills: If a '.staff/skills' or '.claude/skills' directory exists, use the 'skill' tool to load domain-specific workflows which will augment your current context.
5. Search & Replace: When refactoring, use 'search_workspace' to find all occurrences, then 'edit_file_by_replace' for precise, line-based replacements.
6. Code Understanding: Use 'symbol_lookup' to find definitions and references in code.
7. MCP Server Integration: Use 'manage_mcp_session' to start/stop child MCP sessions, and 'explore_mcp_session' to discover their tools.
8. Verification: Use 'get_diagnostics' after editing code to ensure no errors were introduced.

${getWorkspaceArtifactPolicy()}
`.trim();
}
