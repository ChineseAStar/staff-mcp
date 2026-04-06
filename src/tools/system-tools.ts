import * as os from "os";
import * as path from "path";
import { SecurityManager } from "../security.js";

/**
 * Returns a concise instruction string for the MCP server to guide tool usage.
 * Focuses on environment context and tool relationships rather than defining identity.
 */
export function getMcpInstructions(workingDir: string, security: SecurityManager): string {
  const platform = os.platform();
  const isWin = platform === "win32";
  const shell = isWin ? "cmd.exe or PowerShell" : (process.env.SHELL || "/bin/sh");
  const allowedDirs = security.getAllowedDirs();

  return `
# MCP Context: staff-mcp
Environment:
- OS: ${platform}
- Default Shell: ${shell}
- Working Directory: ${workingDir}
- Access Constraints: Only paths within [${allowedDirs.join(", ")}] are accessible.
- Path Separator: '${path.sep}'

Tool Usage Guidance:
1. File Navigation: Always start by using 'list_dir' to understand the project structure before reading files.
2. Content Inspection: 
   - Use 'read_file' for specific files. 
   - Use 'search_file_content' (regex-backed grep) to find patterns or usage across the codebase.
   - Use 'get_document_symbols' for a quick structural overview of a file.
3. Command Execution:
   - For quick, non-interactive tasks, use 'execute_command'.
   - For long-running processes (e.g., dev servers), use 'start_background_task' and follow up with 'get_background_task_logs'.
   - ${isWin ? "Critical: Use Windows-compatible commands (e.g., 'dir', 'copy', 'del', 'type'). Use backslashes '\\' for paths in commands." : "Critical: Use POSIX-compatible commands (e.g., 'ls', 'cp', 'rm', 'cat'). Use forward slashes '/' for paths."}
4. Specialized Skills: If a '.staff/skills' or '.claude/skills' directory exists, use the 'skill' tool to load domain-specific workflows which will augment your current context.
5. Search & Replace: When refactoring, use 'search_file_content' to find all occurrences, then 'edit_file_by_replace' for precise, line-based replacements.
6. Verification: Use 'get_diagnostics' after editing code to ensure no errors were introduced.
`.trim();
}
