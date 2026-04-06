import { Project } from "ts-morph";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SecurityManager } from "../security.js";

/**
 * Internal helper to get diagnostics for a specific path.
 */
export async function getPathDiagnostics(checkPath: string, security: SecurityManager): Promise<string> {
  const validatedPath = security.resolveAndValidatePath(checkPath);
  const project = new Project();
  
  project.addSourceFilesAtPaths([
    validatedPath.endsWith(".ts") || validatedPath.endsWith(".js") 
      ? validatedPath 
      : `${validatedPath}/**/*.{ts,js,tsx,jsx}`
  ]);

  const diagnostics = project.getPreEmitDiagnostics();
  return diagnostics.map(diag => {
    const messageText = diag.getMessageText();
    const line = diag.getLineNumber();
    const file = diag.getSourceFile()?.getFilePath() || "Unknown file";
    const formattedMessage = typeof messageText === "string" ? messageText : messageText.getMessageText();
    return `[${file}:${line}] ${formattedMessage}`;
  }).join("\n");
}

/**
 * Registers LSP-related tools using the latest registerTool API.
 */
export function registerLspTools(server: McpServer, security: SecurityManager) {
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

  // get_diagnostics
  server.registerTool(
    "get_diagnostics",
    {
      description: "Get TypeScript diagnostics/errors for a file or directory.",
      inputSchema: z.object({
        path: z.string().describe("File or directory path to check for TypeScript diagnostics."),
      }).strict(),
    },
    async ({ path: checkPath }) => {
      try {
        const output = await getPathDiagnostics(checkPath, security);
        return {
          content: [{ type: "text", text: output || "No TypeScript diagnostics found." }],
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
