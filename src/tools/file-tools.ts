import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SecurityManager } from "../security.js";
import { CHARACTER_LIMIT } from "../constants.js";
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

        return {
          content: [{ type: "text", text: `Successfully updated ${filePath}` }],
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

        return {
          content: [{ type: "text", text: `Successfully wrote file: ${filePath}` }],
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
        noIgnore: z.boolean().optional().describe("If true, searches will not respect .gitignore files. Useful for searching in hidden/ignored directories like .staff."),
      }).strict(),
    },
    async ({ regex, includeGlob, excludeGlob, caseSensitive = false, wholeWord = false, noIgnore = false }) => {
      try {
        const baseDir = security.resolveAndValidatePath(".");
        const rgPath = await ensureRipgrep();
        
        if (rgPath) {
          try {
            let args = ["--line-number", "--column", "--no-heading", "--color", "never", "--hidden"];
            
            if (noIgnore) {
               args.push("--no-ignore");
            }
            
            // Explicitly ignore .git and node_modules in all cases
            args.push("--glob"); args.push("!.git/**");
            args.push("--glob"); args.push("!node_modules/**");
            
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
        
        function globToRegex(glob: string) {
          const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
          const replaced = escaped.replace(/\\\*\\\*/g, '.*').replace(/\\\*/g, '[^/]*').replace(/\\\?/g, '.');
          return new RegExp(`^${replaced}$`);
        }
        
        const includeRegex = includeGlob ? globToRegex(includeGlob) : null;
        const excludeRegex = excludeGlob ? globToRegex(excludeGlob) : null;

        async function searchRecursively(currentDir: string) {
          const entries = await fs.readdir(currentDir, { withFileTypes: true });

          for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

            if (entry.name === "node_modules" || entry.name === ".git") continue;

            if (entry.isDirectory()) {
              await searchRecursively(fullPath);
            } else if (entry.isFile()) {
              if (includeRegex && !includeRegex.test(relPath)) continue;
              if (excludeRegex && excludeRegex.test(relPath)) continue;

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

  // find_files
  server.registerTool(
    "find_files",
    {
      description: "Search for files by name or path across the workspace.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern to match file paths (e.g. '**/*.ts', 'src/**/components/*')."),
        excludePattern: z.string().optional().describe("Glob pattern to exclude (e.g. 'node_modules/**')."),
        noIgnore: z.boolean().optional().describe("If true, searches will not respect .gitignore files. Useful for finding files in hidden/ignored directories."),
      }).strict(),
    },
    async ({ pattern, excludePattern, noIgnore = false }) => {
      try {
        const baseDir = security.resolveAndValidatePath(".");
        const rgPath = await ensureRipgrep();

        if (rgPath) {
          try {
            // Use rg --files to just list files, then we filter by glob
            let args = ["--files", "--hidden", "--color", "never"];
            
            if (noIgnore) {
               args.push("--no-ignore");
            }
            
            // Add the glob for inclusion
            args.push("--glob");
            args.push(pattern);

            if (excludePattern) {
              args.push("--glob");
              args.push(`!${excludePattern}`);
            }

            // Provide default exclusions so we don't crawl the whole universe
            args.push("--glob"); args.push("!.git/**");
            args.push("--glob"); args.push("!node_modules/**");

            args.push("--");
            args.push(baseDir);

            const command = `"${rgPath}" ${args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`;
            const { stdout } = await execAsync(command);
            let lines = stdout.trim().split("\n").filter(l => l.length > 0);

            // Convert to relative paths
            lines = lines.map(line => {
              // Convert absolute to relative path, handling Windows drives
              const relPath = path.relative(baseDir, line.trim());
              return relPath.replace(/\\/g, '/');
            });

            if (lines.length > 100) {
              lines = lines.slice(0, 100);
              lines.push("... [Search results truncated after 100 matches]");
            }

            return {
              content: [{ type: "text", text: lines.join("\n") || "No matching files found." }],
            };
          } catch (rgError: any) {
             if (rgError.code === 1) {
                return { content: [{ type: "text", text: "No matching files found." }] };
             }
          }
        }

        // JS Fallback
        const results: string[] = [];
        function globToRegex(glob: string) {
          const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
          const replaced = escaped.replace(/\\\*\\\*/g, '.*').replace(/\\\*/g, '[^/]*').replace(/\\\?/g, '.');
          return new RegExp(`^${replaced}$`);
        }
        
        const includeRegex = globToRegex(pattern);
        const excludeRegex = excludePattern ? globToRegex(excludePattern) : null;

        async function searchRecursively(currentDir: string) {
          const entries = await fs.readdir(currentDir, { withFileTypes: true });

          for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

            if (entry.name === "node_modules" || entry.name === ".git") continue;

            if (entry.isDirectory()) {
              if (includeRegex.test(relPath + '/')) {
                  // Some people use glob for matching directory paths, though rg --files only yields files
              }
              await searchRecursively(fullPath);
            } else if (entry.isFile()) {
              if (!includeRegex.test(relPath)) continue;
              if (excludeRegex && excludeRegex.test(relPath)) continue;

              results.push(relPath);
              if (results.length > 100) return;
            }
          }
        }

        await searchRecursively(baseDir);
        if (results.length >= 100) {
           results.push("... [Search results truncated after 100 matches]");
        }

        return {
          content: [{ type: "text", text: results.join("\n") || "No matching files found." }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error finding files: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
