import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ExtensionTransport } from '../transport-v1/ExtensionTransport.js';
import { FileCore } from '../file-manager/file-core.js';
import { registerFileManager } from '../file-manager/extension.js';
import { TerminalSession } from '../terminal/session.js';
import { registerTerminal } from '../terminal/extension.js';
import type { TerminalRuntime } from '../terminal/pty.js';
import { FILES, TERMINAL, manifest, extensionError } from './protocol.js';
import { registerApps } from './apps.js';

/** Attach business lifecycle only. The official SDK receives the original transport unchanged. */
export function installExtensions(
    server: McpServer,
    core: FileCore,
    transferDirectory: string,
    discovery: ReturnType<typeof manifest>,
    terminalRuntime?: TerminalRuntime,
) {
    let fileSession:
        | ReturnType<ReturnType<typeof registerFileManager>>
        | undefined;
    let terminalSession: TerminalSession | undefined;
    const requireExtension = (extension: string) => {
        if (!fileSession)
            extensionError('STALE_CONNECTION', 'No active extension session');
        fileSession.requireExtension(extension);
    };
    const createFileSession = registerFileManager(
        server,
        core,
        transferDirectory,
        () => !!terminalSession,
    );
    registerApps(
        server,
        requireExtension,
        () => !!terminalSession,
        (extension) => fileSession?.supports(extension) ?? false,
    );
    registerTerminal(server, () => {
        requireExtension(TERMINAL);
        return terminalSession;
    });
    const connect = server.connect.bind(server);
    server.connect = async (transport: Transport) => {
        const wire =
            transport instanceof ExtensionTransport ? transport : undefined;
        const files = createFileSession(!!wire);
        fileSession = files;
        const terminal =
            terminalRuntime && wire
                ? new TerminalSession(core, terminalRuntime, () =>
                      files.requireExtension(TERMINAL),
                  )
                : undefined;
        terminalSession = terminal;
        Object.assign(discovery, manifest(!!terminal));
        if (wire)
            wire.onChannel = async (open, channel) => {
                if (open.purpose === FILES) {
                    files.requireExtension(FILES);
                    return files.transfers.acceptChannel(
                        { ...open, purpose: FILES },
                        channel,
                    );
                }
                if (open.purpose === TERMINAL && terminal) {
                    files.requireExtension(TERMINAL);
                    return terminal.acceptChannel(
                        { ...open, purpose: TERMINAL },
                        channel,
                    );
                }
                return extensionError(
                    'CAPABILITY_UNAVAILABLE',
                    'Unsupported data channel purpose',
                );
            };
        let closed = false;
        const cleanup = () => {
            if (closed) return;
            closed = true;
            terminal?.close();
            void files
                .close()
                .catch(() =>
                    console.error(
                        '[staff-mcp] Extension staging cleanup failed.',
                    ),
                );
        };
        const previousClose = transport.onclose;
        transport.onclose = () => {
            cleanup();
            previousClose?.();
        };
        try {
            await connect(transport);
        } catch (error) {
            cleanup();
            await transport.close().catch(() => {});
            // Transports may reject start without notifying the SDK.
            if (server.server.transport === transport) transport.onclose?.();
            throw error;
        }
        if (server.server.transport !== transport) cleanup();
    };
}
