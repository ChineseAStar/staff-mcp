import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEAcceptor, type Logger } from "mcp-reverse";
import { installFteTransportLifecycle } from "../src/transports/fte-lifecycle.js";
import { startReverseServer } from "../src/transports/reverse.js";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitFor(predicate: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("staff reverse mode reconnects through a gateway restart with FTE wrapping enabled", async () => {
  const port = await freePort();
  const serverName = "staff-restart-test";
  const token = "staff-restart-token";
  const gatewayClients: Client[] = [];

  const createAcceptor = () => {
    const acceptor = new SSEAcceptor({
      port,
      host: "127.0.0.1",
      authTokens: { [serverName]: token },
      heartbeat: { enabled: false },
      sessionTimeout: 5_000,
    }, noopLogger);
    acceptor.onConnection(async (connection) => {
      const gatewayClient = new Client({ name: "gateway-test", version: "1.0.0" });
      gatewayClients.push(gatewayClient);
      await gatewayClient.connect(connection.transport);
    });
    return acceptor;
  };

  let acceptor = createAcceptor();
  await acceptor.start();

  const mcpServer = new McpServer({ name: serverName, version: "1.0.0" });
  installFteTransportLifecycle(mcpServer, []);
  const reverseClient = await startReverseServer(
    mcpServer,
    `http://127.0.0.1:${port}/mcp-reverse`,
    token,
    serverName,
    {
      connectTimeout: 500,
      reconnect: {
        initialDelay: 10,
        maxDelay: 20,
        multiplier: 1,
        jitter: false,
        maxRetries: 0,
      },
      logger: noopLogger,
    }
  );

  try {
    await waitFor(() => gatewayClients.length === 1 && gatewayClients[0].getServerVersion() !== undefined);
    assert.equal(acceptor.sessionCount, 1);

    await acceptor.close();
    await waitFor(() => !mcpServer.isConnected());

    // Leave the gateway down long enough for at least one failed attempt.
    await new Promise((resolve) => setTimeout(resolve, 100));

    acceptor = createAcceptor();
    await acceptor.start();
    await waitFor(() => gatewayClients.length >= 2 && gatewayClients[1].getServerVersion() !== undefined);

    assert.equal(acceptor.sessionCount, 1);
    assert.equal(mcpServer.isConnected(), true);
  } finally {
    await reverseClient.stop();
    await Promise.allSettled(gatewayClients.map((client) => client.close()));
    await acceptor.close();
  }
});
