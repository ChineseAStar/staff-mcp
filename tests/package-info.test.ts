import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  findPackageRoot,
  readPackageVersion,
  STAFF_MCP_PACKAGE_ROOT,
  STAFF_MCP_VERSION,
} from "../src/package-info.js";

const execFileAsync = promisify(execFile);

test("runtime package metadata comes from the staff-mcp package.json", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(STAFF_MCP_PACKAGE_ROOT, "package.json"), "utf8")
  ) as { name: string; version: string };

  assert.equal(packageJson.name, "staff-mcp");
  assert.equal(STAFF_MCP_VERSION, packageJson.version);
  assert.equal(readPackageVersion(STAFF_MCP_PACKAGE_ROOT), packageJson.version);
  assert.equal(findPackageRoot(path.join(STAFF_MCP_PACKAGE_ROOT, "src", "tools")), STAFF_MCP_PACKAGE_ROOT);
});

test("CLI --version reports the package version", async () => {
  const cliPath = path.join(STAFF_MCP_PACKAGE_ROOT, "dist", "src", "index.js");
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "--version"], {
    cwd: STAFF_MCP_PACKAGE_ROOT,
  });

  assert.equal(stdout.trim(), STAFF_MCP_VERSION);
});

test("MCP initialize response advertises the package version", async () => {
  const serverUrl = pathToFileURL(path.join(STAFF_MCP_PACKAGE_ROOT, "dist", "src", "server.js")).href;
  const packageInfoUrl = pathToFileURL(
    path.join(STAFF_MCP_PACKAGE_ROOT, "dist", "src", "package-info.js")
  ).href;
  const script = `
    import { Client } from "@modelcontextprotocol/sdk/client/index.js";
    import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
    import { createServerFactory } from ${JSON.stringify(serverUrl)};
    import { STAFF_MCP_VERSION } from ${JSON.stringify(packageInfoUrl)};

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServerFactory(
      "staff-mcp",
      STAFF_MCP_VERSION,
      process.cwd(),
      [],
      "default",
      5,
      false
    )();
    const client = new Client({ name: "version-test", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    console.log(JSON.stringify(client.getServerVersion()));
    process.exit(0);
  `;

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { cwd: STAFF_MCP_PACKAGE_ROOT, timeout: 10_000 }
  );
  const outputLines = stdout.trim().split("\n");
  const serverVersion = JSON.parse(outputLines.at(-1)!) as { name: string; version: string };

  assert.equal(serverVersion.name, "staff-mcp");
  assert.equal(serverVersion.version, STAFF_MCP_VERSION);
});
