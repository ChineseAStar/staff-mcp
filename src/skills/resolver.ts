import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 搜索隐藏目录名称
export const SEARCH_DIRS = [".staff", ".claude", ".agents", ".opencode"];
export const SKILL_SUBDIRS = ["skills", "skill"];

/**
 * 获取技能的级联搜索路径 (Cascade Order)
 * 优先级从高到低：
 * 1. 项目级: {cwd}/.staff/skills
 * 2. 项目级角色层: {cwd}/.staff/profiles/{profile_name}/skills
 * 3. 全局级角色层: ~/.staff/profiles/{profile_name}/skills
 * 4. 全局默认层: ~/.staff/skills
 * 5. 内置基建层: staff-mcp/builtin-profiles/common
 */
export function getSearchPaths(workingDir: string, profile: string = "default"): string[] {
  const searchPaths: string[] = [];
  const homeDir = os.homedir();

  // 辅助函数：构造特定基准目录下的所有变体路径
  const addVariations = (basePaths: string[], suffixes: string[]) => {
    basePaths.forEach(base => {
      SEARCH_DIRS.forEach(dir => {
        suffixes.forEach(suffix => {
          searchPaths.push(path.join(base, dir, suffix));
        });
      });
    });
  };

  // 1. 项目级
  addVariations([workingDir], SKILL_SUBDIRS);

  // 2 & 3. 角色层
  const profileSubdirs = SKILL_SUBDIRS.map(sub => path.join("profiles", profile, sub));
  addVariations([workingDir, homeDir], profileSubdirs);

  // 4. 全局默认层
  addVariations([homeDir], SKILL_SUBDIRS);

  // 5. 内置基建层
  let root = path.resolve(__dirname, "..");
  while (!fs.existsSync(path.join(root, "package.json")) && root !== "/") {
      root = path.dirname(root);
  }
  
  if (profile !== "default") {
    searchPaths.push(path.join(root, "builtin-profiles", profile));
  }
  searchPaths.push(path.join(root, "builtin-profiles", "common"));

  return searchPaths;
}
