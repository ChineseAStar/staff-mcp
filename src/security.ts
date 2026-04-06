import * as path from "path";

export class SecurityManager {
  private allowedDirs: string[];
  private workingDir: string;

  constructor(workingDir: string, allowedDirs: string[] = []) {
    this.workingDir = path.resolve(workingDir);
    // Working directory is always allowed
    const resolvedAllowedDirs = allowedDirs.map(dir => path.resolve(dir));
    this.allowedDirs = Array.from(new Set([this.workingDir, ...resolvedAllowedDirs]));
  }

  /**
   * Resolves a target path and ensures it lies within one of the allowed directories.
   * @param targetPath The relative or absolute path requested.
   * @param cwd Optional base directory for resolution (must also be validated if provided).
   * @returns The absolute, validated path.
   * @throws Error if the path is outside the allowed sandbox.
   */
  public resolveAndValidatePath(targetPath: string, cwd?: string): string {
    const base = cwd ? path.resolve(cwd) : this.workingDir;
    
    const resolvedPath = path.resolve(base, targetPath);

    const isAllowed = this.allowedDirs.some(allowedDir => {
      const relative = path.relative(allowedDir, resolvedPath);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    });

    if (!isAllowed) {
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

    if (!isAllowed) {
      throw new Error(`Security Error: Directory "${resolved}" is not in the allowed list.`);
    }
    return resolved;
  }

  public getAllowedDirs(): string[] {
    return [...this.allowedDirs];
  }
}
