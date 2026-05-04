import { SSEReverseClientTransport } from "mcp-reverse/sse";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export async function startReverseServer(server: McpServer, url: string, token: string, name: string) {
    const connectWithRetry = async () => {
        const transport = new SSEReverseClientTransport({
            url,
            serverName: name,
            authToken: token
        });
        
        // When transport is closed (e.g. server crash, network drop), schedule a retry
        transport.onclose = () => {
            console.log("[staff-mcp] Reverse connection lost or gateway unavailable. Retrying in 5s...");
            setTimeout(connectWithRetry, 5000);
        };

        transport.onerror = (error: Error) => {
            console.error(`[staff-mcp] Reverse transport error:`, error);
        };

        try {
            console.log(`[staff-mcp] Attempting to connect to Reverse Gateway: ${url} ...`);
            await server.connect(transport);
            console.log(`[staff-mcp] 🚀 Successfully connected to Reverse Gateway as "${name}"`);
        } catch (error) {
            console.error(`[staff-mcp] Failed to connect to Reverse Gateway. Retrying in 5s...`);
            setTimeout(connectWithRetry, 5000);
        }
    };

    // Kick off the initial connection loop
    await connectWithRetry();
}
