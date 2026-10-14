import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { registerMcpClientTools } from "../src/tools/mcp-client-tools.js";

const instructions = "Use workspace paths.\nPreserve original file content.";
const readTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file.\nSupports optional line range selection.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, startLine: { type: "integer" } },
    required: ["path"],
  },
};
const writeTool: Tool = {
  name: "write_file",
  description: "Write or overwrite file content.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const noDescriptionTool: Tool = { name: "no_description", inputSchema: { type: "object" } };
const tools = [readTool, writeTool, noDescriptionTool];
const overview = `Session: dev
Server: controlled-mcp v1.0.0
Capabilities: prompts, tools

[Server Instructions]
${instructions}

Available Tools (3 total):

  [read_file]
    Read the contents of a file.
    Args: 2 parameter(s) [required: path]
  [write_file]
    Write or overwrite file content.
    Args: 1 parameter(s) [required: path]
  [no_description]
    Args: none
💡 Tip: Use explore_mcp_session with "toolName" to inspect a specific tool's full schema before calling it.`;

function text(result: CallToolResult): string {
  assert.equal(result.content.length, 1);
  const content = result.content[0];
  assert.equal(content.type, "text");
  return content.text as string;
}

async function connectStaff(t: TestContext, maxSessions = 5) {
  const server = new McpServer({ name: "mcp-client-tools-test", version: "1.0.0" });
  registerMcpClientTools(server, { maxSessions });
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const invoke = async (name: string, args: Record<string, unknown>, options?: RequestOptions) =>
    await client.callTool({ name, arguments: args }, undefined, options) as CallToolResult;
  t.after(async () => {
    try {
      await invoke("manage_mcp_session", { action: "stop", sessionId: "dev" });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
  return { client, invoke };
}

async function createHarness(t: TestContext, options: {
  page?: (cursor: string | undefined, signal: AbortSignal) => ListToolsResult | Promise<ListToolsResult>;
  callResult?: CallToolResult;
} = {}) {
  const nested = new Server(
    { name: "controlled-mcp", version: "1.0.0" },
    { capabilities: { tools: {}, prompts: { listChanged: true } }, instructions }
  );
  const cursors: Array<string | undefined> = [];
  let promptCalls = 0;
  nested.setRequestHandler(ListToolsRequestSchema, (request, extra) => {
    cursors.push(request.params?.cursor);
    return options.page?.(request.params?.cursor, extra.signal) ?? { tools };
  });
  nested.setRequestHandler(ListPromptsRequestSchema, () => {
    promptCalls++;
    return { prompts: [{ name: "review_prompt", description: "Review the current workspace." }] };
  });
  nested.setRequestHandler(CallToolRequestSchema, (request) => options.callResult ?? {
    content: [{ type: "text", text: JSON.stringify(request.params.arguments) }],
  });

  const staff = await connectStaff(t);
  const connect = Client.prototype.connect;
  let nestedClient!: Client;
  // Only replace the subprocess connection; requests still traverse real SDK transports.
  t.mock.method(Client.prototype, "connect", async function (
    this: Client, ...args: Parameters<Client["connect"]>
  ) {
    if (args[0] instanceof StdioClientTransport) {
      nestedClient = this;
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([nested.connect(serverTransport), connect.call(this, clientTransport, args[1])]);
    } else {
      await connect.apply(this, args);
    }
  });
  t.after(() => nested.close());
  const start = await staff.invoke("manage_mcp_session", {
    action: "start", sessionId: "dev", command: process.execPath, args: [],
  });
  assert.notEqual(start.isError, true, text(start));

  return {
    ...staff,
    nestedClient,
    cursors,
    promptCalls: () => promptCalls,
    explore: (toolName?: string, requestOptions?: RequestOptions) => staff.invoke(
      "explore_mcp_session",
      { sessionId: "dev", ...(toolName === undefined ? {} : { toolName }) },
      requestOptions
    ),
  };
}

test("T01/T07: single-page overview preserves server information, instructions and compact summaries", async (t) => {
  const h = await createHarness(t);
  const result = await h.explore();
  assert.notEqual(result.isError, true);
  assert.equal(text(result), overview);
  assert.deepEqual(h.cursors, [undefined]);
  assert.equal(h.promptCalls(), 0);
});

test("T02/T04: details preserve the full description and all input JSON Schema fields", async (t) => {
  const richTool: Tool = {
    name: "rich_schema",
    description: "First line.\n\n  Indented line.\r\nFinal line with trailing spaces.  ",
    inputSchema: {
      type: "object",
      properties: {
        payload: { type: "object", properties: { value: { $ref: "#/$defs/Root" } }, additionalProperties: true },
        values: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        choice: { oneOf: [{ type: "boolean" }, { type: "null" }] },
      },
      required: ["payload"],
      $ref: "#/$defs/Root",
      $defs: { Root: { type: "object", properties: { value: { type: "string" } } } },
      oneOf: [{ required: ["payload"] }, { required: ["values"] }],
      anyOf: [{ minProperties: 1 }, { maxProperties: 5 }],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { outputOnlyMarker: { type: "string" } } },
  };
  const h = await createHarness(t, { page: () => ({ tools: [richTool] }) });
  const result = await h.explore(richTool.name);
  assert.notEqual(result.isError, true);
  assert.equal(text(result), `Tool: ${richTool.name}\nDescription: ${richTool.description}\n\nArguments Schema (JSON Schema):\n${JSON.stringify(richTool.inputSchema, null, 2)}`);
  assert.deepEqual(JSON.parse(text(result).split("Arguments Schema (JSON Schema):\n")[1]), richTool.inputSchema);
  assert.doesNotMatch(text(result), /outputOnlyMarker/);
});

test("T03/T04/T05: missing tools report every ordered name and complete original description, without schemas", async (t) => {
  const h = await createHarness(t);
  const result = await h.explore("read_fil");
  assert.equal(result.isError, true);
  assert.equal(text(result), `Tool 'read_fil' not found in session 'dev'.
Available Tools (3 total):

[read_file]
${readTool.description}

[write_file]
${writeTool.description}

[no_description]
N/A

Tip: Use explore_mcp_session with "toolName" to inspect a specific tool's full schema.`);
  assert.doesNotMatch(text(result), /Arguments Schema|"properties"/);
});

test("T03/T04: fallback descriptions preserve whitespace, blank lines and carriage returns", async (t) => {
  const description = "  Start.\n\nSecond.\r\nLast.  ";
  const h = await createHarness(t, { page: () => ({ tools: [{ ...readTool, description }] }) });
  assert.ok(text(await h.explore("missing")).includes(`[read_file]\n${description}\n`));
});

test("T05: missing and empty descriptions remain discoverable without changing detail formatting", async (t) => {
  const emptyDescriptionTool = { ...noDescriptionTool, name: "empty_description", description: "" };
  const h = await createHarness(t, { page: () => ({ tools: [noDescriptionTool, emptyDescriptionTool] }) });
  for (const name of ["no_description", "empty_description"]) {
    const result = await h.explore(name);
    assert.notEqual(result.isError, true);
    assert.equal(text(result), `Tool: ${name}\nDescription: N/A\n\nArguments Schema (JSON Schema):\n{\n  "type": "object"\n}`);
  }
  const missing = await h.explore("missing");
  assert.equal(missing.isError, true);
  assert.ok(text(missing).includes("[no_description]\nN/A\n"));
  assert.ok(text(missing).includes("[empty_description]\n\n"));
  assert.doesNotMatch(text(missing), /\[empty_description\]\nN\/A/);
});

test("T06: empty lists report zero tools and an explicit absence in the missing-tool error", async (t) => {
  const h = await createHarness(t, { page: () => ({ tools: [] }) });
  const result = await h.explore();
  assert.notEqual(result.isError, true);
  assert.match(text(result), /Available Tools \(0 total\):/);
  const missing = await h.explore("missing");
  assert.equal(missing.isError, true);
  assert.match(text(missing), /Available Tools \(0 total\):\nNo available tools\./);
});

test("T08: all pages, including an empty intermediate page, are collected in server order", async (t) => {
  const h = await createHarness(t, { page: (cursor) => {
    if (cursor === undefined) return { tools: [readTool], nextCursor: "second" };
    if (cursor === "second") return { tools: [], nextCursor: "third" };
    assert.equal(cursor, "third");
    return { tools: [writeTool, noDescriptionTool] };
  } });
  assert.equal(text(await h.explore()), overview);
  assert.deepEqual(h.cursors, [undefined, "second", "third"]);
});

test("T09: a tool on the second page returns its complete details", async (t) => {
  const h = await createHarness(t, { page: (cursor) => cursor === undefined
    ? { tools: [writeTool], nextCursor: "second" }
    : { tools: [readTool] }
  });
  const result = await h.explore("read_file");
  assert.notEqual(result.isError, true);
  assert.equal(text(result), `Tool: read_file\nDescription: ${readTool.description}\n\nArguments Schema (JSON Schema):\n${JSON.stringify(readTool.inputSchema, null, 2)}`);
  assert.deepEqual(h.cursors, [undefined, "second"]);
});

test("T03/T08: missing-tool candidates include complete descriptions from subsequent pages", async (t) => {
  const h = await createHarness(t, { page: (cursor) => cursor === undefined
    ? { tools: [writeTool], nextCursor: "second" }
    : { tools: [readTool, noDescriptionTool] }
  });
  const result = await h.explore("missing");
  assert.equal(result.isError, true);
  assert.match(text(result), /Available Tools \(3 total\):/);
  assert.ok(text(result).includes(readTool.description!));
  assert.ok(text(result).indexOf("[write_file]") < text(result).indexOf("[read_file]"));
  assert.ok(text(result).indexOf("[read_file]") < text(result).indexOf("[no_description]"));
  assert.deepEqual(h.cursors, [undefined, "second"]);
});

for (const toolName of [undefined, "read_file", "missing"]) {
  test(`T10: a failed later page does not return a partial ${toolName ?? "overview"}`, async (t) => {
    const h = await createHarness(t, { page: (cursor) => {
      if (cursor === undefined) return { tools: [readTool], nextCursor: "second" };
      throw new Error("second page unavailable");
    } });
    const result = await h.explore(toolName);
    assert.equal(result.isError, true);
    assert.match(text(result), /^Failed to explore session: .*second page unavailable/);
    assert.doesNotMatch(text(result), /Available Tools|Arguments Schema|not found/);
    assert.deepEqual(h.cursors, [undefined, "second"]);
  });
}

for (const cycle of [false, true]) {
  test(`T11: ${cycle ? "cyclic" : "repeated"} cursors fail before another duplicate request`, async (t) => {
    const h = await createHarness(t, { page: (cursor) => ({
      tools: [readTool],
      nextCursor: cycle && cursor === "a" ? "b" : "a",
    }) });
    const result = await h.explore();
    assert.equal(result.isError, true);
    assert.match(text(result), /Cannot retrieve a complete tool list: repeated pagination cursor 'a'/);
    assert.doesNotMatch(text(result), /Available Tools/);
    assert.deepEqual(h.cursors, cycle ? [undefined, "a", "b"] : [undefined, "a"]);
  });
}

test("T08: an empty string cursor is passed unchanged rather than treated as the end", async (t) => {
  const h = await createHarness(t, { page: (cursor) => cursor === undefined
    ? { tools: [writeTool], nextCursor: "" }
    : { tools: [readTool, noDescriptionTool] }
  });
  assert.match(text(await h.explore()), /Available Tools \(3 total\):/);
  assert.deepEqual(h.cursors, [undefined, ""]);
});

test("T12/T13: discovery omits prompt requests and listings without disabling real prompt capabilities", async (t) => {
  const h = await createHarness(t);
  for (const toolName of [undefined, "", "read_file", "missing"]) {
    const result = await h.explore(toolName);
    assert.doesNotMatch(text(result), /Available Prompts|review_prompt/);
    if (!toolName) assert.match(text(result), /Capabilities: prompts, tools/);
  }
  assert.equal(h.promptCalls(), 0);
  const prompts = await h.nestedClient.listPrompts();
  assert.equal(prompts.prompts[0].name, "review_prompt");
  assert.equal(h.promptCalls(), 1);
});

test("T14: both discovery and calls direct missing sessions to the actual management list action", async (t) => {
  const h = await createHarness(t);
  for (const [name, args] of [
    ["explore_mcp_session", { sessionId: "absent" }],
    ["call_mcp_session_tool", { sessionId: "absent", method: "read_file" }],
  ] as const) {
    const result = await h.invoke(name, args);
    assert.equal(result.isError, true);
    assert.match(text(result), /MCP Session 'absent' not found/);
    assert.match(text(result), /'manage_mcp_session' with action: "list"/);
    assert.doesNotMatch(text(result), /list_mcp_sessions/);
  }
  assert.match(text(await h.invoke("manage_mcp_session", { action: "list" })), /\[dev\] Status: ready/);
});

test("T15: an empty toolName has the same compact overview as an omitted toolName", async (t) => {
  const h = await createHarness(t);
  assert.deepEqual(await h.explore(""), await h.explore());
  assert.deepEqual(h.cursors, [undefined, undefined]);
});

test("each discovery refreshes the tools rather than using a persistent cache", async (t) => {
  let current = [readTool];
  const h = await createHarness(t, { page: () => ({ tools: current }) });
  assert.match(text(await h.explore()), /\[read_file\]/);
  current = [writeTool];
  const result = await h.explore("read_file");
  assert.equal(result.isError, true);
  assert.match(text(result), /Available Tools \(1 total\):\n\n\[write_file\]/);
  assert.deepEqual(h.cursors, [undefined, undefined]);
});

test("pagination forwards cancellation on every request without introducing timeout options", { timeout: 5000 }, async (t) => {
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const h = await createHarness(t, { page: async (cursor, signal) => {
    if (cursor === undefined) return { tools: [readTool], nextCursor: "second" };
    started.resolve();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
      cancelled.resolve();
      resolve();
    }, { once: true }));
    return { tools: [writeTool], nextCursor: "third" };
  } });
  const protocolRequest = Client.prototype.request;
  const spy = t.mock.method(Client.prototype, "request", function (
    this: Client, ...args: Parameters<Client["request"]>
  ) {
    return protocolRequest.apply(this, args);
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const rejection = assert.rejects(h.explore(undefined, { signal: controller.signal }), /exploration cancelled/);
  await started.promise;
  controller.abort(new Error("exploration cancelled"));
  await Promise.all([rejection, cancelled.promise]);
  assert.deepEqual(h.cursors, [undefined, "second"]);
  const listRequests = spy.mock.calls.filter((call) =>
    (call.arguments[0] as { method?: string }).method === "tools/list" && call.this === h.nestedClient
  );
  assert.equal(listRequests.length, 2);
  const firstOptions = listRequests[0].arguments[2]!;
  assert.ok(firstOptions.signal instanceof AbortSignal);
  assert.equal(firstOptions.signal.aborted, true);
  assert.deepEqual(Object.keys(firstOptions), ["signal"]);
  assert.equal(listRequests[1].arguments[2]!.signal, firstOptions.signal);
});

test("T16: calls retain exact JSON arguments, paginated validation, timeout and caller signal", async (t) => {
  const h = await createHarness(t, { page: (cursor) => cursor === undefined
    ? { tools: [readTool], nextCursor: "second" }
    : { tools: [writeTool] } });
  const callTool = Client.prototype.callTool;
  const spy = t.mock.method(Client.prototype, "callTool", function (
    this: Client, ...args: Parameters<Client["callTool"]>
  ) {
    return callTool.apply(this, args);
  });
  const result = await h.invoke("call_mcp_session_tool", {
    sessionId: "dev", method: "read_file", params: JSON.stringify({ path: "example.txt", startLine: 2 }),
  });
  assert.equal(result.isError, false);
  assert.equal(text(result), '{"path":"example.txt","startLine":2}');
  assert.deepEqual(h.cursors, [undefined, "second"]);
  const nestedCall = spy.mock.calls.find((call) => call.this === h.nestedClient)!;
  assert.ok(nestedCall);
  assert.deepEqual(nestedCall.arguments[0], { name: "read_file", arguments: { path: "example.txt", startLine: 2 } });
  assert.equal(nestedCall.arguments[1], undefined);
  assert.equal(nestedCall.arguments[2]!.timeout, 3600000);
  assert.ok(nestedCall.arguments[2]!.signal instanceof AbortSignal);
});

test("T16: call parameter errors and failed execution keep their existing schema feedback", async (t) => {
  const h = await createHarness(t, { callResult: { content: [{ type: "text", text: "execution rejected" }], isError: true } });
  const malformed = await h.invoke("call_mcp_session_tool", { sessionId: "dev", method: "read_file", params: "{" });
  assert.equal(malformed.isError, true);
  assert.match(text(malformed), /^Failed to parse params JSON:/);
  assert.ok(text(malformed).endsWith(JSON.stringify(readTool.inputSchema, null, 2)));
  const failed = await h.invoke("call_mcp_session_tool", { sessionId: "dev", method: "read_file" });
  assert.equal(failed.isError, true);
  assert.equal(failed.content.length, 2);
  assert.deepEqual(failed.content[0], { type: "text", text: "execution rejected" });
  assert.deepEqual(failed.content[1], {
    type: "text",
    text: `\n\nTool 'read_file' execution failed. Please check the required parameters for this tool. Here is the tool schema:\n${JSON.stringify(readTool.inputSchema, null, 2)}`,
  });
});

test("T16: management and calls work end to end with an actual local stdio subprocess", async (t) => {
  const { client, invoke } = await connectStaff(t, 1);
  const registered = await client.listTools();
  assert.deepEqual(registered.tools.map((tool) => tool.name), ["manage_mcp_session", "explore_mcp_session", "call_mcp_session_tool"]);
  const discoverySchema = registered.tools.find((tool) => tool.name === "explore_mcp_session")!.inputSchema;
  assert.deepEqual(discoverySchema.required, ["sessionId"]);
  assert.equal((discoverySchema.properties!.sessionId as { type: string }).type, "string");
  assert.equal((discoverySchema.properties!.toolName as { type: string }).type, "string");
  assert.deepEqual(Object.keys(discoverySchema.properties!), ["sessionId", "toolName"]);
  assert.equal(text(await invoke("manage_mcp_session", { action: "list" })), "No active MCP sessions. (Active sessions: 0/1)");
  const source = `
    import { Server } from "@modelcontextprotocol/sdk/server/index.js";
    import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
    import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
    const server = new Server({ name: "local-stdio-test", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [${JSON.stringify(readTool)}] }));
    server.setRequestHandler(CallToolRequestSchema, ({ params }) => ({ content: [{ type: "text", text: JSON.stringify({ args: params.arguments, env: process.env.STAFF_MCP_TEST_ENV }) }] }));
    await server.connect(new StdioServerTransport());
  `;
  const start = await invoke("manage_mcp_session", {
    action: "start", sessionId: "dev", command: process.execPath,
    args: ["--input-type=module", "--eval", source], env: { STAFF_MCP_TEST_ENV: "preserved" },
  });
  assert.equal(text(start), "Successfully started and connected to MCP session 'dev' via stdio. (Active sessions: 1/1)\nUse 'explore_mcp_session' to discover available tools.");
  assert.match(text(await invoke("manage_mcp_session", { action: "list" })), /^Active MCP Sessions \(1\/1\):\n- \[dev\] Status: ready/);
  const duplicate = await invoke("manage_mcp_session", { action: "start", sessionId: "dev", command: process.execPath, args: [] });
  assert.equal(duplicate.isError, true);
  assert.match(text(duplicate), /already exists with status 'ready'/);
  const limited = await invoke("manage_mcp_session", { action: "start", sessionId: "other", command: process.execPath, args: [] });
  assert.equal(limited.isError, true);
  assert.match(text(limited), /Maximum active MCP session limit \(1\) reached/);
  const result = await invoke("call_mcp_session_tool", { sessionId: "dev", method: "read_file", params: '{"path":"test.txt"}' });
  assert.equal(result.isError, false);
  assert.equal(text(result), '{"args":{"path":"test.txt"},"env":"preserved"}');
  assert.notEqual((await invoke("explore_mcp_session", { sessionId: "dev", toolName: "read_file" })).isError, true);
  assert.equal(text(await invoke("manage_mcp_session", { action: "stop", sessionId: "dev" })), "Session 'dev' successfully stopped. (Active sessions: 0/1)");
  assert.equal(text(await invoke("manage_mcp_session", { action: "list" })), "No active MCP sessions. (Active sessions: 0/1)");
});


test("tools on later pages can be called after discovery", async (t) => {
  const h = await createHarness(t, { page: (cursor) => cursor === undefined
    ? { tools: [readTool], nextCursor: "next" }
    : { tools: [writeTool] } });
  const discovered = await h.explore("write_file");
  assert.notEqual(discovered.isError, true);
  const result = await h.invoke("call_mcp_session_tool", {
    sessionId: "dev", method: "write_file", params: JSON.stringify({ path: "demo.txt" }),
  });
  assert.equal(result.isError, false);
  assert.equal(text(result), '{"path":"demo.txt"}');
  assert.deepEqual(h.cursors, [undefined, "next", undefined, "next"]);
});

test("a completed paginated discovery retains SDK output validation for earlier pages", async (t) => {
  const first: Tool = { ...readTool, outputSchema: {
    type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"],
  } };
  const h = await createHarness(t, { page: (cursor) => cursor === undefined
    ? { tools: [first], nextCursor: "next" }
    : { tools: [writeTool] }, callResult: {
      content: [{ type: "text", text: "invalid structured output" }],
      structuredContent: { ok: "not a boolean" },
    } });
  assert.notEqual((await h.explore()).isError, true);
  const result = await h.invoke("call_mcp_session_tool", { sessionId: "dev", method: "read_file" });
  assert.equal(result.isError, true);
  assert.match(text(result), /Structured content does not match the tool's output schema/);
});
