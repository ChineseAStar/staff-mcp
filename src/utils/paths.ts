import * as os from "os";
import * as path from "path";
import * as fs from "fs";

export const STAFF_DIR = path.join(os.homedir(), ".staff");
export const STAFF_TOOLS_DIR = path.join(STAFF_DIR, "tools");

/**
 * Ensures the core .staff directories exist.
 */
export function ensureStaffDirs() {
  [STAFF_DIR, STAFF_TOOLS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}
