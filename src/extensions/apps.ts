import * as fs from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
    APPS,
    DATA,
    FILES,
    TERMINAL,
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
    bridgeVersion: 2,
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
    transfers: {
        upload: {
            prepare: `${FILES}/v1/prepare`,
            commit: `${FILES}/v1/commit`,
            release: `${FILES}/v1/release`,
        },
        download: {
            prepare: `${FILES}/v1/prepare`,
            release: `${FILES}/v1/release`,
        },
    },
};
const terminal = {
    id: 'terminal',
    title: '终端',
    icon: 'terminal',
    resourceUri: TERMINAL_UI_URI,
    mimeType: 'text/html',
    bridgeVersion: 2,
    scope: 'chat',
    terminal: true,
    methods: [],
    requiredExtensions: { [TERMINAL]: 1, [DATA]: 1 },
};

export function registerApps(
    server: McpServer,
    requireExtension: (extension: string) => void,
    terminalAvailable: () => boolean,
    negotiated: (extension: string) => boolean,
) {
    server.server.setRequestHandler(
        z.object({
            method: z.literal(`${APPS}/v1/list`),
            params: z.unknown().optional(),
        }),
        async (request, extra) => {
            if (extra.signal.aborted)
                extensionError(
                    'STALE_CONNECTION',
                    'Apps request connection closed',
                );
            parse(z.object({}).strict(), request.params);
            requireExtension(APPS);
            return {
                apps: [
                    ...(negotiated(FILES) ? [files] : []),
                    ...(terminalAvailable() && negotiated(TERMINAL)
                        ? [terminal]
                        : []),
                ],
            };
        },
    );
}

export async function readAppResource(
    uri: string,
    requireExtension: (extension: string) => void,
    terminalAvailable: boolean,
) {
    if (uri !== FILE_UI_URI && uri !== TERMINAL_UI_URI) return undefined;
    requireExtension(APPS);
    const terminal = uri === TERMINAL_UI_URI;
    requireExtension(terminal ? TERMINAL : FILES);
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
