import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import * as readline from "readline";
import { createReadStream } from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SecurityManager } from "../security.js";
import { CHARACTER_LIMIT, SEARCH_MAX_COLUMNS, SEARCH_MAX_MATCHES, SEARCH_EXEC_MAX_BUFFER, IMAGE_SIZE_LIMIT, FILE_SNIFF_SIZE, SUPPORTED_IMAGE_MIMES, IMAGE_MIME_BY_EXTENSION, sniffImageMime, isBinaryFile } from "../constants.js";
import { ensureRipgrep } from "../utils/tool-utils.js";

const execAsync = promisify(exec);

/**
 * Truncate a long line of text, centered around the match position (colNum).
 * colNum is 1-based. Adds "..." prefix/suffix when truncated.
 */
function truncateContext(context: string, colNum: number, maxLen: number): string {
  const trimmed = context.trim();
  if (trimmed.length <= maxLen) return trimmed;

  // colNum is 1-based; use as approximate character position for centering
  const center = Math.max(0, colNum - 1);
  const halfLen = Math.floor(maxLen / 2);
  let start = Math.max(0, center - halfLen);
  let end = Math.min(trimmed.length, start + maxLen);
  // Adjust start if we hit the end of the string
  start = Math.max(0, end - maxLen);

  const prefix = start > 0 ? "..." : "";
  const suffix = end < trimmed.length ? "..." : "";
  return prefix + trimmed.substring(start, end) + suffix;
}

/**
 * Registers file-related tools using the latest registerTool API.
 */
export function registerFileTools(server: McpServer, security: SecurityManager) {
  // read_file
  server.registerTool(
    "read_file",
    {
      description:
        "Read the content of a file from the allowed workspace. " +
        "Supports line range selection via startLine/endLine. " +
        "This tool can read image files and return them for visual analysis.",
      inputSchema: z.object({
        path: z.string().describe("Relative path from the workspace to the file to read."),
        startLine: z.number().optional().describe("1-based line number to start reading from."),
        endLine: z.number().optional().describe("1-based line number to end reading at (inclusive)."),
      }).strict(),
    },
    async ({ path: filePath, startLine, endLine }) => {
      try {
        const validatedPath = security.resolveAndValidatePath(filePath);

        // --- Image detection: magic-byte sniff + extension fallback ---
        const ext = path.extname(validatedPath).toLowerCase();
        const extMime = IMAGE_MIME_BY_EXTENSION[ext];

        // Read first few bytes for magic-byte sniffing + binary detection
        let sniffedMime: string | null = null;
        let fileStat = await fs.stat(validatedPath);
        let sampleBytes: Uint8Array = new Uint8Array(0);

        if (fileStat.size > 0) {
          const fd = await fs.open(validatedPath, "r");
          const sample = Buffer.alloc(FILE_SNIFF_SIZE);
          const { bytesRead } = await fd.read(sample, 0, FILE_SNIFF_SIZE, 0);
          await fd.close();
          if (bytesRead > 0) {
            sampleBytes = sample.subarray(0, bytesRead);
            sniffedMime = sniffImageMime(sampleBytes);
          }
        }

        const mime = sniffedMime || extMime || null;
        const isImage = mime !== null && SUPPORTED_IMAGE_MIMES.has(mime);

        if (isImage) {
          // --- Image path: return as ImageContent, ignore startLine/endLine ---
          if (fileStat.size > IMAGE_SIZE_LIMIT) {
            return {
              content: [{ type: "text", text: `Error: Image file is too large (${(fileStat.size / 1024 / 1024).toFixed(1)}MB). Maximum allowed size is ${IMAGE_SIZE_LIMIT / 1024 / 1024}MB.` }],
              isError: true,
            };
          }

          const imageBuffer = await fs.readFile(validatedPath);
          const base64Data = imageBuffer.toString("base64");

          return {
            content: [
              {
                type: "image" as const,
                data: base64Data,
                mimeType: mime,
              },
              {
                type: "text" as const,
                text: `Image file: ${filePath} (${fileStat.size} bytes, ${mime})`,
              },
            ],
          };
        }

        // --- Binary file detection: reject non-text files ---
        if (isBinaryFile(validatedPath, sampleBytes)) {
          return {
            content: [{ type: "text", text: `Error: Cannot read binary file: ${filePath}. This file type is not supported for text reading.` }],
            isError: true,
          };
        }

        // --- Text path: original logic ---
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

  // search_workspace
  server.registerTool(
    "search_workspace",
    {
      description: "Perform a global search across all files in the project. Use 'content' to search inside files (regex) or 'path' to find files by name/glob.",
      inputSchema: z.object({
        search_type: z.enum(["content", "path"]).describe("The type of search to perform."),
        query: z.string().describe("The pattern to search for. For 'content', this is a regex. For 'path', this is a glob pattern (e.g. '**/*.ts')."),
        includeGlob: z.string().optional().describe("Glob pattern to limit the search (e.g. 'src/**/*.ts')."),
        excludeGlob: z.string().optional().describe("Glob pattern to exclude from the search (e.g. 'node_modules/**')."),
        caseSensitive: z.boolean().optional().describe("Whether the search should be case-sensitive (default: false, only applies to 'content')."),
        wholeWord: z.boolean().optional().describe("Whether to match whole words only (default: false, only applies to 'content')."),
        noIgnore: z.boolean().optional().describe("If true, searches will not respect .gitignore files. Useful for searching in hidden/ignored directories like .staff."),
      }).strict(),
    },
    async ({ search_type, query, includeGlob, excludeGlob, caseSensitive = false, wholeWord = false, noIgnore = false }) => {
      try {
        const baseDir = security.resolveAndValidatePath(".");
        const rgPath = await ensureRipgrep();
        
        if (rgPath) {
          try {
            let args = ["--color", "never", "--hidden"];
            
            if (search_type === "content") {
              args.push("--line-number", "--column", "--no-heading");
              args.push("--max-count", "5");
              if (!caseSensitive) args.push("--ignore-case");
              if (wholeWord) args.push("--word-regexp");
            } else {
              args.push("--files");
              args.push("--glob");
              args.push(query);
            }
            
            if (noIgnore) {
               args.push("--no-ignore");
            }
            
            args.push("--glob"); args.push("!.git/**");
            args.push("--glob"); args.push("!node_modules/**");
            
            if (includeGlob) {
               args.push("--glob");
               args.push(includeGlob);
            }
            if (excludeGlob) {
               args.push("--glob");
               args.push(`!${excludeGlob}`);
            }
            
            args.push("--");
            if (search_type === "content") {
              args.push(query);
            }
            args.push(baseDir);

            const command = `"${rgPath}" ${args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`;
            const { stdout } = await execAsync(command, {
              maxBuffer: SEARCH_EXEC_MAX_BUFFER,
            });

            let lines = stdout.trim().split("\n").filter(l => l.length > 0);

            if (search_type === "path") {
              lines = lines.map(line => {
                const relPath = path.relative(baseDir, line.trim());
                return relPath.replace(/\\/g, '/');
              });
            } else {
              lines = lines.map(line => {
                 const match = line.match(/^((?:[a-zA-Z]:)?[^:]+):(\d+):(\d+):(.*)$/);
                 if (match) {
                    const [_, absPath, lineNum, colNum, context] = match;
                    const relPath = path.relative(baseDir, absPath);
                    const truncated = truncateContext(context, parseInt(colNum, 10), SEARCH_MAX_COLUMNS);
                    return `${relPath.replace(/\\/g, '/')}:${lineNum} - ${truncated}`;
                 }
                 return line;
              });
            }

            const wasTruncated = lines.length > SEARCH_MAX_MATCHES;
            if (wasTruncated) {
              lines = lines.slice(0, SEARCH_MAX_MATCHES);
            }

            // If truncated, try to get total match count for better feedback
            let truncationNote = "";
            if (wasTruncated) {
              try {
                const countArgs = ["--color", "never", "--hidden", "--count"];
                if (!caseSensitive) countArgs.push("--ignore-case");
                if (wholeWord) countArgs.push("--word-regexp");
                countArgs.push("--glob", "!.git/**");
                countArgs.push("--glob", "!node_modules/**");
                if (includeGlob) { countArgs.push("--glob", includeGlob); }
                if (excludeGlob) { countArgs.push("--glob", `!${excludeGlob}`); }
                if (noIgnore) { countArgs.push("--no-ignore"); }
                countArgs.push("--");
                countArgs.push(query);
                countArgs.push(baseDir);
                const countCmd = `"${rgPath}" ${countArgs.map(a => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`;
                const { stdout: countOut } = await execAsync(countCmd, { maxBuffer: 1024 * 1024 });
                const countLines = countOut.trim().split("\n").filter((l: string) => l.length > 0);
                const totalMatches = countLines.reduce((sum: number, line: string) => {
                  const parts = line.split(":");
                  return sum + parseInt(parts[parts.length - 1] || "0", 10);
                }, 0);
                const fileCount = countLines.length;
                truncationNote = `\n... [Search results truncated. Showing ${SEARCH_MAX_MATCHES} of ${totalMatches} matches across ${fileCount} files. Use includeGlob/excludeGlob to narrow results.]`;
              } catch {
                truncationNote = `\n... [Search results truncated at ${SEARCH_MAX_MATCHES} matches. More results exist — use includeGlob/excludeGlob to narrow your search.]`;
              }
            }

            return {
              content: [{ type: "text", text: (lines.join("\n") || "No matches found.") + truncationNote }],
            };
          } catch (rgError: any) {
            if (rgError.code === 1) {
              return { content: [{ type: "text", text: "No matches found." }] };
            }
            // Handle maxBuffer or other errors: use partial stdout if available
            if (rgError.stdout && rgError.stdout.trim().length > 0) {
              let partialLines: string[] = rgError.stdout.trim().split("\n").filter((l: string) => l.length > 0);
              if (search_type === "path") {
                partialLines = partialLines.map((line: string) => {
                  const relPath = path.relative(baseDir, line.trim());
                  return relPath.replace(/\\/g, '/');
                });
              } else {
                partialLines = partialLines.map((line: string) => {
                  const match = line.match(/^((?:[a-zA-Z]:)?[^:]+):(\d+):(\d+):(.*)$/);
                  if (match) {
                    const [_, absPath, lineNum, colNum, context] = match;
                    const relPath = path.relative(baseDir, absPath);
                    const truncated = truncateContext(context, parseInt(colNum, 10), SEARCH_MAX_COLUMNS);
                    return `${relPath.replace(/\\/g, '/')}:${lineNum} - ${truncated}`;
                  }
                  return line;
                });
              }
              if (partialLines.length > SEARCH_MAX_MATCHES) {
                partialLines = partialLines.slice(0, SEARCH_MAX_MATCHES);
              }
              const note = `\n... [Search results truncated at ${SEARCH_MAX_MATCHES} matches (ripgrep output exceeded buffer). More results exist — use includeGlob/excludeGlob to narrow your search.]`;
              return {
                content: [{ type: "text", text: (partialLines.join("\n") || "No matches found.") + note }],
              };
            }
            // Other errors: fall through to JS fallback
            console.error("[staff-mcp] ripgrep failed, falling back to JS:", rgError.message);
          }
        }

        // JS Fallback
        const results: string[] = [];
        let jsHitLimit = false;
        function globToRegex(glob: string) {
          const escaped = glob.replace(/[.+^${()|[\]\\*?]/g, '\\$&');
          const replaced = escaped.replace(/\\\*\\\*/g, '.*').replace(/\\\*/g, '[^/]*').replace(/\\\?/g, '.');
          return new RegExp(`^${replaced}$`);
        }

        const searchRegex = search_type === "content" ? new RegExp(wholeWord ? `\\b${query}\\b` : query, caseSensitive ? "g" : "gi") : null;
        let includeRegex: RegExp | null = null;
        if (search_type === "path") {
          includeRegex = globToRegex(query);
        } else if (includeGlob) {
          includeRegex = globToRegex(includeGlob);
        }
        const excludeRegex = excludeGlob ? globToRegex(excludeGlob) : null;

        async function searchRecursively(currentDir: string) {
          if (results.length >= SEARCH_MAX_MATCHES) return;

          const entries = await fs.readdir(currentDir, { withFileTypes: true });

          for (const entry of entries) {
            if (results.length >= SEARCH_MAX_MATCHES) return;

            const fullPath = path.join(currentDir, entry.name);
            const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

            if (entry.name === "node_modules" || entry.name === ".git") continue;

            if (entry.isDirectory()) {
              await searchRecursively(fullPath);
              if (results.length >= SEARCH_MAX_MATCHES) return;
            } else if (entry.isFile()) {
              if (search_type === "path") {
                 if (includeRegex && !includeRegex.test(relPath)) continue;
                 if (excludeRegex && excludeRegex.test(relPath)) continue;
                 results.push(relPath);
                 if (results.length >= SEARCH_MAX_MATCHES) {
                   jsHitLimit = true;
                   return;
                 }
              } else {
                 if (includeRegex && !includeRegex.test(relPath)) continue;
                 if (excludeRegex && excludeRegex.test(relPath)) continue;

                 try {
                   const fileStream = createReadStream(fullPath, { encoding: "utf-8" });
                   const rl = readline.createInterface({
                     input: fileStream,
                     crlfDelay: Infinity,
                   });

                   let lineNum = 0;
                   let shouldStop = false;

                   for await (const line of rl) {
                     lineNum++;
                     if (line.includes("\0")) break; // Skip binary files

                     searchRegex!.lastIndex = 0;
                     const match = searchRegex!.exec(line);
                     if (match) {
                       const colNum = match.index + 1; // 1-based
                       const truncated = truncateContext(line, colNum, SEARCH_MAX_COLUMNS);
                       results.push(`${relPath}:${lineNum} - ${truncated}`);

                       if (results.length >= SEARCH_MAX_MATCHES) {
                         jsHitLimit = true;
                         shouldStop = true;
                         break;
                       }
                     }
                   }
                   rl.close();
                   fileStream.destroy();
                   if (shouldStop) return;
                 } catch (e) {}
              }
            }
          }
        }

        await searchRecursively(baseDir);

        let outputText = results.join("\n") || "No matches found.";

        if (jsHitLimit) {
          outputText += `\n... [Search results truncated at ${SEARCH_MAX_MATCHES} matches. More results exist — use includeGlob/excludeGlob to narrow your search.]`;
        }

        // Let the LLM know it fell back to JS search, so it can decide if it wants to install ripgrep.
        if (!rgPath) {
           const installCmd = process.platform === "win32" ? "scoop install ripgrep (or winget install ripgrep)" : "apt-get install ripgrep (or apk add ripgrep)";
           outputText += `\n\n[System Note: This search was executed using the slower JavaScript fallback because 'rg' (ripgrep) was not found. A background installation of ripgrep has been triggered and may be available for future searches. If it continues to fail, you can manually install it via 'execute_command': ${installCmd}]`;
        }

        return {
          content: [{ type: "text", text: outputText }],
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
