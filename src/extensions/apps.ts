import * as fs from 'node:fs/promises';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
    APPS,
    DATA,
    FILES,
    TERMINAL,
    STREAMS,
    parse,
    extensionError,
} from './protocol.js';

export const FILE_UI_URI = 'ui://staff-file-manager/v1/index.html';
export const TERMINAL_UI_URI = 'ui://staff-mcp/terminal';
export const FILE_MANAGER = 'cc.qqxing/file-manager';

const files = {
    id: 'files',
    scope: 'workspace',
    title: '文件管理器',
    icon: 'folder',
    resourceUri: FILE_UI_URI,
    mimeType: 'text/html',
    bridgeVersion: 1,
    requiredExtensions: { [FILES]: 1, [DATA]: 1 },
    methods: [
        'roots',
        'list',
        'stat',
        'readText',
        'saveText',
        'createFile',
        'mkdir',
        'move',
        'delete',
    ].map((method) => `${FILE_MANAGER}/${method}`),
    capabilities: {
        files: { version: 1, upload: true, download: true },
    },
};
const terminal = {
    id: 'terminal',
    title: '终端',
    icon: 'terminal',
    resourceUri: TERMINAL_UI_URI,
    mimeType: 'text/html',
    bridgeVersion: 1,
    scope: 'chat',
    methods: [],
    requiredExtensions: { [STREAMS]: 1, [DATA]: 1 },
    capabilities: {
        streams: {
            version: 1,
            purpose: TERMINAL,
            create: `${TERMINAL}/v1/create`,
            renew: `${TERMINAL}/v1/renew`,
            status: `${TERMINAL}/v1/status`,
            close: `${TERMINAL}/v1/close`,
            commands: { resize: `${TERMINAL}/v1/resize` },
        },
    },
};

export function registerApps(
    server: McpServer,
    requireExtension: (extension: string, ctx: ServerContext) => void,
    terminalAvailable: () => boolean,
    negotiated: (extension: string, ctx: ServerContext) => boolean,
    dataVersion = 1,
) {
    server.server.setRequestHandler(
        `${APPS}/v1/list`,
        { params: z.unknown().optional() },
        async (input, ctx) => {
            if (ctx.mcpReq.signal.aborted)
                extensionError(
                    'STALE_CONNECTION',
                    'Apps request connection closed',
                );
            parse(z.object({}).strict(), input);
            requireExtension(APPS, ctx);
            return {
                apps: [
                    ...(negotiated(FILES, ctx)
                        ? [
                              {
                                  ...files,
                                  requiredExtensions: {
                                      [FILES]: 1,
                                      [DATA]: dataVersion,
                                  },
                              },
                          ]
                        : []),
                    ...(terminalAvailable() && negotiated(STREAMS, ctx)
                        ? [
                              {
                                  ...terminal,
                                  requiredExtensions: {
                                      [STREAMS]: 1,
                                      [DATA]: dataVersion,
                                  },
                              },
                          ]
                        : []),
                ],
            };
        },
    );
}

export async function readAppResource(
    uri: string,
    requireExtension: (extension: string, ctx: ServerContext) => void,
    terminalAvailable: boolean,
    ctx: ServerContext,
) {
    if (uri !== FILE_UI_URI && uri !== TERMINAL_UI_URI) return undefined;
    requireExtension(APPS, ctx);
    const terminal = uri === TERMINAL_UI_URI;
    requireExtension(terminal ? STREAMS : FILES, ctx);
    if (terminal && !terminalAvailable) return undefined;
    const text = await fs.readFile(
        new URL(
            terminal
                ? '../terminal/ui/index.html'
                : '../file-manager/ui/index.html',
            import.meta.url,
        ),
        'utf8',
    );
    return { contents: [{ uri, mimeType: 'text/html', text }] };
}
