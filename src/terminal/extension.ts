import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
    TERMINAL,
    extensionError,
    operationId,
    parse,
} from '../extensions/protocol.js';
import type { TerminalSession } from './session.js';

export function registerTerminal(
    server: McpServer,
    current: () => TerminalSession | undefined,
) {
    const size = z.number().int().min(2).max(1000);
    const params = {
        create: z
            .object({
                operationId,
                rootId: z.string().min(1).default('main'),
                cols: size,
                rows: size,
            })
            .strict(),
        status: z.object({ operationId }).strict(),
        resize: z
            .object({ terminalId: z.string().min(1), cols: size, rows: size })
            .strict(),
        renew: z.object({ terminalId: z.string().min(1) }).strict(),
        close: z
            .object({
                operationId,
                reason: z.enum(['user', 'page-exit']).default('user'),
            })
            .strict(),
    };
    for (const method of Object.keys(params) as (keyof typeof params)[]) {
        server.server.setRequestHandler(
            z.object({
                method: z.literal(`${TERMINAL}/v1/${method}`),
                params: z.unknown().optional(),
            }),
            async (request, extra) => {
                if (extra.signal.aborted)
                    extensionError(
                        'STALE_CONNECTION',
                        'Terminal request connection closed',
                    );
                const terminal = current();
                if (!terminal)
                    extensionError(
                        'TERMINAL_DISABLED',
                        'Terminal requires explicit enablement and a binary transport',
                    );
                switch (method) {
                    case 'create':
                        return terminal.create(
                            parse(params.create, request.params),
                        );
                    case 'status':
                        return terminal.status(
                            parse(params.status, request.params).operationId,
                        );
                    case 'resize': {
                        const p = parse(params.resize, request.params);
                        return terminal.resize(p.terminalId, p.cols, p.rows);
                    }
                    case 'renew':
                        return terminal.renew(
                            parse(params.renew, request.params).terminalId,
                        );
                    case 'close': {
                        const p = parse(params.close, request.params);
                        return terminal.closeOperation(p.operationId, p.reason);
                    }
                }
            },
        );
    }
}
