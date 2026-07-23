#!/usr/bin/env node
import { Command } from "commander";
import * as path from "path";
import * as os from "os";
import { createServerFactory } from "./server.js";
import { runDockerProxy, validateAdditionalDockerArgs } from "./docker-proxy.js";
import { STAFF_MCP_PACKAGE_ROOT, STAFF_MCP_VERSION } from "./package-info.js";
import { startStdioServer } from "./transports/stdio.js";
import { startHttpServer } from "./transports/http.js";
import { startReverseServer } from "./transports/reverse.js";
import { ensureStaffDirs, STAFF_SKILLS_DIR, STAFF_PROFILES_DIR } from "./utils/paths.js";
import { ensureRipgrep } from "./utils/tool-utils.js";

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

const program = new Command();

program
  .name("staff-mcp")
  .description("MCP Server with file, shell, and LSP capabilities.")
  .version(STAFF_MCP_VERSION)
  .option("-t, --transport <type>", "Transport type (stdio, http, reverse)", "stdio")
  .option("-p, --port <number>", "Port for HTTP server", "3000")
  .option("-h, --host <address>", "Host for HTTP server", "127.0.0.1")
  .option("--ru, --reverse-url <url>", "URL for Reverse MCP Gateway (e.g. http://localhost:3000/api/mcp-reverse)")
  .option("--rt, --reverse-token <token>", "Security token for Reverse MCP")
  .option("--rn, --reverse-name <name>", "Server name for Reverse MCP")
  .option("-w, --working-dir <path>", "Working directory for the server (defaults to current execution path)", process.cwd())
  .option("-d, --allowed-dir <paths...>", "Additional directories allowed for sandbox", [])
  .option("-r, --profile <name>", "The active profile for skills and instructions (e.g., android-reverse, default)", "default")
  .option("-m, --max-mcp-sessions <number>", "Maximum number of concurrent MCP sessions allowed", "5")
  .option("--enable-lsp", "Enable LSP capabilities (disabled by default)", false)
  .option("--docker <image>", "Run the MCP server inside a Docker container using the specified image")
  .option("-D, --docker-args <args...>", "Additional arguments to pass to the docker run command (e.g., -e ADB_SERVER_SOCKET=...)")
  .allowUnknownOption()
  .action(async (options, command) => {
    // -------------------------------------------------------------
    // Docker Transparent Proxy Mode
    // -------------------------------------------------------------
    if (options.docker) {
      // 1. Locate the package root (where package.json is)
      const pkgRoot = STAFF_MCP_PACKAGE_ROOT;

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

      // 3.8 Mount Host User-Level Skills and Profiles
      // Do not mount the entire ~/.staff to avoid cross-platform binary conflicts (e.g., native extensions, ripgrep)
      ensureStaffDirs(); // Ensure host directories exist to avoid Docker creating them with root permissions
      
      // Mount to a fixed, safe path in the container and point the containerized staff-mcp to it
      // This avoids making any assumptions about the container's user or HOME directory
      const containerStaffDir = "/opt/.staff";
      dockerArgs.push("-e", `STAFF_GLOBAL_DIR=${containerStaffDir}`);
      dockerArgs.push("-v", `${toDockerVolumePath(STAFF_SKILLS_DIR)}:${containerStaffDir}/skills`);
      dockerArgs.push("-v", `${toDockerVolumePath(STAFF_PROFILES_DIR)}:${containerStaffDir}/profiles`);

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
        const additionalDockerArgs: string[] = [];

        // commander parses varargs as an array of strings
        options.dockerArgs.forEach((arg: string) => {
          // simple split by space if the user quoted them (e.g., "-e FOO=1")
          // If the user uses standard bash expansion, commander already handles it.
          const parts = arg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [arg];
          parts.forEach((part) => additionalDockerArgs.push(part.replace(/^['"]|['"]$/g, "")));
        });

        try {
          validateAdditionalDockerArgs(additionalDockerArgs);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[staff-mcp] Invalid Docker arguments: ${message}`);
          process.exit(1);
        }

        dockerArgs.push(...additionalDockerArgs);
      }

      // 7. Inject environment variable to detect docker proxy mode
      dockerArgs.push("-e", "STAFF_MCP_IS_DOCKER=1");

      // 8. Specify the target image
      dockerArgs.push(options.docker);

      // 9. Reconstruct the command inside the container
      dockerArgs.push("node", "/opt/staff-mcp/dist/src/index.js");
      dockerArgs.push("-t", options.transport);

      if (options.transport === "reverse") {
        if (options.reverseUrl) dockerArgs.push("--ru", options.reverseUrl);
        if (options.reverseToken) dockerArgs.push("--rt", options.reverseToken);
        if (options.reverseName) dockerArgs.push("--rn", options.reverseName);
      } else {
        dockerArgs.push("-p", String(options.port));
        // Inside container, we must listen on all interfaces for HTTP to be exposed
        if (options.transport === "http") {
          dockerArgs.push("-h", "0.0.0.0");
        } else {
          dockerArgs.push("-h", options.host);
        }
      }
      
      dockerArgs.push("-w", "/workspace");
      
      if (options.allowedDir && options.allowedDir.length > 0) {
        options.allowedDir.forEach((dir: string) => {
          dockerArgs.push("-d", path.resolve(dir)); // paths inside container match host
        });
      }
      dockerArgs.push("-r", options.profile);
      dockerArgs.push("-m", String(options.maxMcpSessions));
      if (options.enableLsp) {
        dockerArgs.push("--enable-lsp");
      }

      // 10. Run Docker with transport-aware stdin and a controlled shutdown lifecycle.
      // Reverse/HTTP keep a private lifecycle pipe open instead of depending on
      // the supervisor's stdin, which may be /dev/null or already closed.
      const exitCode = await runDockerProxy(dockerArgs, options.transport);
      // Supervisors such as PM2 keep an IPC channel open, so setting exitCode is
      // not sufficient to terminate after the Docker child has been reaped.
      // At this point cleanup has completed, making an explicit exit safe.
      process.exit(exitCode);
    }

    // -------------------------------------------------------------
    // Standard Host Mode
    // -------------------------------------------------------------
    
    // Auto-exit if we are running as a proxy child and the host pipe breaks
    if (process.env.STAFF_MCP_IS_DOCKER === "1") {
      if (options.transport !== "stdio") {
        process.stdin.resume(); // keep reading to detect end in non-stdio modes
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

    // Pre-warm ripgrep: trigger background install if not present, so it's
    // likely ready by the time the first search_workspace call happens.
    ensureRipgrep().catch(err => {
      console.error("[staff-mcp] Background ripgrep install failed:", err.message);
    });

    const workingDir = path.resolve(options.workingDir);
    const allowedDirs = options.allowedDir.map((d: string) => path.resolve(d));
    const profile = options.profile;
    const maxMcpSessions = parseInt(options.maxMcpSessions, 10) || 5;
    const enableLsp = !!options.enableLsp;
    const serverFactory = createServerFactory("staff-mcp", STAFF_MCP_VERSION, workingDir, allowedDirs, profile, maxMcpSessions, enableLsp);

    if (options.transport === "http") {
      await startHttpServer(serverFactory, parseInt(options.port, 10), options.host);
    } else if (options.transport === "reverse") {
      if (!options.reverseUrl || !options.reverseToken || !options.reverseName) {
        console.error("[staff-mcp] Error: --ru (reverse-url), --rt (reverse-token), and --rn (reverse-name) are required for reverse transport.");
        process.exit(1);
      }
      await startReverseServer(serverFactory(), options.reverseUrl, options.reverseToken, options.reverseName);
    } else {
      await startStdioServer(serverFactory());
    }
  });

await program.parseAsync(process.argv);
