import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";

/**
 * Starts an Express server that hosts the MCP server over Streamable HTTP.
 *
 * Transport lifecycle:
 * - Each client session gets its own StreamableHTTPServerTransport instance.
 * - When a session ends (DELETE, client disconnect, etc.), the transport fires
 *   its onclose callback, which schedules a reset via setTimeout(0).
 * - The setTimeout deferral is critical: it lets Protocol._onclose() finish
 *   (setting _transport = undefined) before we call server.connect() again.
 * - During the reset window, incoming requests receive 503 to trigger client retry.
 */
export async function startHttpServer(server: McpServer, port: number, host: string = "0.0.0.0") {
  const app = express();
  
  // Enable CORS for all origins, including the MCP Inspector
  app.use(cors());
  
  // Necessary for processing JSON-RPC messages (POST)
  app.use(express.json());

  // The currently active transport. Set to null during reset windows.
  let transport: StreamableHTTPServerTransport | null = null;

  /**
   * Creates a fresh transport and connects it to the server.
   * Must only be called when server has no active transport
   * (i.e., after Protocol._onclose() has cleared _transport).
   */
  async function setupTransport(): Promise<void> {
    // Mark transport as unavailable during the reset window so incoming
    // requests get a clean 503 instead of hitting a closed transport.
    transport = null;

    const t = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Enable JSON responses for POST requests so the client receives
      // tool lists / call results directly in the response body.
      enableJsonResponse: true,
    });

    // Schedule a reset when this session ends.
    // We use setTimeout(0) to defer past Protocol._onclose(), which
    // clears _transport = undefined and makes connect() possible.
    t.onclose = () => {
      setTimeout(() => {
        setupTransport().catch((err) => {
          console.error("[MCP HTTP] Failed to reset transport:", err);
        });
      }, 0);
    };

    await server.connect(t);
    transport = t;
    console.error("[MCP HTTP] Transport ready for new sessions");
  }

  // Initial transport setup.
  await setupTransport();

  /**
   * Unified handler for MCP requests.
   * Handles GET (SSE) and POST (JSON-RPC).
   */
  const mcpHandler = async (req: express.Request, res: express.Response) => {
    const current = transport;
    if (!current) {
      // Transport is being reset — tell the client to retry.
      res.status(503).json({ error: "Server is restarting session, please retry" });
      return;
    }
    try {
      await current.handleRequest(req, res, req.body);
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
