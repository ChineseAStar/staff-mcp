import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SKILL_SUBDIRS = ["skills", "skill"];

/**
 * 获取技能的级联搜索路径 (Cascade Order)
 * 优先级从高到低（仅使用 .staff 目录体系）：
 * 1. 项目级: {cwd}/.staff/skills
 * 2. 项目级角色层: {cwd}/.staff/profiles/{profile}/skills
 * 3. 全局级角色层: ~/.staff/profiles/{profile}/skills
 * 4. 全局默认层: ~/.staff/skills
 * 5. 内置基建层: staff-mcp/builtin-profiles/common
 *
 * 同名 skill 冲突时，高优先级覆盖低优先级。
 * Profile 是加性参数：第1级和第4级不受 profile 影响，永远被加载。
 */
export function getSearchPaths(workingDir: string, profile: string = "default"): string[] {
  const searchPaths: string[] = [];
  const homeDir = process.env.STAFF_GLOBAL_DIR ? path.dirname(process.env.STAFF_GLOBAL_DIR) : os.homedir();

  // 辅助函数：在指定基准目录 + .staff + 子路径下生成搜索路径
  const addStaffPaths = (basePaths: string[], suffixes: string[]) => {
    basePaths.forEach(base => {
      suffixes.forEach(suffix => {
        searchPaths.push(path.join(base, ".staff", suffix));
      });
    });
  };

  // 1. 项目级: {cwd}/.staff/skills, {cwd}/.staff/skill
  addStaffPaths([workingDir], SKILL_SUBDIRS);

  // 2 & 3. 角色层: {cwd,~}/.staff/profiles/{profile}/skills
  const profileSubdirs = SKILL_SUBDIRS.map(sub => path.join("profiles", profile, sub));
  addStaffPaths([workingDir, homeDir], profileSubdirs);

  // 4. 全局默认层: ~/.staff/skills, ~/.staff/skill
  addStaffPaths([homeDir], SKILL_SUBDIRS);

  // 5. 内置基建层
  let root = __dirname;
  while (!fs.existsSync(path.join(root, "package.json")) && root !== path.dirname(root)) {
      root = path.dirname(root);
  }

  if (profile !== "default") {
    searchPaths.push(path.join(root, "builtin-profiles", profile));
  }
  searchPaths.push(path.join(root, "builtin-profiles", "common"));

  return searchPaths;
}
