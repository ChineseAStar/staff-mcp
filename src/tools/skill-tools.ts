import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SkillManager, SkillInfo } from "./skill-manager.js";
import * as fs from "fs/promises";
import * as path from "path";
import { SecurityManager } from "../security.js";

export function registerSkillTools(server: McpServer, workingDir: string, security: SecurityManager) {
  const skillsMap = SkillManager.loadSkills(workingDir);
  const list = Object.values(skillsMap);

  // skill
  const description = list.length === 0
    ? "Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available."
    : [
        "The following skills provide specialized sets of instructions for particular tasks",
        "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
        "",
        "<available_skills>",
        ...list.flatMap((skill) => [
          `  <skill>`,
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `  </skill>`,
        ]),
        "</available_skills>",
      ].join("\n");

  const examples = list.map((skill) => `'${skill.name}'`).slice(0, 3).join(", ");
  const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : "";

  server.registerTool(
    "skill",
    {
      description: description,
      inputSchema: z.object({
        name: z.string().describe(`The name of the skill from available_skills${hint}`),
      }).strict(),
    },
    async ({ name }) => {
      const skill = skillsMap[name];

      if (!skill) {
        const available = list.map((s) => s.name).join(", ");
        throw new Error(`Skill "${name}" not found. Available skills: ${available || "none"}`);
      }

      return {
        content: [{
          type: "text",
          text: buildSkillOutput(skill)
        }]
      };
    }
  );

  // read_skill_file
  server.registerTool(
    "read_skill_file",
    {
      description: "Read the contents of a file associated with a specific loaded skill.",
      inputSchema: z.object({
        skillName: z.string().describe('The name of the skill (e.g., "react-component")'),
        relativePath: z.string().describe('The relative path of the file to read (e.g., "templates/Component.tsx")')
      }).strict(),
    },
    async ({ skillName, relativePath }) => {
      const skill = skillsMap[skillName];

      if (!skill) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Skill "${skillName}" not found.` }]
        };
      }

      const baseDir = path.dirname(skill.location);
      const targetPath = path.resolve(baseDir, relativePath);

      // Security check: ensure targetPath is within baseDir
      if (!targetPath.startsWith(baseDir)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Security Error: Access denied. Cannot read files outside skill directory.` }]
        };
      }

      try {
        const content = await fs.readFile(targetPath, "utf-8");
        return {
          content: [{
            type: "text",
            text: content
          }]
        };
      } catch (e: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to read skill file: ${e.message}` }]
        };
      }
    }
  );

  // Register Prompts
  for (const skill of list) {
    server.registerPrompt(
      skill.name,
      {
        description: skill.description,
        argsSchema: {}
      },
      () => {
        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: buildSkillOutput(skill)
              }
            }
          ]
        };
      }
    );
  }
}

function buildSkillOutput(skill: SkillInfo): string {
  const dir = path.dirname(skill.location);
  
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.content.trim(),
    "",
    `Base directory: ${dir}`,
    "Relative paths in this skill are relative to this base directory.",
    "</skill_content>"
  ].join("\n");
}
