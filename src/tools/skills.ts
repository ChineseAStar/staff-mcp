import { McpServer, RegisteredPrompt, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SkillManager, SkillInfo } from "../skills/manager.js";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { SecurityManager } from "../security.js";

export function registerSkillTools(server: McpServer, workingDir: string, security: SecurityManager, profile: string = "default") {
  let skillsMap = SkillManager.loadSkills(workingDir, profile);
  const promptMap = new Map<string, RegisteredPrompt>();

  const getToolDescription = (list: SkillInfo[]) => {
    return list.length === 0
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
  };

  const skillTool = server.registerTool(
    "skill",
    {
      description: getToolDescription(Object.values(skillsMap)),
      inputSchema: z.object({
        name: z.string().describe(`The name of the skill from available_skills`),
      }).strict(),
    },
    async ({ name }) => {
      skillsMap = SkillManager.loadSkills(workingDir, profile);
      const skill = skillsMap[name];

      if (!skill) {
        const available = Object.keys(skillsMap).join(", ");
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

  const promptDescMap = new Map<string, string>();
  let currentToolDescription = getToolDescription(Object.values(skillsMap));

  const refreshPrompts = () => {
    const list = Object.values(skillsMap);
    
    const newToolDescription = getToolDescription(list);
    if (newToolDescription !== currentToolDescription) {
      currentToolDescription = newToolDescription;
      skillTool.update({ description: currentToolDescription });
    }
    
    // Intercept sendPromptListChanged to batch notifications
    let promptsChanged = false;
    const originalSendPromptListChanged = server.sendPromptListChanged;
    
    if (typeof originalSendPromptListChanged === "function") {
      server.sendPromptListChanged = () => {
        promptsChanged = true;
      };
    }
    
    try {
      // Remove old prompts that are no longer in skillsMap
      for (const name of promptMap.keys()) {
        if (!skillsMap[name]) {
          const registered = promptMap.get(name)!;
          registered.remove();
          promptMap.delete(name);
          promptDescMap.delete(name);
        }
      }

      // Add or update prompts
      for (const skill of list) {
        const oldDesc = promptDescMap.get(skill.name);
        
        const callbackFn = () => {
          const latestSkill = skillsMap[skill.name];
          return {
            messages: [
              {
                role: "user" as const,
                content: {
                  type: "text" as const,
                  text: latestSkill ? buildSkillOutput(latestSkill) : "Skill not found"
                }
              }
            ]
          };
        };

        if (promptMap.has(skill.name)) {
          if (oldDesc !== skill.description) {
            promptMap.get(skill.name)!.update({
              description: skill.description,
              callback: callbackFn
            });
            promptDescMap.set(skill.name, skill.description);
          }
        } else {
          const registered = server.registerPrompt(
            skill.name,
            {
              description: skill.description,
              argsSchema: {}
            },
            callbackFn
          );
          promptMap.set(skill.name, registered);
          promptDescMap.set(skill.name, skill.description);
        }
      }
    } finally {
      // Restore and trigger one final notification if anything changed
      if (typeof originalSendPromptListChanged === "function") {
        server.sendPromptListChanged = originalSendPromptListChanged;
        if (promptsChanged) {
          server.sendPromptListChanged();
        }
      }
    }
  };

  refreshPrompts();

  // Ensure prompt capabilities are registered even if the initial skillsMap is empty
  if (promptMap.size === 0) {
    const dummy = server.registerPrompt("_dummy_", { description: "dummy" }, () => ({ messages: [] }));
    dummy.remove();
  }

  // Watcher logic
  const watchPaths = SkillManager.getSearchPaths(workingDir, profile);

  let watchTimeout: NodeJS.Timeout | null = null;
  const DEBOUNCE_MS = 1000; // 1秒防抖

  const handleWatchEvent = (event: string, filename: string | null) => {
    if (watchTimeout) {
      clearTimeout(watchTimeout);
    }
    
    watchTimeout = setTimeout(() => {
      try {
        skillsMap = SkillManager.loadSkills(workingDir, profile);
        refreshPrompts();
      } catch (err) {
        console.error("[SkillTools] Error reloading skills after file change:", err);
      }
    }, DEBOUNCE_MS);
  };

  const dirsToWatch = new Set(watchPaths.map(p => path.dirname(p)));

  dirsToWatch.forEach(parentDir => {
    if (fsSync.existsSync(parentDir)) {
      try {
        fsSync.watch(parentDir, { recursive: true }, handleWatchEvent);
      } catch (e) {
        console.error(`[SkillTools] Failed to watch ${parentDir}:`, e);
      }
    }
  });
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
