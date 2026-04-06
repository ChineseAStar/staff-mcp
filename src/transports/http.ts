import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";

/**
 * Starts an Express server that hosts the MCP server over Streamable HTTP.
 */
export async function startHttpServer(server: McpServer, port: number, host: string = "0.0.0.0") {
  const app = express();
  
  // Enable CORS for all origins, including the MCP Inspector
  app.use(cors());
  
  // Necessary for processing JSON-RPC messages (POST)
  // We use express.json() but also need to be careful not to consume the stream if transport needs it.
  // However, StreamableHTTPServerTransport.handleRequest accepts parsedBody.
  app.use(express.json());

  // Use a single transport instance for the lifetime of the HTTP server.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // VERY IMPORTANT: Enable JSON responses for POST requests. 
    // This allows the client to receive tool lists and call results directly in the POST response,
    // which is what the Anthropic Inspector and many other clients expect.
    enableJsonResponse: true,
  });

  // Connect the MCP server instance to this transport.
  await server.connect(transport);

  /**
   * Unified handler for MCP requests.
   * Handles GET (SSE) and POST (JSON-RPC).
   */
  const mcpHandler = async (req: express.Request, res: express.Response) => {
    try {
      // In Streamable HTTP, handleRequest handles the full lifecycle based on method.
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[MCP HTTP Error]:", error);
      if (!res.headersSent) {
        res.status(500).json({ 
          error: "Internal Server Error", 
          message: error instanceof Error ? error.message : String(error) 
        });
      }
    }
  };

  // Route for all MCP interactions.
  app.all("/mcp", mcpHandler);
  
  // Standard fallbacks
  app.get("/sse", mcpHandler);
  app.post("/messages", mcpHandler);

  return new Promise<void>((resolve) => {
    app.listen(port, host, () => {
      console.error(`[MCP HTTP] Server listening on http://${host}:${port}/mcp`);
      console.error(`[MCP HTTP] JSON Response enabled: true`);
      resolve();
    });
  });
}
