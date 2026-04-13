import * as fs from "fs/promises";
import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SecurityManager } from "../security.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { lspManager } from "../lsp/manager.js";

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
    async ({ path: filePath, oldText, newText }) => {
      try {
        const validatedPath = security.resolveAndValidatePath(filePath);
        const content = await fs.readFile(validatedPath, "utf-8");

        // Simple fuzzy match: try exact first, then trimmed
        let index = content.indexOf(oldText);

        if (index === -1) {
          // Try fuzzy: trim and normalize line endings
          const normalize = (s: string) => s.replace(/\r\n/g, "\n").trim();
          const normalizedContent = normalize(content);
          const normalizedOld = normalize(oldText);
          
          if (normalizedContent.includes(normalizedOld)) {
             // If normalized matches, we need to find the actual position in the original content
             // For simplicity, if exact match fails but normalized would work, we warn the model
             return {
               content: [{ type: "text", text: `Error: The oldText provided did not match exactly. Please ensure whitespace and line endings match or provide more context.` }],
               isError: true,
             };
          }

          return {
            content: [{ type: "text", text: `Error: Could not find the text block to replace in ${filePath}. Check for typos or provide more context.` }],
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
      description: "Perform a global regex search for a specific string across all files in the project.",
      inputSchema: z.object({
        regex: z.string().describe("The regular expression pattern to search for."),
        includeGlob: z.string().optional().describe("Glob pattern to limit the search (e.g. src/**/*.ts)."),
      }).strict(),
    },
    async ({ regex, includeGlob }) => {
      try {
        const searchRegex = new RegExp(regex, "g");
        const results: string[] = [];
        const baseDir = security.resolveAndValidatePath(".");

        async function searchRecursively(currentDir: string) {
          const entries = await fs.readdir(currentDir, { withFileTypes: true });

          for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            
            // Simple check to skip node_modules and .git
            if (entry.name === "node_modules" || entry.name === ".git") continue;

            if (entry.isDirectory()) {
              await searchRecursively(fullPath);
            } else if (entry.isFile()) {
              const relPath = path.relative(baseDir, fullPath);
              
              // Basic glob matching (simple version)
              if (includeGlob && !relPath.includes(includeGlob.replace(/\*/g, ""))) continue;

              const content = await fs.readFile(fullPath, "utf-8");
              let match;
              while ((match = searchRegex.exec(content)) !== null) {
                // Find line number using cross-platform line endings
                const lineNum = content.substring(0, match.index).split(/\r?\n/).length;
                const context = content.split(/\r?\n/)[lineNum - 1];
                results.push(`${relPath}:${lineNum} - ${context.trim()}`);
                
                if (results.length > 100) {
                  results.push("... [Search results truncated after 100 matches]");
                  return;
                }
              }
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
