import assert from "node:assert/strict";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { FteServer } from "mcp-fte";
import { installFteTransportLifecycle } from "../src/transports/fte-lifecycle.js";

class TestTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  closeCalls = 0;

  constructor(
    private readonly startFailure?: Error,
    private readonly closeBeforeReject = false,
    private readonly closeGate?: { started: () => void; wait: Promise<void> }
  ) {}

  async start(): Promise<void> {
    if (this.startFailure) {
      if (this.closeBeforeReject) this.onclose?.();
      throw this.startFailure;
    }
  }

  async send(): Promise<void> {}

  async close(): Promise<void> {
    this.closeCalls++;
    this.onclose?.();
    this.closeGate?.started();
    await this.closeGate?.wait;
  }

  disconnect(): void {
    this.onclose?.();
  }
}

function createServer(cleanupCounter: { value: number }): McpServer {
  const server = new McpServer({ name: "fte-lifecycle-test", version: "1.0.0" });
  installFteTransportLifecycle(server, [], (transport, config) => {
    const wrapped = FteServer.wrapTransport(transport, config);
    const close = wrapped.close.bind(wrapped);
    wrapped.close = async () => {
      cleanupCounter.value++;
      await close();
    };
    return wrapped;
  });
  return server;
}

async function flushCleanup(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("self-closing reverse transports dispose the FTE wrapper exactly once and allow reconnect", async () => {
  const cleanupCounter = { value: 0 };
  const server = createServer(cleanupCounter);
  const first = new TestTransport();

  await server.connect(first);
  assert.equal(server.isConnected(), true);

  first.disconnect();
  await flushCleanup();
  assert.equal(server.isConnected(), false);
  assert.equal(cleanupCounter.value, 1);

  const second = new TestTransport();
  await server.connect(second);
  assert.equal(server.isConnected(), true);

  await server.close();
  await flushCleanup();
  assert.equal(server.isConnected(), false);
  assert.equal(cleanupCounter.value, 2);
});

test("failed starts clean up FTE state even when the transport does not emit onclose", async () => {
  const cleanupCounter = { value: 0 };
  const server = createServer(cleanupCounter);
  const failed = new TestTransport(new Error("connect failed"), false);

  await assert.rejects(server.connect(failed), /connect failed/);
  await flushCleanup();
  assert.equal(server.isConnected(), false);
  assert.equal(cleanupCounter.value, 1);

  const next = new TestTransport();
  await server.connect(next);
  assert.equal(server.isConnected(), true);
  await server.close();
});

test("failed starts that already emitted onclose still clean up only once", async () => {
  const cleanupCounter = { value: 0 };
  const server = createServer(cleanupCounter);
  const failed = new TestTransport(new Error("closed while connecting"), true);

  await assert.rejects(server.connect(failed), /closed while connecting/);
  await flushCleanup();
  assert.equal(server.isConnected(), false);
  assert.equal(cleanupCounter.value, 1);
});

test("stale failed-transport cleanup cannot detach a newer connection", async () => {
  const cleanupCounter = { value: 0 };
  const server = createServer(cleanupCounter);

  let markCloseStarted!: () => void;
  const closeStarted = new Promise<void>((resolve) => {
    markCloseStarted = resolve;
  });
  let releaseClose!: () => void;
  const closeWait = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });

  const failed = new TestTransport(
    new Error("first connect failed"),
    false,
    { started: markCloseStarted, wait: closeWait }
  );
  const firstConnect = server.connect(failed);
  await closeStarted;

  // The first delegate has synchronously fired onclose, so Protocol is free to
  // bind a replacement while the old FTE close remains asynchronously pending.
  const replacement = new TestTransport();
  await server.connect(replacement);
  assert.equal(server.isConnected(), true);

  releaseClose();
  await assert.rejects(firstConnect, /first connect failed/);
  assert.equal(server.isConnected(), true);
  assert.equal(server.server.transport !== undefined, true);

  await server.close();
});
