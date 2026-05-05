import { ReverseMCPClient } from "mcp-reverse/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Start a reverse MCP connection to a public gateway.
 *
 * The ReverseMCPClient handles all transport lifecycle, reconnection,
 * and MCP protocol re-binding automatically.
 *
 * @param server The McpServer instance (with all tools registered)
 * @param url Base URL of the reverse MCP endpoint
 * @param token Authentication token
 * @param name Server name for identification
 */
export async function startReverseServer(
    server: McpServer,
    url: string,
    token: string,
    name: string
): Promise<void> {
    const client = await ReverseMCPClient.createSSE(server, {
        url,
        serverName: name,
        authToken: token,
        reconnect: {
            initialDelay: 1000,
            maxDelay: 30000,
            multiplier: 2,
            maxRetries: 0, // 0 = infinite
        },
    });

    client.on("connected", () => {
        console.log(`[staff-mcp] 🚀 Successfully connected to Reverse Gateway as "${name}"`);
    });

    client.on("disconnected", () => {
        console.log("[staff-mcp] Connection lost, reconnecting...");
    });

    client.on("reconnecting", (attempt: number) => {
        console.log(`[staff-mcp] Reconnecting, attempt ${attempt}...`);
    });

    client.on("error", (error: Error) => {
        console.error(`[staff-mcp] Transport error:`, error.message);
    });

    client.on("failed", () => {
        console.error("[staff-mcp] Permanent connection failure, exiting");
        process.exit(1);
    });

    await client.start();
}
