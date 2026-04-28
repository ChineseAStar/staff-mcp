import * as path from "path";
import * as fs from "fs";
import { exec, spawn } from "child_process";
import { promisify } from "util";
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

  // 3. Check node_modules in .staff/tools
  if (name === "rg") {
    // Special check for @vscode/ripgrep if installed in the tool directory
    const rgInStaff = path.join(staffNodeModulesPath, "@vscode", "ripgrep", "bin", binaryName);
    if (await exists(rgInStaff)) return rgInStaff;
  }

  // 4. Trigger Auto-Installation if missing
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
 * Specialized version for ripgrep since it's a critical dependency.
 * If not found, it triggers an async background installation to prevent blocking
 * the current search request, allowing it to gracefully fall back to JS search.
 */
export async function ensureRipgrep(): Promise<string | null> {
  // 1. Try to find it in the project's own node_modules
  const localRgPaths = process.platform === "win32" ? [
    path.join(process.cwd(), "node_modules", "@vscode", "ripgrep", "bin", "rg.exe"),
    path.join(process.cwd(), "node_modules", "vscode-ripgrep", "bin", "rg.exe"),
  ] : [
    path.join(process.cwd(), "node_modules", "@vscode", "ripgrep", "bin", "rg"),
    path.join(process.cwd(), "node_modules", "vscode-ripgrep", "bin", "rg"),
  ];

  for (const p of localRgPaths) {
    if (await exists(p)) return p;
  }

  // 2. Check .staff/tools or global PATH without triggering blocking installation
  try {
    return await ensureTool("rg");
  } catch (e) {
    // 3. Not found anywhere. Trigger a background installation.
    // We do NOT await this promise, so the current search will return null instantly 
    // and fallback to JS, but next time it might be available.
    console.log("[Background Task] Ripgrep not found. Initiating async background installation...");
    ensureTool("rg", "npm install @vscode/ripgrep").catch(err => {
      console.error("[Background Task] Failed to install ripgrep async:", err.message);
    });

    // Return null to signal fallback for THIS specific request.
    return null;
  }
}
