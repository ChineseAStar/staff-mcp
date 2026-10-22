import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const EXTENSIONS = 'cc.qqxing/extensions';
export const APPS = 'cc.qqxing/apps';
export const FILES = 'cc.qqxing/files';
export const TERMINAL = 'cc.qqxing/terminal';
export const LEASE_MS = 30_000;
export const RECORD_TTL_MS = 300_000;
export const MAX_RECORDS = 128;
export const operationId = z.string().min(1).max(200);

export function parse<T extends z.ZodType>(
    schema: T,
    input: unknown,
): z.infer<T> {
    const result = schema.safeParse(input ?? {});
    if (!result.success)
        throw new McpError(-32602, 'Invalid extension parameters', {
            code: 'INVALID_PARAMS',
        });
    return result.data;
}

export function extensionError(code: string, message: string): never {
    throw new McpError(-32000, message, { code });
}

export function supports(server: McpServer, extension: string): boolean {
    const manifest =
        server.server.getClientCapabilities()?.experimental?.[EXTENSIONS];
    const parsed = z
        .object({
            version: z.literal(1),
            extensions: z.record(
                z.string(),
                z.object({ versions: z.array(z.number().int()) }),
            ),
        })
        .safeParse(manifest);
    return (
        parsed.success &&
        parsed.data.extensions[extension]?.versions.includes(1) === true
    );
}

export function manifest(terminal: boolean) {
    return {
        version: 1,
        extensions: {
            [APPS]: { versions: [1] },
            [FILES]: { versions: [1] },
            ...(terminal ? { [TERMINAL]: { versions: [1] } } : {}),
        },
    };
}
