import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { FteServer, type FteServerConfig } from "mcp-fte";

export type FteTransportFactory = (
  transport: Transport,
  config: FteServerConfig
) => Transport;

/**
 * Install FTE wrapping while preserving transport lifecycle semantics.
 *
 * mcp-reverse transports can close themselves before the MCP SDK calls the
 * wrapper's close() method. Without this bridge, FteServer's timer and transfer
 * sessions would survive every reconnect. The composed onclose handler clears
 * the SDK binding first, then closes the FTE wrapper exactly once.
 */
export function installFteTransportLifecycle(
  server: McpServer,
  sandbox: string[],
  wrapTransport: FteTransportFactory = (transport, config) =>
    FteServer.wrapTransport(transport, config)
): void {
  const originalConnect = server.connect.bind(server);

  server.connect = async (transport: Transport): Promise<void> => {
    const wrapped = wrapTransport(transport, { sandbox });
    const rawWrappedClose = wrapped.close.bind(wrapped);

    let closing = false;
    let closePromise: Promise<void> = Promise.resolve();
    const closeWrappedOnce = (): Promise<void> => {
      if (closing) return closePromise;
      closing = true;

      try {
        closePromise = Promise.resolve(rawWrappedClose());
      } catch (error) {
        closePromise = Promise.reject(error);
      }
      return closePromise;
    };

    // Any SDK-driven close must use the same idempotent cleanup path.
    wrapped.close = closeWrappedOnce;

    try {
      await originalConnect(wrapped);
    } catch (error) {
      await closeWrappedOnce().catch((cleanupError) => {
        console.error("[staff-mcp] Failed to clean up FTE transport after connect failure:", cleanupError);
      });

      // Some transports reject start() without firing onclose. Release only if
      // this exact wrapper is still bound: an asynchronous stale cleanup must
      // never clear a newer reconnect that has already succeeded.
      if (server.server.transport === wrapped) {
        try {
          wrapped.onclose?.();
        } catch (cleanupError) {
          console.error("[staff-mcp] Failed to release MCP transport after connect failure:", cleanupError);
        }
      }
      throw error;
    }

    // Protocol.connect() installs its callbacks during originalConnect().
    // Compose only afterwards so both the SDK and FTE cleanup always run.
    const protocolOnClose = wrapped.onclose;
    let closeHandled = false;
    wrapped.onclose = () => {
      if (closeHandled) return;
      closeHandled = true;

      try {
        protocolOnClose?.();
      } finally {
        void closeWrappedOnce().catch((cleanupError) => {
          console.error("[staff-mcp] Failed to clean up closed FTE transport:", cleanupError);
        });
      }
    };

    // Cover the narrow race where this delegate closes after connect resolves
    // but before the composed callback above is installed. Transport identity,
    // rather than global connected state, protects a newer concurrent binding.
    if (server.server.transport !== wrapped) {
      await closeWrappedOnce();
    }
  };
}
