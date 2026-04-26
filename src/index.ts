#!/usr/bin/env node
import { Command } from "commander";
import * as path from "path";
import { createServer } from "./server.js";
import { startStdioServer } from "./transports/stdio.js";
import { startHttpServer } from "./transports/http.js";
import { ensureStaffDirs } from "./utils/paths.js";

const program = new Command();

program
  .name("staff-mcp")
  .description("MCP Server with file, shell, and LSP capabilities.")
  .version("1.0.0")
  .option("-t, --transport <type>", "Transport type (stdio or http)", "stdio")
  .option("-p, --port <number>", "Port for HTTP server", "3000")
  .option("-h, --host <address>", "Host for HTTP server", "127.0.0.1")
  .option("-w, --working-dir <path>", "Working directory for the server (defaults to current execution path)", process.cwd())
  .option("-d, --allowed-dir <paths...>", "Additional directories allowed for sandbox", [])
  .option("-r, --profile <name>", "The active profile for skills and instructions (e.g., developer, default)", "default")
  .action(async (options) => {
    ensureStaffDirs();
    const workingDir = path.resolve(options.workingDir);
    const allowedDirs = options.allowedDir.map((d: string) => path.resolve(d));
    const profile = options.profile;
    const server = createServer("staff-mcp", "1.0.0", workingDir, allowedDirs, profile);

    if (options.transport === "http") {
      await startHttpServer(server, parseInt(options.port, 10), options.host);
    } else {
      await startStdioServer(server);
    }
  });

program.parse(process.argv);
