import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HANDLED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 20_000;
const DEFAULT_CONTAINER_ID_WAIT_TIMEOUT_MS = 1_000;
const DEFAULT_CONTAINER_CLEANUP_TIMEOUT_MS = 20_000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 5_000;
const CONTAINER_ID_POLL_INTERVAL_MS = 50;

interface SignalSource {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  removeListener(event: NodeJS.Signals, listener: () => void): unknown;
}

export interface DockerProxyOptions {
  command?: string;
  commandPrefixArgs?: readonly string[];
  input?: NodeJS.ReadableStream;
  signalSource?: SignalSource;
  gracefulShutdownTimeoutMs?: number;
  containerIdWaitTimeoutMs?: number;
  containerCleanupTimeoutMs?: number;
  forceKillTimeoutMs?: number;
}

interface ContainerIdentityConfig {
  args: string[];
  cidFilePath: string;
  containerName: string;
  ownedDirectory: string;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function exitCodeFromSignal(signal: NodeJS.Signals | null): number {
  switch (signal) {
    case "SIGHUP":
      return 129;
    case "SIGINT":
      return 130;
    case "SIGKILL":
      return 137;
    case "SIGTERM":
      return 143;
    default:
      return 1;
  }
}

function hasManagedIdentityArg(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === "--cidfile" ||
      arg.startsWith("--cidfile=") ||
      arg === "--name" ||
      arg.startsWith("--name=")
  );
}

function prepareContainerIdentity(dockerArgs: readonly string[]): ContainerIdentityConfig {
  const args = [...dockerArgs];
  if (hasManagedIdentityArg(args)) {
    throw new Error("--cidfile and --name are managed internally by staff-mcp.");
  }

  const runIndex = args.indexOf("run");
  if (runIndex < 0) {
    throw new Error("Docker proxy arguments must contain the 'run' subcommand.");
  }

  const ownedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "staff-mcp-container-"));
  const cidFilePath = path.join(ownedDirectory, "container.cid");
  const containerName = `staff-mcp-${process.pid}-${randomUUID()}`;
  args.splice(runIndex + 1, 0, "--cidfile", cidFilePath, "--name", containerName);
  return { args, cidFilePath, containerName, ownedDirectory };
}

function readContainerId(cidFilePath: string): string | undefined {
  try {
    const containerId = fs.readFileSync(cidFilePath, "utf8").trim();
    return /^[a-f0-9]{64}$/i.test(containerId) ? containerId : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined;
    }
    console.error(`[staff-mcp] Failed to read Docker cidfile '${cidFilePath}':`, error);
    return undefined;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMissingContainerError(stderr: string): boolean {
  return /no such container|no container with (?:name or id|id|name).*found|container .* does not exist/i.test(stderr);
}

/**
 * Reject Docker options that would detach the CLI or disable the lifecycle
 * guarantees managed by staff-mcp. This validator is intentionally applied to
 * user-supplied Docker options only, because the command executed inside the
 * container can legitimately contain similarly named flags.
 */
export function validateAdditionalDockerArgs(args: readonly string[]): void {
  for (const arg of args) {
    const normalized = arg.toLowerCase();
    const isShortDetachOption =
      (/^-[^-][a-z]*$/i.test(arg) && arg.slice(1).includes("d")) || normalized.startsWith("-d=");

    if (
      isShortDetachOption ||
      normalized === "--detach" ||
      (normalized.startsWith("--detach=") && normalized !== "--detach=false")
    ) {
      throw new Error("detached containers are not supported by the staff-mcp Docker proxy");
    }

    if (normalized.startsWith("--rm=") && !["--rm=true", "--rm=t", "--rm=1"].includes(normalized)) {
      throw new Error("--rm cannot be disabled by the staff-mcp Docker proxy");
    }

    if (
      normalized.startsWith("--interactive=") &&
      !["--interactive=true", "--interactive=t", "--interactive=1"].includes(normalized)
    ) {
      throw new Error("interactive stdin cannot be disabled by the staff-mcp Docker proxy");
    }

    if (/^-[^-]*i[^=]*=/.test(arg)) {
      throw new Error("assigned -i values are not supported; use -i or --interactive=true");
    }

    if (
      normalized === "--cidfile" ||
      normalized.startsWith("--cidfile=") ||
      normalized === "--name" ||
      normalized.startsWith("--name=")
    ) {
      throw new Error("--cidfile and --name are managed internally by staff-mcp");
    }
  }
}

/**
 * Run the Docker-compatible CLI and keep its lifecycle tied to this process.
 *
 * For stdio transport, the caller's stdin remains the MCP data channel. For
 * HTTP/reverse transports, child.stdin is intentionally kept open as a private
 * lifecycle pipe instead of being connected to process.stdin. This allows the
 * service to run under PM2/systemd/Supervisor even when fd 0 is /dev/null, while
 * still making the container exit if the host proxy disappears unexpectedly.
 */
export async function runDockerProxy(
  dockerArgs: readonly string[],
  transport: string,
  options: DockerProxyOptions = {}
): Promise<number> {
  const command = options.command ?? "docker";
  const commandPrefixArgs = [...(options.commandPrefixArgs ?? [])];
  const input = options.input ?? process.stdin;
  const signalSource = options.signalSource ?? process;
  const gracefulShutdownTimeoutMs =
    options.gracefulShutdownTimeoutMs ?? DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS;
  const containerIdWaitTimeoutMs = options.containerIdWaitTimeoutMs ?? DEFAULT_CONTAINER_ID_WAIT_TIMEOUT_MS;
  const containerCleanupTimeoutMs = options.containerCleanupTimeoutMs ?? DEFAULT_CONTAINER_CLEANUP_TIMEOUT_MS;
  const forceKillTimeoutMs = options.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS;

  let containerIdentity: ContainerIdentityConfig;
  try {
    containerIdentity = prepareContainerIdentity(dockerArgs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[staff-mcp] Failed to prepare Docker proxy: ${message}`);
    return 1;
  }

  return new Promise<number>((resolve) => {
    let child: ChildProcess | undefined;
    let cleanupChild: ChildProcess | undefined;
    let runExit: ChildExit | undefined;
    let trackedContainerId: string | undefined;
    let settled = false;
    let shutdownStarted = false;
    let shutdownActivated = false;
    let cleanupInProgress = false;
    let cleanupAttempted = false;
    let containerCleanupConfirmed = false;
    let cleanupFailed = false;
    let escalationPromise: Promise<void> | undefined;
    let gracefulTimer: NodeJS.Timeout | undefined;
    let postCleanupTimer: NodeJS.Timeout | undefined;
    let postCleanupFinalTimer: NodeJS.Timeout | undefined;
    let cidPollTimer: NodeJS.Timeout | undefined;

    const signalHandlers = new Map<NodeJS.Signals, () => void>();

    const captureContainerId = (): string | undefined => {
      if (!trackedContainerId) {
        trackedContainerId = readContainerId(containerIdentity.cidFilePath);
      }
      return trackedContainerId;
    };

    const isChildRunning = () =>
      child !== undefined && child.exitCode === null && child.signalCode === null;

    const removeListeners = () => {
      for (const [signal, handler] of signalHandlers) {
        signalSource.removeListener(signal, handler);
      }
      signalHandlers.clear();

      if (transport === "stdio" && child?.stdin) {
        input.unpipe(child.stdin);
        input.removeListener("end", handleInputEnd);
        input.removeListener("error", handleInputError);
      }
    };

    const finish = (exitCode: number) => {
      if (settled) {
        return;
      }
      settled = true;

      if (gracefulTimer) {
        clearTimeout(gracefulTimer);
      }
      if (postCleanupTimer) {
        clearTimeout(postCleanupTimer);
      }
      if (postCleanupFinalTimer) {
        clearTimeout(postCleanupFinalTimer);
      }
      if (cidPollTimer) {
        clearInterval(cidPollTimer);
      }

      removeListeners();

      try {
        fs.rmSync(containerIdentity.ownedDirectory, { recursive: true, force: true });
      } catch (error) {
        console.error(
          `[staff-mcp] Failed to remove temporary cidfile directory '${containerIdentity.ownedDirectory}':`,
          error
        );
      }

      resolve(exitCode);
    };

    const maybeFinish = () => {
      if (!runExit || cleanupInProgress) {
        return;
      }
      finish(cleanupFailed ? 1 : (runExit.code ?? exitCodeFromSignal(runExit.signal)));
    };

    const closeLifecyclePipe = () => {
      if (!child?.stdin) {
        return;
      }

      if (transport === "stdio") {
        input.unpipe(child.stdin);
      }

      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.end();
      }
    };

    const waitForContainerId = async (): Promise<string | undefined> => {
      const deadline = Date.now() + containerIdWaitTimeoutMs;
      let containerId = captureContainerId();
      while (!containerId && isChildRunning() && Date.now() < deadline) {
        await delay(Math.min(CONTAINER_ID_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
        containerId = captureContainerId();
      }
      return containerId;
    };

    const forceRemoveContainer = (containerId: string): Promise<boolean> =>
      new Promise<boolean>((resolveCleanup) => {
        let completed = false;
        let cleanupSpawned = false;
        let cleanupTimer: NodeJS.Timeout | undefined;
        let cleanupForceTimer: NodeJS.Timeout | undefined;
        let cleanupFinalTimer: NodeJS.Timeout | undefined;
        let stderr = "";

        const complete = (success: boolean) => {
          if (completed) {
            return;
          }
          completed = true;
          if (cleanupTimer) {
            clearTimeout(cleanupTimer);
          }
          if (cleanupForceTimer) {
            clearTimeout(cleanupForceTimer);
          }
          if (cleanupFinalTimer) {
            clearTimeout(cleanupFinalTimer);
          }
          cleanupChild = undefined;
          resolveCleanup(success);
        };

        try {
          cleanupChild = spawn(command, [...commandPrefixArgs, "rm", "-f", containerId], {
            stdio: ["ignore", "ignore", "pipe"],
          });
        } catch (error) {
          console.error(`[staff-mcp] Failed to start fallback container cleanup for ${containerId}:`, error);
          complete(false);
          return;
        }

        cleanupChild.once("spawn", () => {
          cleanupSpawned = true;
        });

        cleanupChild.stderr?.on("data", (chunk: Buffer) => {
          if (stderr.length < 8_192) {
            stderr += chunk.toString();
          }
        });

        cleanupChild.once("error", (error) => {
          console.error(`[staff-mcp] Failed to run fallback container cleanup for ${containerId}: ${error.message}`);
          if (!cleanupSpawned && cleanupChild?.pid === undefined) {
            complete(false);
          }
        });

        cleanupChild.once("close", (code, signal) => {
          if (completed) {
            return;
          }

          const detail = stderr.trim();
          if (code === 0 || isMissingContainerError(detail)) {
            console.error(`[staff-mcp] Fallback container cleanup completed for ${containerId}.`);
            complete(true);
            return;
          }

          console.error(
            `[staff-mcp] Fallback container cleanup failed for ${containerId}: code ${code ?? "null"}` +
              `${signal ? `, signal ${signal}` : ""}${detail ? `, ${detail}` : ""}`
          );
          complete(false);
        });

        cleanupTimer = setTimeout(() => {
          console.error(
            `[staff-mcp] Fallback container cleanup for ${containerId} exceeded ${containerCleanupTimeoutMs}ms; sending SIGTERM.`
          );
          cleanupChild?.kill("SIGTERM");
          cleanupForceTimer = setTimeout(() => {
            if (!completed) {
              console.error(
                `[staff-mcp] Fallback container cleanup for ${containerId} did not stop within an additional ${forceKillTimeoutMs}ms; sending SIGKILL.`
              );
              cleanupChild?.kill("SIGKILL");
              cleanupFinalTimer = setTimeout(() => {
                if (!completed) {
                  console.error(
                    `[staff-mcp] Fallback container cleanup for ${containerId} did not report completion after SIGKILL.`
                  );
                  complete(false);
                }
              }, forceKillTimeoutMs);
            }
          }, forceKillTimeoutMs);
        }, containerCleanupTimeoutMs);
      });

    const scheduleRunCliTermination = () => {
      if (!isChildRunning() || postCleanupTimer) {
        return;
      }

      child!.kill("SIGTERM");
      postCleanupTimer = setTimeout(() => {
        if (!isChildRunning()) {
          return;
        }
        console.error(
          `[staff-mcp] Docker CLI did not exit within ${forceKillTimeoutMs}ms; sending SIGKILL.`
        );
        child!.kill("SIGKILL");
        postCleanupFinalTimer = setTimeout(() => {
          if (!runExit && isChildRunning()) {
            console.error("[staff-mcp] Docker CLI did not report completion after SIGKILL.");
            cleanupFailed = true;
            runExit = { code: 1, signal: null };
            maybeFinish();
          }
        }, forceKillTimeoutMs);
      }, forceKillTimeoutMs);
    };

    const escalateShutdown = (): Promise<void> => {
      if (escalationPromise) {
        return escalationPromise;
      }

      escalationPromise = (async () => {
        if (gracefulTimer) {
          clearTimeout(gracefulTimer);
          gracefulTimer = undefined;
        }

        if (!isChildRunning()) {
          return;
        }

        if (containerCleanupConfirmed || cleanupAttempted) {
          scheduleRunCliTermination();
          return;
        }

        const containerId = await waitForContainerId();
        if (!isChildRunning()) {
          return;
        }

        if (!containerId) {
          // Do not treat "no such container" as successful cleanup while the
          // Docker CLI may still be pulling an image or creating the container.
          // Stop the CLI first; its close handler will then remove the unique
          // generated name after no further create request can be issued.
          console.error(
            `[staff-mcp] Docker cidfile was unavailable; terminating the CLI before cleaning up '${containerIdentity.containerName}'.`
          );
          scheduleRunCliTermination();
          return;
        }

        cleanupInProgress = true;
        cleanupAttempted = true;
        const removed = await forceRemoveContainer(containerId);
        cleanupInProgress = false;

        if (removed) {
          containerCleanupConfirmed = true;
          cleanupFailed = false;
          // Once the exact tracked container has been removed, it is safe to
          // terminate a stuck CLI.
        } else {
          cleanupFailed = true;
          console.error(
            `[staff-mcp] Container ${containerId} could not be confirmed removed; terminating the stuck Docker CLI with an error status.`
          );
        }

        scheduleRunCliTermination();
        maybeFinish();
      })().finally(() => {
        escalationPromise = undefined;
      });

      return escalationPromise;
    };

    const activateShutdown = () => {
      if (!shutdownStarted || shutdownActivated || !child) {
        return;
      }
      shutdownActivated = true;
      closeLifecyclePipe();

      gracefulTimer = setTimeout(() => {
        if (!isChildRunning()) {
          return;
        }
        console.error(
          `[staff-mcp] Docker proxy did not exit within ${gracefulShutdownTimeoutMs}ms; removing its tracked container.`
        );
        void escalateShutdown();
      }, gracefulShutdownTimeoutMs);
    };

    const requestShutdown = (reason: string, repeatedSignal = false) => {
      if (settled) {
        return;
      }

      if (!shutdownStarted) {
        shutdownStarted = true;
        console.error(`[staff-mcp] Docker proxy shutdown requested: ${reason}`);
        activateShutdown();
        return;
      }

      if (repeatedSignal) {
        console.error(`[staff-mcp] Repeated shutdown signal received: ${reason}`);
        void escalateShutdown();
      }
    };

    function handleInputEnd() {
      requestShutdown("stdio input closed");
    }

    function handleInputError(error: Error) {
      console.error(`[staff-mcp] Docker proxy input error: ${error.message}`);
      requestShutdown("stdio input error");
    }

    for (const signal of HANDLED_SIGNALS) {
      const handler = () => requestShutdown(`received ${signal}`, true);
      signalHandlers.set(signal, handler);
      signalSource.on(signal, handler);
    }

    try {
      child = spawn(command, [...commandPrefixArgs, ...containerIdentity.args], {
        stdio: ["pipe", "inherit", "inherit"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[staff-mcp] Failed to start docker proxy: ${message}`);
      finish(1);
      return;
    }

    if (!child.stdin) {
      console.error("[staff-mcp] Failed to start docker proxy: child stdin is unavailable.");
      child.kill("SIGKILL");
      finish(1);
      return;
    }

    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (!settled && error.code !== "EPIPE") {
        console.error(`[staff-mcp] Docker proxy stdin error: ${error.message}`);
      }
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }

      if (child?.pid === undefined) {
        console.error(`[staff-mcp] Failed to start docker proxy: ${error.message}`);
        finish(1);
        return;
      }

      console.error(`[staff-mcp] Docker proxy process error: ${error.message}`);
      cleanupFailed = true;
      requestShutdown("Docker proxy process error", true);
    });

    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }

      captureContainerId();
      runExit = { code, signal };
      if (gracefulTimer) {
        clearTimeout(gracefulTimer);
      }
      if (postCleanupTimer) {
        clearTimeout(postCleanupTimer);
      }
      if (postCleanupFinalTimer) {
        clearTimeout(postCleanupFinalTimer);
      }

      console.error(
        `[staff-mcp] Docker proxy exited with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}.`
      );

      // If a supervisor killed the Docker CLI directly, --rm may not have
      // completed. Clean up by exact ID when available, otherwise use the
      // unique generated name that was part of the container-create request.
      if (
        !cleanupInProgress &&
        !cleanupAttempted &&
        !containerCleanupConfirmed &&
        (signal !== null || code !== 0)
      ) {
        const cleanupReference = trackedContainerId ?? containerIdentity.containerName;
        cleanupInProgress = true;
        cleanupAttempted = true;
        void forceRemoveContainer(cleanupReference)
          .then((removed) => {
            containerCleanupConfirmed = removed;
            cleanupFailed = !removed;
          })
          .finally(() => {
            cleanupInProgress = false;
            maybeFinish();
          });
        return;
      }

      maybeFinish();
    });

    cidPollTimer = setInterval(captureContainerId, CONTAINER_ID_POLL_INTERVAL_MS);
    cidPollTimer.unref();

    if (transport === "stdio") {
      input.once("end", handleInputEnd);
      input.once("error", handleInputError);
      input.pipe(child.stdin);
    }

    // A signal source can synchronously request shutdown while handlers are
    // being installed (and a real OS signal can arrive during startup).
    activateShutdown();
  });
}
