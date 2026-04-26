import * as os from "os";
import * as path from "path";
import * as fs from "fs";

export const STAFF_DIR = path.join(os.homedir(), ".staff");
export const STAFF_TOOLS_DIR = path.join(STAFF_DIR, "tools");
export const STAFF_SKILLS_DIR = path.join(STAFF_DIR, "skills");
export const STAFF_PROFILES_DIR = path.join(STAFF_DIR, "profiles");

/**
 * Ensures the core .staff directories exist.
 */
export function ensureStaffDirs() {
  [STAFF_DIR, STAFF_TOOLS_DIR, STAFF_SKILLS_DIR, STAFF_PROFILES_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}
