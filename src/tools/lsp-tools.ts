import { Project } from "ts-morph";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SecurityManager } from "../security.js";
import { lspManager } from "../lsp/manager.js";
import * as path from "path";

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
        const rootPath = (security as any).workingDir;
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

  // go_to_definition
  server.registerTool(
    "go_to_definition",
    {
      description: "Find the definition of a symbol at a specific position.",
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
        const client = await lspManager.getClient(path.extname(validatedPath).slice(1) === 'py' ? 'python' : 'typescript', rootPath);
        const result = await client.request("textDocument/definition", {
          textDocument: { uri: `file://${validatedPath}` },
          position: { line: line - 1, character: character - 1 }
        });

        if (!result) return { content: [{ type: "text", text: "Definition not found" }] };
        
        const locations = Array.isArray(result) ? result : [result];
        const formatted = locations.map((loc: any) => {
          const uri = loc.uri || loc.targetUri;
          const range = loc.range || loc.targetSelectionRange;
          return `${uri.replace('file://', '')}:${range.start.line + 1}`;
        }).join("\n");

        return {
          content: [{ type: "text", text: formatted }],
        };
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
      description: "Extract high-level symbols (classes, functions, interfaces) from a TypeScript file.",
      inputSchema: z.object({
        path: z.string().describe("TypeScript/JavaScript file path to analyze."),
      }).strict(),
    },
    async ({ path: filePath }) => {
      try {
        const validatedPath = security.resolveAndValidatePath(filePath);
        const project = new Project();
        const sourceFile = project.addSourceFileAtPath(validatedPath);

        const symbols: string[] = [];

        sourceFile.getClasses().forEach(c => symbols.push(`[Class] ${c.getName()} (Line ${c.getStartLineNumber()})`));
        sourceFile.getInterfaces().forEach(i => symbols.push(`[Interface] ${i.getName()} (Line ${i.getStartLineNumber()})`));
        sourceFile.getFunctions().forEach(f => symbols.push(`[Function] ${f.getName()} (Line ${f.getStartLineNumber()})`));
        sourceFile.getEnums().forEach(e => symbols.push(`[Enum] ${e.getName()} (Line ${e.getStartLineNumber()})`));
        sourceFile.getTypeAliases().forEach(t => symbols.push(`[TypeAlias] ${t.getName()} (Line ${t.getStartLineNumber()})`));

        return {
          content: [{ type: "text", text: symbols.join("\n") || "(No significant symbols found)" }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `LSP Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // find_references
  server.registerTool(
    "find_references",
    {
      description: "Find all references to a symbol (function, class, variable) in the project.",
      inputSchema: z.object({
        path: z.string().describe("File path where the symbol is defined."),
        symbolName: z.string().describe("The name of the symbol to find references for."),
      }).strict(),
    },
    async ({ path: filePath, symbolName }) => {
      try {
        const validatedPath = security.resolveAndValidatePath(filePath);
        const project = new Project();
        project.addSourceFilesAtPaths("**/*.ts");
        const sourceFile = project.getSourceFile(validatedPath);
        
        if (!sourceFile) {
          throw new Error(`File not found: ${filePath}`);
        }

        // Search for the symbol
        let node;
        // Simple search by name in classes, functions, etc.
        const allNodes = sourceFile.getDescendantsOfKind(1 /* Identifier */);
        node = allNodes.find(n => n.getText() === symbolName);

        if (!node) {
          return {
            content: [{ type: "text", text: `Could not find symbol "${symbolName}" in ${filePath}` }],
            isError: true,
          };
        }

        const references = (node as any).findReferences();
        const results: string[] = [];

        for (const reference of references) {
          for (const ref of reference.getReferences()) {
            const refSourceFile = ref.getSourceFile();
            const line = refSourceFile.getLineAndColumnAtPos(ref.getTextSpan().getStart()).line;
            const relPath = security.resolveAndValidatePath(refSourceFile.getFilePath()); // Re-validate or just use relative
            results.push(`${refSourceFile.getFilePath()}:${line}`);
          }
        }

        return {
          content: [{ type: "text", text: results.join("\n") || "No references found." }],
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
