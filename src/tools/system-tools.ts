import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { SecurityManager } from "../security.js";
import { getWorkspaceArtifactPolicy } from "../policies/workspace-artifact-policy.js";

export interface McpInstructionOptions {
  enableLsp?: boolean;
}

/**
 * Returns server-wide MCP guidance.
 *
 * Keep cross-tool workflow rules here and leave tool-specific usage details to
 * each tool's own description/schema. Put the highest-value rules first so
 * clients that prioritize the beginning of server instructions see them.
 */
export function getMcpInstructions(
  workingDir: string,
  security: SecurityManager,
  options: McpInstructionOptions = {}
): string {
  const platform = os.platform();
  const isWin = platform === "win32";
  const isDocker = process.env.STAFF_MCP_IS_DOCKER === "1";

  // Use the same platform assumptions as shell-tools.ts.
  let shell = isWin ? "cmd.exe or PowerShell" : "/bin/sh";
  if (!isWin) {
    if (isDocker) {
      shell = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
    } else {
      shell = process.env.SHELL || (fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
    }
  }

  const allowedDirs = security.getAllowedDirs();
  const environment = isDocker ? "Docker sandbox" : "host";
  const modeGuidance = isDocker
    ? "Docker mode: the container is isolated and disposable. Installing dependencies or changing container-level configuration is allowed when useful. File tools remain restricted to the allowed paths above."
    : "Host mode: prefer workspace-local changes. Avoid unnecessary global installs or host system configuration changes.";

  const lspGuidance = options.enableLsp
    ? `
- LSP is enabled. Use semantic navigation for symbol definitions/references when it is more precise than text search, and use diagnostics after code edits when relevant.`
    : "";

  return `
# MCP Context: staff-mcp
Workspace: ${workingDir}
Allowed paths: [${allowedDirs.join(", ")}]
Environment: ${environment}; OS ${platform}; shell ${shell}; path separator '${path.sep}'.
Use 'execute_command' for all shell commands. If it returns a task ID, continue that task with 'manage_background_task'; do not rerun the command.
Keep assistant-only temporary files, logs, experiments, notes, and caches under '.staff/' unless the workspace defines another scratch location.

${modeGuidance}

Cross-tool workflow:
- If the target file is already known, inspect it directly. If the relevant location is unclear, inspect or search the workspace first.
- Before broad refactors, search for all affected usages, then make focused edits and verify the result.
- When an available skill matches the task, load it with 'skill' and follow its workflow.
- Use 'manage_mcp_session' for child MCP servers and 'explore_mcp_session' to discover their capabilities.${lspGuidance}
- Verify meaningful code changes with the most relevant build, checks, or tests available in the workspace.

${getWorkspaceArtifactPolicy()}
`.trim();
}
