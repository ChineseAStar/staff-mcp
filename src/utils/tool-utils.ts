import * as path from "path";
import * as fs from "fs";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { createRequire } from "node:module";
import { STAFF_TOOLS_DIR, ensureStaffDirs } from "./paths.js";

const execAsync = promisify(exec);

/**
 * Gets the correct command name for the current platform (e.g. npm -> npm.cmd on Windows)
 */
export function getPlatformCommand(cmd: string): string {
  if (process.platform === "win32") {
    if (cmd === "npm") return "npm.cmd";
    if (cmd === "npx") return "npx.cmd";
  }
  return cmd;
}

/**
 * Helper to check if a file/dir exists
 */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
//  ripgrep resolution helpers
// ============================================================

/** Run `which rg` / `where rg` — non-throwing, returns null if not found. */
function whichAsync(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? `where ${name}` : `which ${name}`;
    exec(cmd, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(null);
      resolve(stdout.trim().split(/\r?\n/)[0] || null);
    });
  });
}

/**
 * Try to load @vscode/ripgrep from staff-mcp's own bundled dependency.
 * In cross-platform Docker (e.g. Windows host → Linux container) this will
 * naturally fail: process.platform = "linux", but the mounted host node_modules
 * only contain the Windows sub-package → MODULE_NOT_FOUND → caught → null.
 */
async function tryImportRgPath(): Promise<string | null> {
  try {
    const pkg = await import("@vscode/ripgrep");
    if (pkg.rgPath && fs.existsSync(pkg.rgPath)) {
      return pkg.rgPath;
    }
  } catch { /* cross-platform Docker or not installed */ }
  return null;
}

/**
 * Try to load @vscode/ripgrep from .staff/tools/node_modules/ (container
 * self-install or host fallback install). Uses createRequire so resolution
 * starts inside the tools directory, bypassing host-mounted node_modules.
 */
function tryImportRgPathFromTools(): string | null {
  try {
    const placeholder = path.join(STAFF_TOOLS_DIR, "node_modules", "_noop_.js");
    const toolsRequire = createRequire(placeholder);
    const { rgPath } = toolsRequire("@vscode/ripgrep");
    if (rgPath && fs.existsSync(rgPath)) return rgPath;
  } catch { /* not installed yet */ }
  return null;
}

// Prevent concurrent background installs
let _rgInstalling = false;

/**
 * Fire-and-forget background installation of @vscode/ripgrep into .staff/tools/.
 * Uses stdio:"pipe" to avoid polluting the MCP JSON-RPC channel on stdio transport.
 */
function installRgBackground(): void {
  if (_rgInstalling) return;
  _rgInstalling = true;

  console.log("[staff-mcp] ripgrep not found, installing to .staff/tools/ ...");

  const npmCmd = getPlatformCommand("npm");
  const child = spawn(npmCmd, ["install", "@vscode/ripgrep"], {
    cwd: STAFF_TOOLS_DIR,
    shell: true,
    stdio: "pipe",
  });

  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

  child.on("close", (code) => {
    _rgInstalling = false;
    if (code === 0) {
      console.log("[staff-mcp] ripgrep installed to .staff/tools/");
    } else {
      console.error(
        `[staff-mcp] ripgrep install failed (exit ${code}):`,
        stderr.slice(-300)
      );
    }
  });
}

/**
 * Ensures a tool is available. If not found in .staff or system PATH, 
 * it attempts to install it into .staff/tools.
 */
export async function ensureTool(name: string, installCmd?: string): Promise<string> {
  ensureStaffDirs();

  const binaryName = process.platform === "win32" ? `${name}.exe` : name;
  const staffBinPath = path.join(STAFF_TOOLS_DIR, "bin", binaryName);
  const staffBinPathAlt = path.join(STAFF_TOOLS_DIR, "bin", name); // Fallback for extensionless
  const staffNodeModulesPath = path.join(STAFF_TOOLS_DIR, "node_modules");

  // 1. Check .staff/tools/bin
  if (await exists(staffBinPath)) return staffBinPath;
  if (process.platform === "win32" && await exists(staffBinPathAlt)) return staffBinPathAlt;

  // 2. Check system PATH
  try {
    const checkCmd = process.platform === "win32" ? `where ${name}` : `which ${name}`;
    const { stdout } = await execAsync(checkCmd);
    const resolvedPath = stdout.trim().split("\r\n")[0].split("\n")[0];
    if (resolvedPath) return resolvedPath;
  } catch {}

  // 3. Trigger Auto-Installation if missing
  if (installCmd) {
    console.log(`Tool '${name}' not found. Installing into ${STAFF_TOOLS_DIR}...`);
    
    // Ensure node_modules exists
    if (!fs.existsSync(staffNodeModulesPath)) {
      fs.mkdirSync(staffNodeModulesPath, { recursive: true });
    }

    try {
      // Process the install command for platform compatibility
      const parts = installCmd.split(" ");
      const cmd = getPlatformCommand(parts[0]);
      const args = parts.slice(1);
      
      return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { 
          cwd: STAFF_TOOLS_DIR,
          shell: true,
          stdio: "inherit" 
        });
        proc.on("close", (code) => {
          if (code === 0) {
            console.log(`Successfully installed ${name}.`);
            // Try to find it again after installation
            ensureTool(name).then(resolve).catch(reject);
          } else {
            reject(new Error(`Installation of ${name} failed with code ${code}`));
          }
        });
      });
    } catch (e: any) {
      throw new Error(`Failed to run install command for ${name}: ${e.message}`);
    }
  }

  throw new Error(`Tool '${name}' is not available and no install command was provided.`);
}

/**
 * Resolves the path to the ripgrep (rg) binary.
 *
 * Look-up order:
 *   1. System PATH              — fastest, always correct platform
 *   2. Bundled @vscode/ripgrep  — from staff-mcp's own node_modules
 *   3. .staff/tools/ install    — container self-install / host fallback
 *
 * If none found, triggers an async background installation to .staff/tools/
 * and returns null so the caller can fall back to JS search for this request.
 */
export async function ensureRipgrep(): Promise<string | null> {
  // 1. System rg
  const systemRg = await whichAsync("rg");
  if (systemRg) return systemRg;

  // 2. Bundled dependency (skipped naturally in cross-platform Docker)
  const bundledRg = await tryImportRgPath();
  if (bundledRg) return bundledRg;

  // 3. .staff/tools/ self-install
  const toolsRg = tryImportRgPathFromTools();
  if (toolsRg) return toolsRg;

  // 4. None available — install in background, fall back to JS for this request
  installRgBackground();
  return null;
}
