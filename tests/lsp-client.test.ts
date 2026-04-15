import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";

async function run() {
  console.log("Starting full LSP suite test via MCP...");
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/index.ts"]
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log("Connected to MCP server");

  const filesToTest = [
    { path: "tests/test_files/test.ts", line: 1, character: 8, label: "TypeScript" },
    { path: "tests/test_files/test.py", line: 1, character: 6, label: "Python" },
    { path: "tests/test_files/test.sh", line: 2, character: 2, label: "Bash" }
  ];

  for (const file of filesToTest) {
    try {
      console.log(`\n================ Testing ${file.label} ================`);
      
      console.log("Testing get_diagnostics...");
      const diags = await client.callTool({
        name: "get_diagnostics",
        arguments: { path: file.path }
      });
      console.log(`Diagnostics:`, Array.isArray(diags.content) ? diags.content[0].text : "None");

      console.log("Testing hover...");
      const hoverInfo = await client.callTool({
        name: "hover",
        arguments: { path: file.path, line: file.line, character: file.character }
      });
      console.log("Hover output snippet:", JSON.stringify(hoverInfo).substring(0, 100) + "...");

      console.log("Testing get_document_symbols...");
      const symbols = await client.callTool({
        name: "get_document_symbols",
        arguments: { path: file.path }
      });
      console.log("Symbols snippet:", JSON.stringify(symbols).substring(0, 150));

    } catch (err: any) {
      console.error(`Tool call failed for ${file.label}:`, err.message);
    }
  }

  process.exit(0);
}

run().catch(console.error);
