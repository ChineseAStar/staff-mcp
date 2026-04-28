#!/usr/bin/env node
import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { createServer } from "./server.js";
import { startStdioServer } from "./transports/stdio.js";
import { startHttpServer } from "./transports/http.js";
import { ensureStaffDirs } from "./utils/paths.js";

// Global error handlers to prevent the MCP server from crashing due to unhandled child process errors
process.on("uncaughtException", (err: any) => {
  if (err.code === "ENOENT" && err.syscall && err.syscall.startsWith("spawn")) {
    console.error(`[staff-mcp] Captured unhandled spawn error: ${err.message}. A background tool failed to start.`);
  } else {
    console.error("[staff-mcp] Uncaught Exception:", err);
  }
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[staff-mcp] Unhandled Rejection at:", promise, "reason:", reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  .option("-r, --profile <name>", "The active profile for skills and instructions (e.g., android-reverse, default)", "default")
  .option("--docker <image>", "Run the MCP server inside a Docker container using the specified image")
  .option("-D, --docker-args <args...>", "Additional arguments to pass to the docker run command (e.g., -e ADB_SERVER_SOCKET=...)")
  .allowUnknownOption()
  .action(async (options, command) => {
    // -------------------------------------------------------------
    // Docker Transparent Proxy Mode
    // -------------------------------------------------------------
    if (options.docker) {
      // 1. Locate the package root (where package.json is)
      let pkgRoot = path.resolve(__dirname, "..");
      while (!fs.existsSync(path.join(pkgRoot, "package.json")) && pkgRoot !== "/") {
        pkgRoot = path.dirname(pkgRoot);
      }

      // 2. Cross-platform path normalizer for Volume Mounts
      const toDockerVolumePath = (p: string) => {
        if (os.platform() === "win32") {
          return p.replace(/^([a-zA-Z]):/, (_, drive) => `/${drive.toLowerCase()}`).replace(/\\/g, "/");
        }
        return p;
      };

      const hostCwd = path.resolve(options.workingDir);
      const dockerArgs = ["run", "-i", "--rm"];

      // 3. Mount working directory and package source
      dockerArgs.push("-v", `${toDockerVolumePath(hostCwd)}:/workspace`);
      dockerArgs.push("-w", "/workspace");
      dockerArgs.push("-v", `${toDockerVolumePath(pkgRoot)}:/opt/staff-mcp:ro`);

      // 3.5 Check if we are nested inside a node_modules folder (npx/pnpm global scenario)
      // If yes, map the parent node_modules into the container as well so dependencies can be resolved
      const isNestedInNodeModules = pkgRoot.includes("node_modules");
      if (isNestedInNodeModules) {
        // By mapping the parent directory of staff-mcp's pkgRoot to /opt/node_modules,
        // Node.js inside the container can look up and find shared dependencies.
        const outerNodeModules = path.resolve(pkgRoot, "..");
        dockerArgs.push("-v", `${toDockerVolumePath(outerNodeModules)}:/opt/node_modules:ro`);
      }

      // 4. Mount additional allowed directories
      if (options.allowedDir && options.allowedDir.length > 0) {
        options.allowedDir.forEach((dir: string) => {
          const absDir = path.resolve(dir);
          dockerArgs.push("-v", `${toDockerVolumePath(absDir)}:${absDir}`);
        });
      }

      // 5. Handle HTTP port forwarding
      if (options.transport === "http") {
        dockerArgs.push("-p", `${options.port}:${options.port}`);
      }

      // 6. Inject advanced custom args (e.g., ADB pass-through, network configs)
      if (options.dockerArgs && options.dockerArgs.length > 0) {
        // commander parses varargs as an array of strings
        options.dockerArgs.forEach((arg: string) => {
          // simple split by space if the user quoted them (e.g., "-e FOO=1")
          // If the user uses standard bash expansion, commander already handles it.
          const parts = arg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [arg];
          parts.forEach(p => dockerArgs.push(p.replace(/^['"]|['"]$/g, '')));
        });
      }

      // 7. Inject environment variable to detect docker proxy mode
      dockerArgs.push("-e", "STAFF_MCP_IS_DOCKER=1");

      // 8. Specify the target image
      dockerArgs.push(options.docker);

      // 9. Reconstruct the command inside the container
      dockerArgs.push("node", "/opt/staff-mcp/dist/src/index.js");
      dockerArgs.push("-t", options.transport);
      dockerArgs.push("-p", String(options.port));
      
      // Inside container, we must listen on all interfaces for HTTP to be exposed
      if (options.transport === "http") {
        dockerArgs.push("-h", "0.0.0.0");
      } else {
        dockerArgs.push("-h", options.host);
      }
      
      dockerArgs.push("-w", "/workspace");
      
      if (options.allowedDir && options.allowedDir.length > 0) {
        options.allowedDir.forEach((dir: string) => {
          dockerArgs.push("-d", path.resolve(dir)); // paths inside container match host
        });
      }
      dockerArgs.push("-r", options.profile);

      // 10. Spawn Docker and pipe I/O natively
      const child = spawn("docker", dockerArgs, { stdio: ["pipe", "inherit", "inherit"] });
      process.stdin.pipe(child.stdin);
      
      child.on("exit", (code) => process.exit(code ?? 0));
      child.on("error", (err) => {
        console.error("[staff-mcp] Failed to start docker proxy:", err.message);
        process.exit(1);
      });
      
      return; // Terminate host process execution
    }

    // -------------------------------------------------------------
    // Standard Host Mode
    // -------------------------------------------------------------
    
    // Auto-exit if we are running as a proxy child and the host pipe breaks
    if (process.env.STAFF_MCP_IS_DOCKER === "1") {
      if (options.transport === "http") {
        process.stdin.resume(); // keep reading to detect end in HTTP mode
      }
      process.stdin.on("end", () => {
        console.error("[staff-mcp] Host pipe closed, terminating container...");
        process.exit(0);
      });
      process.stdin.on("error", () => {
        process.exit(1);
      });
    }

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
