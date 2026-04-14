import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SecurityManager } from "../security.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { lspManager } from "../lsp/manager.js";
import { ensureRipgrep } from "../utils/tool-utils.js";

const execAsync = promisify(exec);

/**
 * Registers file-related tools using the latest registerTool API.
 */
export function registerFileTools(server: McpServer, security: SecurityManager) {
  // read_file
  server.registerTool(
    "read_file",
    {
      description: "Read the content of a file from the allowed workspace.",
      inputSchema: z.object({
        path: z.string().describe("Relative path from the workspace to the file to read."),
        startLine: z.number().optional().describe("1-based line number to start reading from."),
        endLine: z.number().optional().describe("1-based line number to end reading at (inclusive)."),
      }).strict(),
    },
    async ({ path: filePath, startLine, endLine }) => {
      try {
        const validatedPath = security.resolveAndValidatePath(filePath);
        const fullContent = await fs.readFile(validatedPath, "utf-8");
        const lines = fullContent.split(/\r?\n/);

        let contentLines = lines;
        let prefix = "";

        if (startLine !== undefined || endLine !== undefined) {
          const start = startLine ? Math.max(0, startLine - 1) : 0;
          const end = endLine ? Math.min(lines.length, endLine) : lines.length;
          contentLines = lines.slice(start, end);
          prefix = `Showing lines ${start + 1}-${end} of ${lines.length}:\n`;
        }

        let content = contentLines.join("\n");

        if (content.length > CHARACTER_LIMIT) {
          content = content.substring(0, CHARACTER_LIMIT) + "\n\n...[Content truncated for brevity]";
        }

        return {
          content: [{ type: "text", text: prefix + content }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error reading file: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // edit_file_by_replace
  server.registerTool(
    "edit_file_by_replace",
    {
      description: "Replace a specific block of text in a file with new content. Use this for precise edits.",
      inputSchema: z.object({
        path: z.string().describe("Path to the file to edit."),
        oldText: z.string().describe("The exact text block to be replaced. Be as specific as possible to avoid wrong matches."),
        newText: z.string().describe("The new text content to replace with."),
      }).strict(),
    },
    async ({ path: filePath, oldText: originalOldText, newText }) => {
      try {
        const validatedPath = security.resolveAndValidatePath(filePath);
        const content = await fs.readFile(validatedPath, "utf-8");

        let oldText = originalOldText;
        let index = content.indexOf(oldText);

        // If exact match fails, try fuzzy matching (ignoring whitespace differences)
        if (index === -1) {
          const escapedOld = originalOldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Replace whitespace sequences with \s+ to match any whitespace
          const fuzzyRegex = new RegExp(escapedOld.replace(/\s+/g, '\\s+'), 'g');
          const matches = [...content.matchAll(fuzzyRegex)];
          
          if (matches.length === 1) {
             index = matches[0].index!;
             oldText = matches[0][0]; // Use the actual matched text for replacement
          } else if (matches.length > 1) {
             return {
               content: [{ type: "text", text: `Error: Multiple fuzzy matches found for the provided text. Please provide more context to uniquely identify the block.` }],
               isError: true,
             };
          }
        }

        if (index === -1) {
          return {
            content: [{ type: "text", text: `Error: Could not find the text block to replace in ${filePath}. Ensure the text matches exactly (including whitespace) or provide more surrounding context.` }],
            isError: true,
          };
        }

        const updatedContent = content.slice(0, index) + newText + content.slice(index + oldText.length);
        await fs.writeFile(validatedPath, updatedContent, "utf-8");

        let response = `Successfully updated ${filePath}`;
        
        // Add diagnostics feedback
        const rootPath = security.getWorkingDir();
        const diagnostics = await lspManager.getDiagnostics(validatedPath, rootPath);
        if (diagnostics && diagnostics.length > 0) {
          const formatted = diagnostics.map((d: any) => 
            `[Line ${d.range.start.line + 1}] ${d.message}`
          ).join("\n");
          response += `\n\nWarning: LSP diagnostics found after editing:\n${formatted}`;
        }

        return {
          content: [{ type: "text", text: response }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error editing file: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // write_file
  server.registerTool(
    "write_file",
    {
      description: "Write or overwrite a file in the allowed workspace.",
      inputSchema: z.object({
        path: z.string().describe("Path to the file to write."),
        content: z.string().describe("Content to write into the file."),
      }).strict(),
    },
    async ({ path: filePath, content }) => {
      try {
        const validatedPath = security.resolveAndValidatePath(filePath);
        await fs.mkdir(path.dirname(validatedPath), { recursive: true });
        await fs.writeFile(validatedPath, content, "utf-8");

        let response = `Successfully wrote file: ${filePath}`;
        
        // Add diagnostics feedback
        const rootPath = security.getWorkingDir();
        const diagnostics = await lspManager.getDiagnostics(validatedPath, rootPath);
        if (diagnostics && diagnostics.length > 0) {
          const formatted = diagnostics.map((d: any) => 
            `[Line ${d.range.start.line + 1}] ${d.message}`
          ).join("\n");
          response += `\n\nWarning: LSP diagnostics found after writing:\n${formatted}`;
        }

        return {
          content: [{ type: "text", text: response }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error writing file: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // delete_file
  server.registerTool(
    "delete_file",
    {
      description: "Delete a file from the allowed workspace.",
      inputSchema: z.object({
        path: z.string().describe("Path to the file to delete."),
      }).strict(),
    },
    async ({ path: filePath }) => {
      try {
        const validatedPath = security.resolveAndValidatePath(filePath);
        await fs.unlink(validatedPath);

        return {
          content: [{ type: "text", text: `Successfully deleted file: ${filePath}` }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error deleting file: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // list_dir
  server.registerTool(
    "list_dir",
    {
      description: "List files and directories within a specific path.",
      inputSchema: z.object({
        path: z.string().default(".").describe("Path to list (defaults to workspace root)."),
      }).strict(),
    },
    async ({ path: dirPath }) => {
      try {
        const validatedPath = security.resolveAndValidatePath(dirPath);
        const entries = await fs.readdir(validatedPath, { withFileTypes: true });

        const result = entries.map(entry => {
          return `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`;
        }).join("\n");

        return {
          content: [{ type: "text", text: result || "(Directory is empty)" }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error listing directory: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // search_file_content
  server.registerTool(
    "search_file_content",
    {
      description: "Perform a global search for a pattern across all files in the project. Supports regex, case-sensitivity, and glob filters.",
      inputSchema: z.object({
        regex: z.string().describe("The pattern to search for (regex supported)."),
        includeGlob: z.string().optional().describe("Glob pattern to limit the search (e.g. 'src/**/*.ts')."),
        excludeGlob: z.string().optional().describe("Glob pattern to exclude from the search (e.g. 'node_modules/**')."),
        caseSensitive: z.boolean().optional().describe("Whether the search should be case-sensitive (default: false)."),
        wholeWord: z.boolean().optional().describe("Whether to match whole words only (default: false)."),
      }).strict(),
    },
    async ({ regex, includeGlob, excludeGlob, caseSensitive = false, wholeWord = false }) => {
      try {
        const baseDir = security.resolveAndValidatePath(".");
        const rgPath = await ensureRipgrep();
        
        if (rgPath) {
          try {
            let args = ["--line-number", "--column", "--no-heading", "--color", "never"];
            if (!caseSensitive) args.push("--ignore-case");
            if (wholeWord) args.push("--word-regexp");
            if (includeGlob) {
               args.push("--glob");
               args.push(includeGlob);
            }
            if (excludeGlob) {
               args.push("--glob");
               args.push(`!${excludeGlob}`);
            }
            
            args.push("--");
            args.push(regex);
            args.push(baseDir);

            // Use double quotes for all arguments to be safe on Windows
            const command = `"${rgPath}" ${args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`;
            const { stdout } = await execAsync(command);
            const lines = stdout.trim().split("\n").filter(l => l.length > 0);
            
            const formatted = lines.slice(0, 100).map(line => {
               // Robust parsing for path:line:col:text, considering Windows drive letters
               const match = line.match(/^((?:[a-zA-Z]:)?[^:]+):(\d+):(\d+):(.*)$/);
               if (match) {
                  const [_, absPath, lineNum, colNum, context] = match;
                  const relPath = path.relative(baseDir, absPath);
                  return `${relPath}:${lineNum} - ${context.trim()}`;
               }
               return line;
            });

            if (lines.length > 100) {
              formatted.push("... [Search results truncated after 100 matches]");
            }

            return {
              content: [{ type: "text", text: formatted.join("\n") || "No matches found." }],
            };
          } catch (rgError: any) {
             if (rgError.code === 1) { // rg exit code 1 means no matches
                return { content: [{ type: "text", text: "No matches found." }] };
             }
             // If rg failed for other reasons, fall back to JS
          }
        }

        // JS Fallback
        const results: string[] = [];
        const searchRegex = new RegExp(wholeWord ? `\\b${regex}\\b` : regex, caseSensitive ? "g" : "gi");

        async function searchRecursively(currentDir: string) {
          const entries = await fs.readdir(currentDir, { withFileTypes: true });

          for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            const relPath = path.relative(baseDir, fullPath);

            if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) continue;

            if (entry.isDirectory()) {
              await searchRecursively(fullPath);
            } else if (entry.isFile()) {
              if (includeGlob && !relPath.includes(includeGlob.replace(/\*/g, ""))) continue;
              if (excludeGlob && relPath.includes(excludeGlob.replace(/\*/g, ""))) continue;

              try {
                const content = await fs.readFile(fullPath, "utf-8");
                if (content.includes("\0")) continue;

                let match;
                while ((match = searchRegex.exec(content)) !== null) {
                  const lineNum = content.substring(0, match.index).split(/\r?\n/).length;
                  const context = content.split(/\r?\n/)[lineNum - 1];
                  results.push(`${relPath}:${lineNum} - ${context.trim()}`);
                  
                  if (results.length > 100) {
                    results.push("... [Search results truncated after 100 matches]");
                    return;
                  }
                }
              } catch (e) {}
            }
          }
        }

        await searchRecursively(baseDir);
        return {
          content: [{ type: "text", text: results.join("\n") || "No matches found." }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error during search: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
