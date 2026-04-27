import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SecurityManager } from "../security.js";
import { lspManager } from "../lsp/manager.js";
import * as path from "path";

import { fileURLToPath } from "url";

/**
 * Registers LSP-related tools using the latest registerTool API.
 */
export function registerLspTools(server: McpServer, security: SecurityManager) {
  // hover
  server.registerTool(
    "hover",
    {
      description: "Get hover information (type, documentation) at a specific position.",
      inputSchema: z.object({
        path: z.string().describe("File path to inspect."),
        line: z.number().describe("1-based line number."),
        character: z.number().describe("1-based character position."),
      }).strict(),
    },
    async ({ path: filePath, line, character }) => {
      try {
        const validatedPath = security.resolveAndValidatePath(filePath);
        const rootPath = security.getWorkingDir();
        const result = await lspManager.hover(validatedPath, line - 1, character - 1, rootPath);
        return {
          content: [{ type: "text", text: result }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `LSP Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // get_diagnostics
  server.registerTool(
    "get_diagnostics",
    {
      description: "Get diagnostics/errors for a file (supports TS, JS, Python).",
      inputSchema: z.object({
        path: z.string().describe("File path to check for diagnostics."),
      }).strict(),
    },
    async ({ path: checkPath }) => {
      try {
        const validatedPath = security.resolveAndValidatePath(checkPath);
        const rootPath = security.getWorkingDir();
        const diagnostics = await lspManager.getDiagnostics(validatedPath, rootPath);
        
        const formatted = diagnostics.map((d: any) => 
          `[Line ${d.range.start.line + 1}] ${d.message} (${d.severity === 1 ? 'Error' : 'Warning'})`
        ).join("\n");

        return {
          content: [{ type: "text", text: formatted || "No diagnostics found." }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `LSP Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // symbol_lookup
  server.registerTool(
    "symbol_lookup",
    {
      description: "Look up definition or references for a symbol at a specific position.",
      inputSchema: z.object({
        action: z.enum(["definition", "references"]).describe("Whether to find the definition or all references."),
        path: z.string().describe("File path where the symbol is located."),
        line: z.number().describe("1-based line number."),
        character: z.number().describe("1-based character position."),
      }).strict(),
    },
    async ({ action, path: filePath, line, character }) => {
      try {
        const validatedPath = security.resolveAndValidatePath(filePath);
        const rootPath = security.getWorkingDir();

        if (action === "definition") {
          const result = await lspManager.go_to_definition_internal(validatedPath, line, character, rootPath);
          return { content: [{ type: "text", text: result }] };
        } else {
          const references = await lspManager.findReferences(validatedPath, line - 1, character - 1, rootPath);
          if (!references || references.length === 0) {
            return { content: [{ type: "text", text: "No references found." }] };
          }
          const results = references.map((ref: any) => {
            let uriPath = ref.uri;
            try { uriPath = fileURLToPath(ref.uri); } catch(e) { uriPath = uriPath.replace("file://", ""); }
            return `${uriPath}:${ref.range.start.line + 1}`;
          });
          return { content: [{ type: "text", text: results.join("\n") }] };
        }
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `LSP Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // get_document_symbols
  server.registerTool(
    "get_document_symbols",
    {
      description: "Extract high-level symbols (classes, functions, interfaces) from a file using LSP.",
      inputSchema: z.object({
        path: z.string().describe("File path to analyze."),
      }).strict(),
    },
    async ({ path: filePath }) => {
      try {
        const validatedPath = security.resolveAndValidatePath(filePath);
        const rootPath = security.getWorkingDir();
        const symbols = await lspManager.getDocumentSymbols(validatedPath, rootPath);
        
        if (!symbols || symbols.length === 0) {
          return { content: [{ type: "text", text: "(No significant symbols found)" }] };
        }

        // Format symbols. The structure can be DocumentSymbol[] or SymbolInformation[]
        const formatSymbol = (sym: any, indent = ""): string => {
          const kindMap: Record<number, string> = {
            1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class", 6: "Method", 
            7: "Property", 8: "Field", 9: "Constructor", 10: "Enum", 11: "Interface", 
            12: "Function", 13: "Variable", 14: "Constant", 15: "String", 16: "Number", 
            17: "Boolean", 18: "Array", 19: "Object", 20: "Key", 21: "Null", 22: "EnumMember", 
            23: "Struct", 24: "Event", 25: "Operator", 26: "TypeParameter"
          };
          const kindStr = kindMap[sym.kind] || `Unknown(${sym.kind})`;
          const line = sym.range ? sym.range.start.line + 1 : (sym.location?.range?.start?.line + 1 || '?');
          let res = `${indent}[${kindStr}] ${sym.name} (Line ${line})\n`;
          if (sym.children) {
            for (const child of sym.children) {
              res += formatSymbol(child, indent + "  ");
            }
          }
          return res;
        };

        const resultText = symbols.map(s => formatSymbol(s)).join("").trim();
        return {
          content: [{ type: "text", text: resultText || "(No significant symbols found)" }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `LSP Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

}
