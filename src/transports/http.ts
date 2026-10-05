import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID, timingSafeEqual } from "node:crypto";

export function getHttpAuthToken(): string {
  const token = process.env.STAFF_MCP_HTTP_TOKEN;
  if (!token || /\s/.test(token)) {
    throw new Error("STAFF_MCP_HTTP_TOKEN must be set to a non-empty token without whitespace for HTTP transport.");
  }
  return token;
}

export async function startHttpServer(serverFactory: () => McpServer, port: number, host: string = "0.0.0.0") {
  const expectedToken = Buffer.from(getHttpAuthToken());
  const app = express();
  
  // CORS preflight is public and never reaches MCP session handling.
  app.use(cors());

  // Authenticate every MCP request before parsing its body or accessing a session.
  app.use(["/mcp", "/sse", "/messages"], (req, res, next) => {
    const match = /^Bearer +(\S+)$/i.exec(req.headers.authorization ?? "");
    const token = Buffer.from(match?.[1] ?? "");
    if (token.length !== expectedToken.length || !timingSafeEqual(token, expectedToken)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="staff-mcp"');
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });
  
  // Necessary for processing JSON-RPC messages (POST).
  // Large limit required to support MCP File Transfer Extension (FTE)
  // which sends base64-encoded file chunks up to 2 MiB (~2.67 MiB JSON).
  app.use(express.json({ limit: '50mb' }));

  // === Session Pool ===
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const mcpHandler = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // 1. 尝试复用已有会话
    if (sessionId && sessions.has(sessionId)) {
      const t = sessions.get(sessionId)!;
      try {
        await t.handleRequest(req, res, req.body);
      } catch (error) {
        console.error("[MCP HTTP Error]:", error);
        if (!res.headersSent) {
          res.status(500).json({ 
            error: "Internal Server Error", 
            message: error instanceof Error ? error.message : String(error) 
          });
        }
      }
      return;
    }

    // 2. 没有对应会话，或者是一个新的 GET 请求，创建新的
    const newSessionId = randomUUID();
    const server = serverFactory();

    // 如果客户端带了旧的、已失效的 sessionId 试图重连，
    // 必须从 headers 中抹除，否则底层 SDK 会因为它与新分配的 newSessionId 不一致而直接报错 400
    if (sessionId) {
      delete req.headers["mcp-session-id"];
      delete req.headers["last-event-id"];
    }
    
    const t = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      enableJsonResponse: true,
    });

    // 监听关闭事件，正常触发时清理自身
    t.onclose = () => {
      console.log(`[HTTP] Session Closed: ${newSessionId}`);
      sessions.delete(newSessionId);
    };

    await server.connect(t);
    sessions.set(newSessionId, t);
    
    try {
      await t.handleRequest(req, res, req.body);
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
