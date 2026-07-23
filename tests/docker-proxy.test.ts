import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runDockerProxy, validateAdditionalDockerArgs } from "../src/docker-proxy.js";

const FIXTURE_CONTAINER_ID = "a".repeat(64);

const FIXTURE_SOURCE = String.raw`
import * as fs from "node:fs";

const [mode, eventsPath, capturePath, command, ...args] = process.argv.slice(2);
const appendEvent = (event) => fs.appendFileSync(eventsPath, event + "\n");

if (command === "rm") {
  const containerId = args.at(-1);
  appendEvent("rm:" + containerId);
  if (mode === "cleanup-missing") {
    console.error("Error: No such container: " + containerId);
    process.exit(1);
  }
  if (mode === "cleanup-fail") {
    console.error("permission denied while removing " + containerId);
    process.exit(2);
  }
  if (mode === "cleanup-hang") {
    process.on("SIGTERM", () => appendEvent("rm-sigterm"));
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }
  process.exit(0);
}

if (command !== "run") {
  throw new Error("Unexpected fake Docker command: " + command);
}

const cidFileIndex = args.findIndex((arg) => arg === "--cidfile");
const nameIndex = args.findIndex((arg) => arg === "--name");
if (cidFileIndex < 0 || !args[cidFileIndex + 1]) {
  throw new Error("The Docker proxy did not provide --cidfile");
}
if (nameIndex < 0 || !args[nameIndex + 1]) {
  throw new Error("The Docker proxy did not provide --name");
}

const containerName = args[nameIndex + 1];
if (mode === "crash-before-cidfile") {
  appendEvent("created:" + containerName);
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 50);
  await new Promise(() => {});
}
if (mode === "delay-before-cidfile") {
  appendEvent("created:" + containerName);
  process.stdin.resume();
  process.on("SIGTERM", () => {
    appendEvent("sigterm");
    setTimeout(() => process.exit(143), 20);
  });
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

fs.writeFileSync(args[cidFileIndex + 1], "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
appendEvent("start");

if (mode === "capture") {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  process.stdin.on("end", () => {
    fs.writeFileSync(capturePath, Buffer.concat(chunks));
    appendEvent("stdin-end");
  });
  process.stdin.resume();
} else if (
  mode === "ignore-shutdown" ||
  mode === "cleanup-missing" ||
  mode === "cleanup-fail" ||
  mode === "cleanup-hang"
) {
  process.stdin.on("end", () => appendEvent("stdin-end"));
  process.stdin.resume();
  process.on("SIGTERM", () => appendEvent("sigterm"));
  setInterval(() => {}, 1_000);
} else if (mode === "crash") {
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 50);
  setInterval(() => {}, 1_000);
} else if (mode === "exit-nonzero") {
  setTimeout(() => process.exit(125), 50);
  setInterval(() => {}, 1_000);
} else {
  throw new Error("Unknown fixture mode: " + mode);
}
`;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForEvent(eventsPath: string, event: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf8").split("\n") : [];
    if (events.includes(event)) {
      return;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for fixture event '${event}'`);
}

function readEvents(eventsPath: string): string[] {
  if (!fs.existsSync(eventsPath)) {
    return [];
  }
  return fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
}

function createFixture(t: { after(callback: () => void): void }) {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "staff-mcp-docker-proxy-test-"));
  const fixturePath = path.join(fixtureDir, "fake-docker.mjs");
  const eventsPath = path.join(fixtureDir, "events.log");
  const capturePath = path.join(fixtureDir, "stdin.bin");
  fs.writeFileSync(fixturePath, FIXTURE_SOURCE);
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  return { fixtureDir, fixturePath, eventsPath, capturePath };
}

function runFixture(
  fixturePath: string,
  eventsPath: string,
  capturePath: string,
  mode: string,
  transport: string,
  input: PassThrough,
  signals: EventEmitter,
  timeoutOverrides: {
    gracefulShutdownTimeoutMs?: number;
    containerIdWaitTimeoutMs?: number;
    containerCleanupTimeoutMs?: number;
    forceKillTimeoutMs?: number;
  } = {}
): Promise<number> {
  return runDockerProxy(["run", "fake-image"], transport, {
    command: process.execPath,
    commandPrefixArgs: [fixturePath, mode, eventsPath, capturePath],
    input,
    signalSource: signals,
    gracefulShutdownTimeoutMs: 500,
    containerIdWaitTimeoutMs: 200,
    containerCleanupTimeoutMs: 500,
    forceKillTimeoutMs: 200,
    ...timeoutOverrides,
  });
}

test("reverse Docker proxy ignores closed host stdin and shuts down through its private lifecycle pipe", async (t) => {
  const { fixturePath, eventsPath, capturePath } = createFixture(t);
  const hostInput = new PassThrough();
  const signals = new EventEmitter();
  hostInput.end(); // Simulate PM2/systemd providing /dev/null or an already-closed fd 0.

  let settled = false;
  const resultPromise = runFixture(
    fixturePath,
    eventsPath,
    capturePath,
    "capture",
    "reverse",
    hostInput,
    signals
  );
  void resultPromise.then(() => {
    settled = true;
  });

  await waitForEvent(eventsPath, "start");
  await delay(100);
  assert.equal(settled, false, "closed host stdin must not stop reverse/http transports");
  assert.deepEqual(readEvents(eventsPath), ["start"]);

  signals.emit("SIGTERM");
  assert.equal(await resultPromise, 0);
  assert.equal(fs.readFileSync(capturePath).length, 0);
  assert.deepEqual(readEvents(eventsPath), ["start", "stdin-end"]);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("HTTP Docker proxy also ignores closed host stdin", async (t) => {
  const { fixturePath, eventsPath, capturePath } = createFixture(t);
  const hostInput = new PassThrough();
  const signals = new EventEmitter();
  hostInput.end();

  let settled = false;
  const resultPromise = runFixture(
    fixturePath,
    eventsPath,
    capturePath,
    "capture",
    "http",
    hostInput,
    signals
  );
  void resultPromise.then(() => {
    settled = true;
  });

  await waitForEvent(eventsPath, "start");
  await delay(100);
  assert.equal(settled, false);

  signals.emit("SIGHUP");
  assert.equal(await resultPromise, 0);
  assert.deepEqual(readEvents(eventsPath), ["start", "stdin-end"]);
});

test("stdio Docker proxy still forwards MCP input unchanged", async (t) => {
  const { fixturePath, eventsPath, capturePath } = createFixture(t);
  const hostInput = new PassThrough();
  const signals = new EventEmitter();
  const payload = Buffer.from('{"jsonrpc":"2.0","method":"ping"}\nsecond-frame\n');

  const resultPromise = runFixture(
    fixturePath,
    eventsPath,
    capturePath,
    "capture",
    "stdio",
    hostInput,
    signals
  );

  await waitForEvent(eventsPath, "start");
  hostInput.end(payload);

  assert.equal(await resultPromise, 0);
  assert.deepEqual(fs.readFileSync(capturePath), payload);
  assert.deepEqual(readEvents(eventsPath), ["start", "stdin-end"]);
});

test("stuck Docker shutdown removes the tracked container before killing the CLI", async (t) => {
  const { fixturePath, eventsPath, capturePath } = createFixture(t);
  const hostInput = new PassThrough();
  const signals = new EventEmitter();

  const resultPromise = runFixture(
    fixturePath,
    eventsPath,
    capturePath,
    "ignore-shutdown",
    "reverse",
    hostInput,
    signals,
    {
      gracefulShutdownTimeoutMs: 50,
      forceKillTimeoutMs: 50,
    }
  );

  await waitForEvent(eventsPath, "start");
  signals.emit("SIGTERM");

  assert.equal(await resultPromise, 137);
  const events = readEvents(eventsPath);
  assert.ok(events.includes("stdin-end"), "shutdown should first close the lifecycle pipe");
  const cleanupEvent = `rm:${FIXTURE_CONTAINER_ID}`;
  assert.ok(events.includes(cleanupEvent), "the exact cidfile container should be removed");
  assert.ok(events.includes("sigterm"), "the Docker CLI should receive SIGTERM only after cleanup");
  assert.ok(
    events.indexOf(cleanupEvent) < events.indexOf("sigterm"),
    "container cleanup must precede terminating the stuck Docker CLI"
  );
});

test("a Docker CLI killed externally triggers exact-ID fallback cleanup", async (t) => {
  const { fixturePath, eventsPath, capturePath } = createFixture(t);
  const hostInput = new PassThrough();
  const signals = new EventEmitter();

  const resultPromise = runFixture(
    fixturePath,
    eventsPath,
    capturePath,
    "crash",
    "reverse",
    hostInput,
    signals
  );

  assert.equal(await resultPromise, 137);
  assert.ok(readEvents(eventsPath).includes(`rm:${FIXTURE_CONTAINER_ID}`));
});

test("a Docker CLI killed before writing its cidfile falls back to the unique generated name", async (t) => {
  const { fixturePath, eventsPath, capturePath } = createFixture(t);
  const hostInput = new PassThrough();
  const signals = new EventEmitter();

  const resultPromise = runFixture(
    fixturePath,
    eventsPath,
    capturePath,
    "crash-before-cidfile",
    "reverse",
    hostInput,
    signals
  );

  const deadline = Date.now() + 3_000;
  let createdEvent: string | undefined;
  while (!createdEvent && Date.now() < deadline) {
    createdEvent = readEvents(eventsPath).find((event) => event.startsWith("created:"));
    if (!createdEvent) {
      await delay(10);
    }
  }
  assert.ok(createdEvent, "fixture should expose the generated container name");

  assert.equal(await resultPromise, 137);
  const containerName = createdEvent.slice("created:".length);
  assert.match(containerName, /^staff-mcp-\d+-[0-9a-f-]{36}$/);
  assert.ok(readEvents(eventsPath).includes(`rm:${containerName}`));
});

test("shutdown before cidfile creation stops the CLI before cleaning up by name", async (t) => {
  const { fixturePath, eventsPath, capturePath } = createFixture(t);
  const hostInput = new PassThrough();
  const signals = new EventEmitter();

  const resultPromise = runFixture(
    fixturePath,
    eventsPath,
    capturePath,
    "delay-before-cidfile",
    "reverse",
    hostInput,
    signals,
    {
      gracefulShutdownTimeoutMs: 30,
      containerIdWaitTimeoutMs: 50,
      forceKillTimeoutMs: 100,
    }
  );

  let createdEvent: string | undefined;
  const deadline = Date.now() + 3_000;
  while (!createdEvent && Date.now() < deadline) {
    createdEvent = readEvents(eventsPath).find((event) => event.startsWith("created:"));
    if (!createdEvent) {
      await delay(10);
    }
  }
  assert.ok(createdEvent);

  signals.emit("SIGTERM");
  assert.equal(await resultPromise, 143);

  const containerName = createdEvent.slice("created:".length);
  const events = readEvents(eventsPath);
  assert.ok(events.includes("sigterm"));
  assert.ok(events.includes(`rm:${containerName}`));
  assert.ok(
    events.indexOf("sigterm") < events.indexOf(`rm:${containerName}`),
    "name cleanup must happen only after the creating CLI has been stopped"
  );
});

test("a normal nonzero Docker CLI exit also triggers exact-ID fallback cleanup", async (t) => {
  const { fixturePath, eventsPath, capturePath } = createFixture(t);
  const hostInput = new PassThrough();
  const signals = new EventEmitter();

  const resultPromise = runFixture(
    fixturePath,
    eventsPath,
    capturePath,
    "exit-nonzero",
    "reverse",
    hostInput,
    signals
  );

  assert.equal(await resultPromise, 125);
  assert.ok(readEvents(eventsPath).includes(`rm:${FIXTURE_CONTAINER_ID}`));
});

test("a missing container during fallback cleanup is treated as already removed", async (t) => {
  const { fixturePath, eventsPath, capturePath } = createFixture(t);
  const hostInput = new PassThrough();
  const signals = new EventEmitter();

  const resultPromise = runFixture(
    fixturePath,
    eventsPath,
    capturePath,
    "cleanup-missing",
    "reverse",
    hostInput,
    signals,
    {
      gracefulShutdownTimeoutMs: 50,
      forceKillTimeoutMs: 50,
    }
  );

  await waitForEvent(eventsPath, "start");
  signals.emit("SIGTERM");

  assert.equal(await resultPromise, 137);
  assert.ok(readEvents(eventsPath).includes(`rm:${FIXTURE_CONTAINER_ID}`));
});

test("failed fallback cleanup reaches a bounded error result", async (t) => {
  const { fixturePath, eventsPath, capturePath } = createFixture(t);
  const hostInput = new PassThrough();
  const signals = new EventEmitter();

  const resultPromise = runFixture(
    fixturePath,
    eventsPath,
    capturePath,
    "cleanup-fail",
    "reverse",
    hostInput,
    signals,
    {
      gracefulShutdownTimeoutMs: 50,
      containerCleanupTimeoutMs: 100,
      forceKillTimeoutMs: 50,
    }
  );

  await waitForEvent(eventsPath, "start");
  signals.emit("SIGINT");

  assert.equal(await resultPromise, 1);
  const cleanupEvents = readEvents(eventsPath).filter((event) => event === `rm:${FIXTURE_CONTAINER_ID}`);
  assert.equal(cleanupEvents.length, 1, "a failed cleanup must not overlap with an automatic retry");
});

test("a hung fallback cleanup is escalated through SIGTERM and SIGKILL", async (t) => {
  const { fixturePath, eventsPath, capturePath } = createFixture(t);
  const hostInput = new PassThrough();
  const signals = new EventEmitter();

  const resultPromise = runFixture(
    fixturePath,
    eventsPath,
    capturePath,
    "cleanup-hang",
    "reverse",
    hostInput,
    signals,
    {
      gracefulShutdownTimeoutMs: 30,
      containerCleanupTimeoutMs: 50,
      forceKillTimeoutMs: 50,
    }
  );

  await waitForEvent(eventsPath, "start");
  signals.emit("SIGTERM");

  assert.equal(await resultPromise, 1);
  const events = readEvents(eventsPath);
  assert.equal(events.filter((event) => event === `rm:${FIXTURE_CONTAINER_ID}`).length, 1);
  assert.ok(events.includes("rm-sigterm"), "hung cleanup should receive SIGTERM before SIGKILL");
});

test("unsafe additional Docker arguments are rejected", () => {
  assert.doesNotThrow(() =>
    validateAdditionalDockerArgs(["--detach=false", "--rm", "--rm=t", "-i", "--interactive=true"])
  );

  for (const args of [
    ["-d"],
    ["-itd"],
    ["--detach"],
    ["--detach=true"],
    ["--rm=false"],
    ["--rm=f"],
    ["--rm=0"],
    ["--interactive=false"],
    ["--interactive=f"],
    ["--interactive=0"],
    ["-i=false"],
    ["-it=false"],
    ["--cidfile=/tmp/unsafe.cid"],
    ["--name=staff-mcp-test"],
  ]) {
    assert.throws(() => validateAdditionalDockerArgs(args));
  }
});

test("Docker proxy reports a spawn failure without hanging", async () => {
  const signals = new EventEmitter();
  const code = await runDockerProxy(["run", "fake-image"], "reverse", {
    command: path.join(os.tmpdir(), `missing-staff-mcp-runtime-${process.pid}`),
    signalSource: signals,
    gracefulShutdownTimeoutMs: 100,
    containerIdWaitTimeoutMs: 100,
    containerCleanupTimeoutMs: 100,
    forceKillTimeoutMs: 100,
  });

  assert.equal(code, 1);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("Docker proxy refuses a pre-existing user cidfile to avoid cleaning a stale container ID", async (t) => {
  const { fixtureDir } = createFixture(t);
  const cidFilePath = path.join(fixtureDir, "existing.cid");
  fs.writeFileSync(cidFilePath, "unrelated-container\n");
  const signals = new EventEmitter();

  const code = await runDockerProxy(
    ["run", "--cidfile", cidFilePath, "fake-image"],
    "reverse",
    {
      command: process.execPath,
      signalSource: signals,
    }
  );

  assert.equal(code, 1);
  assert.equal(fs.readFileSync(cidFilePath, "utf8"), "unrelated-container\n");
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
