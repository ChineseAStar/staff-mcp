import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
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
    const skills: Record<string, SkillInfo> = {};
    const searchPaths = this.getSearchPaths(workingDir, profile);

    // 扫描所有有效路径
    for (const root of searchPaths) {
      if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
        this.scanDirSync(root, skills);
      }
    }

    return skills;
  }

  private static scanDirSync(dir: string, skills: Record<string, SkillInfo>) {
    try {
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
      const fileContent = fs.readFileSync(filePath, "utf-8");
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
    } catch (e) {
      console.error(`[SkillManager] Failed to load skill from ${filePath}`, e);
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
