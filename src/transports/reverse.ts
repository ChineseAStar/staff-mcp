import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger, ReconnectOptions } from "mcp-reverse";
import { ReverseMCPClient } from "mcp-reverse/client";

export interface ReverseServerOptions {
    /** Timeout for establishing each SSE connection. 0 disables the timeout. */
    connectTimeout?: number;
    /** Override the automatic reconnect policy. */
    reconnect?: ReconnectOptions;
    /** Override reverse transport and lifecycle logging. */
    logger?: Logger;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

function createReverseLogger(): Logger {
    const debugEnabled = process.env.STAFF_MCP_REVERSE_DEBUG === "1";
    return {
        debug: debugEnabled
            ? (message, ...args) => console.error(`[staff-mcp][reverse][debug] ${message}`, ...args)
            : () => {},
        info: (message, ...args) => console.error(`[staff-mcp][reverse][info] ${message}`, ...args),
        warn: (message, ...args) => console.error(`[staff-mcp][reverse][warn] ${message}`, ...args),
        error: (message, ...args) => console.error(`[staff-mcp][reverse][error] ${message}`, ...args),
    };
}

/**
 * Start a reverse MCP connection to a public gateway.
 *
 * The ReverseMCPClient owns transport lifecycle, reconnection, and MCP
 * protocol re-binding. start() launches the connection loop; readiness is
 * reported asynchronously through the connected event/log.
 */
export async function startReverseServer(
    server: McpServer,
    url: string,
    token: string,
    name: string,
    options: ReverseServerOptions = {}
): Promise<ReverseMCPClient> {
    const reconnectEnabled = options.reconnect?.enabled !== false;
    const reverseLogger = options.logger ?? createReverseLogger();
    const client = await ReverseMCPClient.createSSE(
        server,
        {
            url,
            serverName: name,
            authToken: token,
            connectTimeout: options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_MS,
            reconnect: {
                initialDelay: 1000,
                maxDelay: 30000,
                multiplier: 2,
                maxRetries: 0, // 0 = infinite
                ...options.reconnect,
            },
        },
        reverseLogger
    );

    client.on("connected", () => {
        reverseLogger.info(`SSE transport connected as "${name}"`);
    });

    client.on("disconnected", () => {
        reverseLogger.warn(
            reconnectEnabled
                ? "Gateway connection closed; automatic reconnect is enabled"
                : "Gateway connection closed; automatic reconnect is disabled"
        );
    });

    client.on("reconnecting", (completedAttempts: number) => {
        if (completedAttempts === 0) {
            reverseLogger.info("Reconnect cycle started");
        } else {
            reverseLogger.info(`${completedAttempts} reconnect attempt(s) have failed`);
        }
    });

    client.on("error", (error: Error) => {
        reverseLogger.error(`Transport reported an error: ${error.message}`);
    });

    client.on("failed", (error: Error) => {
        reverseLogger.error(`Reconnect budget exhausted: ${error.message}`);
    });

    await client.start();
    return client;
}
