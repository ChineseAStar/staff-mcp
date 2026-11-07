import { ClientCapabilitiesSchema } from '@modelcontextprotocol/core';
import {
    CLIENT_CAPABILITIES_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    ProtocolError,
} from '@modelcontextprotocol/server';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const EXTENSIONS = 'cc.qqxing/extensions';
export const APPS = 'cc.qqxing/apps';
export const DATA = 'cc.qqxing/data';
export const FILES = 'cc.qqxing/files';
export const STREAMS = 'cc.qqxing/streams';
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
        throw new ProtocolError(-32602, 'Invalid extension parameters', {
            code: 'INVALID_PARAMS',
        });
    return result.data;
}

export function extensionError(code: string, message: string): never {
    throw new ProtocolError(-32000, message, { code });
}

/** Modern identity is request-scoped; never fall back to another request's grants. */
export function isModernRequest(ctx: ServerContext): boolean {
    // SDK 2.4's RequestMetaEnvelope alias is {}, despite these runtime keys.
    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
    const version = envelope?.[PROTOCOL_VERSION_META_KEY];
    return typeof version === 'string' && version >= '2026-07-28';
}

export function supports(
    server: McpServer,
    extension: string,
    ctx: ServerContext,
): boolean {
    if (![APPS, DATA, FILES, STREAMS].includes(extension)) return false;
    // SDK 2.4 exposes the modern capability view through the envelope (not ctx.mcp).
    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
    const parsedCapabilities = ClientCapabilitiesSchema.safeParse(
        isModernRequest(ctx)
            ? envelope?.[CLIENT_CAPABILITIES_META_KEY]
            : server.server.getClientCapabilities(),
    );
    const capabilities = parsedCapabilities.success
        ? parsedCapabilities.data
        : undefined;
    // The modern container is authoritative, even when empty or missing our
    // entry. Only an absent container permits the legacy advertisement.
    const manifest = capabilities?.extensions !== undefined
        ? capabilities.extensions[EXTENSIONS]
        : capabilities?.experimental?.[EXTENSIONS];
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

export function manifest(features: { files: boolean; terminal: boolean }) {
    return {
        version: 1,
        extensions: {
            ...(features.files || features.terminal
                ? { [APPS]: { versions: [1] }, [DATA]: { versions: [1] } }
                : {}),
            ...(features.files ? { [FILES]: { versions: [1] } } : {}),
            ...(features.terminal ? { [STREAMS]: { versions: [1] } } : {}),
        },
    };
}
