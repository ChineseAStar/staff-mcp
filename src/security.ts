import * as path from "path";

export class SecurityManager {
  private allowedDirs: string[];
  private workingDir: string;
  public readonly mode: "host" | "container";

  constructor(workingDir: string, allowedDirs: string[] = []) {
    // Only the exact trusted launcher marker enables container-wide tool paths.
    // Capture once so factories and instructions cannot disagree after env changes.
    this.mode = process.env.STAFF_MCP_IS_DOCKER === "1" ? "container" : "host";
    this.workingDir = path.resolve(workingDir);
    // Working directory is always allowed
    const resolvedAllowedDirs = allowedDirs.map(dir => path.resolve(dir));
    this.allowedDirs = Array.from(new Set([this.workingDir, ...resolvedAllowedDirs]));
  }

  /**
   * Resolves a tool path; Host mode requires a configured allowed directory.
   * @param targetPath The relative or absolute path requested.
   * @param cwd Optional base directory for resolution (must also be validated if provided).
   * @returns The absolute, validated path.
   * @throws Error if a Host path is outside the configured allowed directories.
   */
  public resolveAndValidatePath(targetPath: string, cwd?: string): string {
    const base = cwd ? path.resolve(cwd) : this.workingDir;
    
    const resolvedPath = path.resolve(base, targetPath);

    const isAllowed = this.allowedDirs.some(allowedDir => {
      const relative = path.relative(allowedDir, resolvedPath);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    });

    if (this.mode === "host" && !isAllowed) {
      throw new Error(`Security Error: Path "${resolvedPath}" is outside the allowed directories.`);
    }

    return resolvedPath;
  }

  /**
   * Validates if a specific directory is allowed.
   */
  /**
   * Validates if a specific directory is allowed.
   */
  public validateDirectory(dirPath: string): string {
    const resolved = path.resolve(this.workingDir, dirPath);
    const isAllowed = this.allowedDirs.some(allowedDir => {
      const relative = path.relative(allowedDir, resolved);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    });

    if (this.mode === "host" && !isAllowed) {
      throw new Error(`Security Error: Directory "${resolved}" is not in the allowed list.`);
    }
    return resolved;
  }

  public getAllowedDirs(): string[] {
    return [...this.allowedDirs];
  }

  public getWorkingDir(): string {
    return this.workingDir;
  }
}
