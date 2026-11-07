import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
    TERMINAL,
    extensionError,
    operationId,
    parse,
} from '../extensions/protocol.js';
import type { TerminalSession } from './session.js';

/** Business adapter: the stream host never needs terminal dimensions or PTY state. */
export function registerTerminal(
    server: McpServer,
    current: (ctx: ServerContext, method: string) => TerminalSession | undefined,
) {
    const size = z.number().int().min(2).max(1000);
    const resourceId = z.string().min(1).max(256);
    const params = {
        create: z
            .object({
                operationId,
                params: z
                    .object({
                        rootId: z.string().min(1).default('main'),
                        cols: size,
                        rows: size,
                    })
                    .strict(),
            })
            .strict(),
        status: z.object({ operationId }).strict(),
        resize: z
            .object({
                resourceId,
                params: z.object({ cols: size, rows: size }).strict(),
            })
            .strict(),
        renew: z.object({ operationId, resourceId }).strict(),
        close: z
            .object({
                operationId,
                reason: z.literal('user'),
            })
            .strict(),
    };
    for (const method of Object.keys(params) as (keyof typeof params)[]) {
        server.server.setRequestHandler(
            `${TERMINAL}/v1/${method}`,
            { params: z.unknown().optional() },
            async (input, ctx) => {
                if (ctx.mcpReq.signal.aborted)
                    extensionError(
                        'STALE_CONNECTION',
                        'Terminal request connection closed',
                    );
                const terminal = current(ctx, method);
                if (!terminal)
                    extensionError(
                        'TERMINAL_DISABLED',
                        'Terminal requires explicit enablement and a data session',
                    );
                switch (method) {
                    case 'create': {
                        const p = parse(params.create, input);
                        const result = await terminal.create({
                            operationId: p.operationId,
                            ...p.params,
                        });
                        if (result.state !== 'running' || !result.terminalId)
                            extensionError(
                                'INVALID_STATE',
                                'Terminal creation did not produce a running resource',
                            );
                        return {
                            resourceId: result.terminalId,
                            leaseMs: result.leaseMs,
                            metadata: {
                                rootId: result.rootId,
                                path: result.path,
                                shell: result.shell,
                            },
                        };
                    }
                    case 'status': {
                        const result = terminal.status(
                            parse(params.status, input).operationId,
                        );
                        // Unknown/failed are not successful closed operations. Closing
                        // remains active until the PTY actually reports completion.
                        if (result.state === 'unknown')
                            extensionError(
                                'RESOURCE_NOT_FOUND',
                                'Unknown terminal operation',
                            );
                        if (result.state === 'failed')
                            extensionError(
                                'TERMINAL_START_FAILED',
                                'Terminal could not be started',
                            );
                        if (result.state !== 'closed')
                            return { state: 'active' };
                        // view() always includes exit for a closed terminal; its
                        // inferred spread return type does not narrow by state.
                        const closed = result as typeof result & {
                            exit: { code: number | null };
                            error?: { code: string; message: string };
                        };
                        return {
                            state: 'closed',
                            metadata: { exitCode: closed.exit.code },
                            ...(closed.error ? { error: closed.error } : {}),
                        };
                    }
                    case 'resize': {
                        const p = parse(params.resize, input);
                        const result = terminal.resize(
                            p.resourceId,
                            p.params.cols,
                            p.params.rows,
                        );
                        return { cols: result.cols, rows: result.rows };
                    }
                    case 'renew': {
                        const p = parse(params.renew, input);
                        const status = terminal.status(p.operationId);
                        if (
                            !('terminalId' in status) ||
                            status.terminalId !== p.resourceId
                        )
                            extensionError(
                                'RESOURCE_NOT_FOUND',
                                'Terminal operation/resource mismatch',
                            );
                        const result = terminal.renew(p.resourceId);
                        return {
                            resourceId: result.terminalId,
                            leaseMs: result.leaseMs,
                        };
                    }
                    case 'close': {
                        const p = parse(params.close, input);
                        return terminal.closeOperation(p.operationId, p.reason);
                    }
                }
            },
        );
    }
}
