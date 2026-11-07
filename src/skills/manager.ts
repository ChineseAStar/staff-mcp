import * as fs from "fs";
import * as path from "path";
import * as fsp from "fs/promises";
import * as yaml from "js-yaml";
import { SKILL_LIMITS } from "@modelcontextprotocol/server/ext/skills";
import { getSearchPaths } from "./resolver.js";

export interface SkillInfo {
  name: string;
  description: string;
  location: string;
  content: string;
}

export class SkillManager {
  static getSearchPaths(workingDir: string, profile: string = "default"): string[] {
    return getSearchPaths(workingDir, profile);
  }

  static loadSkills(workingDir: string, profile: string = "default"): Record<string, SkillInfo> {
    const skills: Record<string, SkillInfo> = Object.create(null);
    const searchPaths = this.getSearchPaths(workingDir, profile);

    // 扫描所有有效路径
    for (const root of searchPaths) {
      try {
        this.validateDirectorySync(root);
        this.scanDirSync(root, skills);
      } catch {
        // Missing or unsafe search roots do not participate in selection.
      }
    }

    return skills;
  }

  /** Skills authorize their own selected directory, independently of ordinary file roots. */
  static async getSkillDirectory(skill: SkillInfo): Promise<string> {
    const directory = path.resolve(path.dirname(skill.location));
    const root = path.parse(directory).root;
    let current = root;
    for (const component of path.relative(root, directory).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(
          "Security Error: Skill directory must not contain symlinks or special files.",
        );
      }
    }
    return fsp.realpath(directory);
  }

  static validateSkillRelativePath(relativePath: string): string[] {
    const components = relativePath.split("/");
    if (
      path.isAbsolute(relativePath) ||
      path.win32.isAbsolute(relativePath) ||
      relativePath.includes("\\") ||
      relativePath.includes("\0") ||
      /%(?:2e|2f|5c|25)/i.test(relativePath) ||
      components.some((component) => component === "" || component === "." || component === "..")
    ) {
      throw new Error("Security Error: Access denied. Invalid skill-relative file path.");
    }
    return components;
  }

  /** No traversal, symlinks or special files; bounded raw reads for standard manifests. */
  static async readSkillFile(
    skill: SkillInfo,
    relativePath: string,
    maxBytes = Infinity,
  ): Promise<Buffer> {
    const components = this.validateSkillRelativePath(relativePath);
    const baseDir = await this.getSkillDirectory(skill);
    let target = baseDir;
    for (const [index, component] of components.entries()) {
      target = path.join(target, component);
      const stat = await fsp.lstat(target);
      const last = index === components.length - 1;
      if (stat.isSymbolicLink() || (last ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error("Security Error: Skill files must be regular files without symlinks.");
      }
    }
    const checkBoundary = async () => {
      const relative = path.relative(baseDir, await fsp.realpath(target));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Security Error: Cannot read files outside skill directory.");
      }
    };
    await checkBoundary();
    const before = await fsp.lstat(target);
    const file = await fsp.open(
      target,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        before.isSymbolicLink() ||
        stat.dev !== before.dev ||
        stat.ino !== before.ino
      ) {
        throw new Error("Security Error: Skill file is not a stable regular file.");
      }
      if (stat.size > maxBytes) throw new Error("Skill exceeds its byte budget.");
      await checkBoundary();
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes) throw new Error("Skill exceeds its byte budget.");
        chunks.push(chunk.subarray(0, bytesRead));
      }
      await checkBoundary();
      return Buffer.concat(chunks, total);
    } finally {
      await file.close();
    }
  }

  private static validateDirectorySync(directory: string): string {
    const absolute = path.resolve(directory);
    let current = path.parse(absolute).root;
    for (const component of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Skill directory must not contain symlinks or special files.");
      }
    }
    return fs.realpathSync(absolute);
  }

  /** Scanning feeds legacy tools/prompts too, so reject unsafe files before parsing. */
  private static readManifestSync(filePath: string): string {
    const directory = this.validateDirectorySync(path.dirname(filePath));
    const target = path.join(directory, path.basename(filePath));
    const before = fs.lstatSync(target);
    if (before.isSymbolicLink() || !before.isFile() || before.size > SKILL_LIMITS.bytes) {
      throw new Error("Skill manifest must be a bounded regular file without symlinks.");
    }
    const file = fs.openSync(
      target,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const stat = fs.fstatSync(file);
      if (
        !stat.isFile() ||
        stat.dev !== before.dev ||
        stat.ino !== before.ino ||
        stat.size > SKILL_LIMITS.bytes
      ) {
        throw new Error("Skill manifest is not a stable bounded regular file.");
      }
      const checkBoundary = () => {
        this.validateDirectorySync(directory);
        const real = fs.realpathSync(target);
        const current = fs.lstatSync(target);
        if (
          real !== target ||
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.dev !== stat.dev ||
          current.ino !== stat.ino
        ) {
          throw new Error("Skill manifest changed during scanning.");
        }
      };
      checkBoundary();
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, SKILL_LIMITS.bytes - total + 1));
        const bytesRead = fs.readSync(file, chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > SKILL_LIMITS.bytes) throw new Error("Skill manifest exceeds its byte budget.");
        chunks.push(chunk.subarray(0, bytesRead));
      }
      checkBoundary();
      return Buffer.concat(chunks, total).toString("utf-8");
    } finally {
      fs.closeSync(file);
    }
  }

  private static scanDirSync(dir: string, skills: Record<string, SkillInfo>) {
    try {
      this.validateDirectorySync(dir);
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        // 跳过常见的忽略目录
        if (entry.name === "node_modules" || entry.name === ".git") continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // 递归搜索子目录
          this.scanDirSync(fullPath, skills);
        } else if (entry.name === "SKILL.md") {
          this.addSkillSync(fullPath, skills);
        }
      }
    } catch (e) {
      // 忽略读取错误
    }
  }

  private static addSkillSync(filePath: string, skills: Record<string, SkillInfo>) {
    try {
      const fileContent = this.readManifestSync(filePath);
      const { data, content } = this.parseMarkdown(fileContent);

      // 确保有必要的元数据
      if (data.name && data.description) {
        // 如果名称冲突，优先保留先扫描到的（优先级高的路径在前）
        if (!skills[data.name]) {
          skills[data.name] = {
            name: data.name,
            description: data.description,
            location: filePath,
            content: content.trim(),
          };
        }
      }
    } catch {
      console.warn("[SkillManager] Skill manifest omitted: unreadable, unsafe or oversized.");
    }
  }

  private static parseMarkdown(content: string) {
    // 匹配 Markdown Frontmatter (--- yaml --- content)
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return { data: {}, content };

    const yamlStr = match[1];
    const body = match[2];
    const data: Record<string, string> = {};

    try {
      const parsed = yaml.load(yamlStr);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (value !== null && value !== undefined) {
            data[key] = String(value);
          }
        }
      }
    } catch (e) {
      console.error(`[SkillManager] Failed to parse YAML frontmatter:`, e);
    }
    return { data, content: body };
  }
}
