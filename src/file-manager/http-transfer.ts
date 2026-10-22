import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fileError } from './file-core.js';

export interface HttpTicket {
    path: string;
    token: string;
    remove(): void;
}
type Handler = (
    request: IncomingMessage,
    response: ServerResponse,
) => Promise<void>;

/** One router per HTTP listener. Entries belong to a live prepared session handle. */
export class HttpTransferRouter {
    private readonly tickets = new Map<
        string,
        { token: Buffer; handler: Handler }
    >();

    register(handler: Handler): HttpTicket {
        const id = randomBytes(24).toString('hex');
        const token = randomBytes(32).toString('hex');
        this.tickets.set(id, { token: Buffer.from(token), handler });
        return {
            path: `/mcp/transfers/${id}`,
            token,
            remove: () => {
                this.tickets.delete(id);
            },
        };
    }

    async handle(request: IncomingMessage, response: ServerResponse) {
        const match = /^\/mcp\/transfers\/([a-f0-9]{48})$/.exec(
            request.url ?? '',
        );
        const entry = match && this.tickets.get(match[1]);
        const authorization = /^Bearer (\S+)$/i.exec(
            request.headers.authorization ?? '',
        );
        const token = Buffer.from(authorization?.[1] ?? '');
        if (
            !entry ||
            token.length !== entry.token.length ||
            !timingSafeEqual(token, entry.token)
        ) {
            response.writeHead(401, {
                'WWW-Authenticate': 'Bearer realm="staff-transfer"',
            });
            response.end();
            return;
        }
        response.setHeader('Cache-Control', 'no-store');
        try {
            await entry.handler(request, response);
        } catch (error) {
            if (response.headersSent || response.destroyed) {
                response.destroy();
                return;
            }
            const failure = fileError(error);
            response.writeHead(400, { 'Content-Type': 'application/json' });
            response.end(
                JSON.stringify({
                    error: failure.code,
                    message: failure.message,
                }),
            );
        }
    }
}

// A narrow, server-owned binding: stdio and reverse factories remain unchanged.
const httpServers = new WeakMap<McpServer, HttpTransferRouter>();
export function enableHttpTransfers(
    server: McpServer,
    router: HttpTransferRouter,
) {
    httpServers.set(server, router);
}
export function takeHttpTransfers(server: McpServer) {
    const router = httpServers.get(server);
    httpServers.delete(server);
    return router;
}
