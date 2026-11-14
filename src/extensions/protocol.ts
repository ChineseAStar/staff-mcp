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

function readClientExtensions(server: McpServer, ctx: ServerContext) {
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
    // Modern envelopes require the modern container. Legacy initialize may use
    // experimental only when its authoritative extensions container is absent.
    const manifest =
        isModernRequest(ctx) || capabilities?.extensions !== undefined
            ? capabilities?.extensions?.[EXTENSIONS]
            : capabilities?.experimental?.[EXTENSIONS];
    const parsed = z
        .object({
            version: z.literal(1),
            extensions: z.record(
                z.string(),
                z.object({
                    versions: z.array(z.number().int()),
                    reuse: z.unknown().optional(),
                }),
            ),
        })
        .safeParse(manifest);
    return parsed.success ? parsed.data.extensions : undefined;
}

export function supports(
    server: McpServer,
    extension: string,
    ctx: ServerContext,
    version = 1,
): boolean {
    if (![APPS, DATA, FILES, STREAMS].includes(extension)) return false;
    return (
        readClientExtensions(server, ctx)?.[extension]?.versions.includes(
            version,
        ) === true
    );
}

export function supportsStreamReuse(
    server: McpServer,
    ctx: ServerContext,
): boolean {
    const streams = readClientExtensions(server, ctx)?.[STREAMS];
    return streams?.versions.includes(1) === true && streams.reuse === true;
}

export function manifest(
    features: { files: boolean; terminal: boolean },
    dataVersion = 1,
) {
    return {
        version: 1,
        extensions: {
            ...(features.files || features.terminal
                ? {
                      [APPS]: { versions: [1] },
                      [DATA]: { versions: [dataVersion] },
                  }
                : {}),
            ...(features.files ? { [FILES]: { versions: [1] } } : {}),
            ...(features.terminal ? { [STREAMS]: { versions: [1] } } : {}),
        },
    };
}
