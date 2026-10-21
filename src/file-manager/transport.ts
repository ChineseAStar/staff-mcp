import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { FteServer, type FteServerConfig } from 'mcp-fte';
import type { FileManagerSession } from './extension.js';
import { FTE_PREFIX } from './transfers.js';
import { fileError } from './file-core.js';

/** Private handles go to SDK extension handlers; legacy file:// FTE stays with mcp-fte. */
export function isPrivateTransfer(message: JSONRPCMessage): boolean {
    if (!('method' in message) || !message.method.startsWith(FTE_PREFIX))
        return false;
    const params = message.params as Record<string, unknown> | undefined;
    if (!params) return false;
    const method = message.method.slice(FTE_PREFIX.length);
    if (method === 'read/init' || method === 'write/init')
        return (
            typeof params.uri === 'string' &&
            params.uri.startsWith('staff-transfer:')
        );
    return (
        typeof params.transfer_id === 'string' &&
        params.transfer_id.startsWith('staff-transfer-')
    );
}

export function wrapFileManagerTransport(
    transport: Transport,
    config: FteServerConfig,
    session: FileManagerSession,
): Transport {
    let upstream: Transport['onmessage'];
    const bridge: Transport = {
        start: () => transport.start(),
        close: () => transport.close(),
        send: (message, options) => transport.send(message, options),
        get sessionId() {
            return transport.sessionId;
        },
        setProtocolVersion: (version) =>
            transport.setProtocolVersion?.(version),
        get onclose() {
            return transport.onclose;
        },
        set onclose(callback) {
            transport.onclose = callback;
        },
        get onerror() {
            return transport.onerror;
        },
        set onerror(callback) {
            transport.onerror = callback;
        },
        get onmessage() {
            return transport.onmessage;
        },
        set onmessage(legacyHandler) {
            transport.onmessage = (message, extra) => {
                if (isPrivateTransfer(message)) {
                    upstream?.(message, extra);
                    return;
                }
                if (!('method' in message && 'id' in message)) {
                    legacyHandler?.(message, extra);
                    return;
                }
                const fileInit =
                    [
                        FTE_PREFIX + 'read/init',
                        FTE_PREFIX + 'write/init',
                    ].includes(message.method) &&
                    typeof message.params?.uri === 'string' &&
                    /^file:/i.test(message.params.uri);
                const legacyWrite = [
                    'write/init',
                    'write/chunk',
                    'write/close',
                    'abort',
                ].some((method) => message.method === FTE_PREFIX + method);
                if (!fileInit && !legacyWrite) {
                    legacyHandler?.(message, extra);
                    return;
                }
                const dispatch = async () => {
                    if (session.closed) return;
                    if (fileInit)
                        await session.validateLegacyUri(
                            message.params!.uri as string,
                        );
                    if (!session.closed) legacyHandler?.(message, extra);
                };
                // mcp-fte 1.0.2 mutates files synchronously in dispatch(), before handle()
                // yields. The lock covers that callback, not response delivery or the whole
                // transfer. Revisit this boundary if the dependency makes dispatch async.
                const pending = legacyWrite
                    ? session.dispatchLegacyWrite(dispatch)
                    : dispatch();
                void pending.catch((error) => {
                    const failure = fileError(error);
                    void transport
                        .send(
                            {
                                jsonrpc: '2.0',
                                id: message.id,
                                error: {
                                    code: -32001,
                                    message: failure.message,
                                    data: { code: failure.code },
                                },
                            },
                            { relatedRequestId: message.id },
                        )
                        .catch(() => {});
                });
            };
        },
    };
    const legacy = FteServer.wrapTransport(bridge, config);
    return {
        start: () => legacy.start(),
        send: (message, options) => legacy.send(message, options),
        close: async () => {
            const cleanup = session.close();
            try {
                await legacy.close();
            } finally {
                await cleanup;
            }
        },
        get sessionId() {
            return transport.sessionId;
        },
        setProtocolVersion: (version) =>
            transport.setProtocolVersion?.(version),
        get onclose() {
            return legacy.onclose;
        },
        set onclose(callback) {
            legacy.onclose = callback;
        },
        get onerror() {
            return legacy.onerror;
        },
        set onerror(callback) {
            legacy.onerror = callback;
        },
        get onmessage() {
            return upstream;
        },
        set onmessage(callback) {
            upstream = callback;
            legacy.onmessage = callback;
        },
    };
}
