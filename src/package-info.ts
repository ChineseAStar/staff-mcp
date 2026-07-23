import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  name?: unknown;
  version?: unknown;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate the installed staff-mcp package root from either src/ (development)
 * or dist/src/ (compiled/published package).
 */
export function findPackageRoot(startDir: string = moduleDir): string {
  let currentDir = path.resolve(startDir);

  while (true) {
    const manifestPath = path.join(currentDir, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PackageManifest;
      if (manifest.name === "staff-mcp") {
        return currentDir;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`[staff-mcp] Unable to locate package.json from ${startDir}`);
    }
    currentDir = parentDir;
  }
}

export function readPackageVersion(packageRoot: string): string {
  const manifestPath = path.join(packageRoot, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PackageManifest;

  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`[staff-mcp] Invalid package version in ${manifestPath}`);
  }

  return manifest.version;
}

export const STAFF_MCP_PACKAGE_ROOT = findPackageRoot();
export const STAFF_MCP_VERSION = readPackageVersion(STAFF_MCP_PACKAGE_ROOT);
