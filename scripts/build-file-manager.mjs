import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
    options: {
        app: { type: 'string' },
        outdir: { type: 'string', default: 'dist/src' },
    },
});
if (values.app && !['file-manager', 'terminal'].includes(values.app)) {
    throw new Error('Unknown UI app; expected file-manager or terminal.');
}

for (const app of values.app ? [values.app] : ['file-manager', 'terminal']) {
    const result = await build({
        entryPoints: [`src/${app}/ui/main.tsx`],
        outfile: `${app}.js`,
        bundle: true,
        write: false,
        platform: 'browser',
        target: 'es2022',
        jsx: 'automatic',
        minify: true,
        legalComments: 'inline',
    });
    const js = result.outputFiles.find((file) =>
        file.path.endsWith('.js'),
    ).text;
    const css =
        result.outputFiles.find((file) => file.path.endsWith('.css'))?.text ??
        '';
    let licenses = '';
    if (app === 'terminal') {
        // xterm's complete MIT notices must survive minification and travel
        // inside the single HTML Resource, not just in the npm dependency tree.
        for (const dependency of ['@xterm/xterm', '@xterm/addon-fit']) {
            licenses += `${dependency}\n${await readFile(join('node_modules', dependency, 'LICENSE'), 'utf8')}\n`;
        }
    }
    const licenseTag = licenses
        ? `<script type="text/plain" id="terminal-licenses">${licenses.replace(/<\/script/gi, '<\\/script')}</script>`
        : '';
    const title = app === 'terminal' ? '终端' : '文件';
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"><title>${title}</title><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head><body><div id="root"></div><script>${js.replace(/<\/script/gi, '<\\/script')}</script>${licenseTag}</body></html>`;
    if (
        app === 'terminal' &&
        Buffer.byteLength(html, 'utf8') > 4 * 1024 * 1024
    ) {
        throw new Error('Terminal HTML exceeds the 4 MiB Resource limit.');
    }
    const directory = join(values.outdir, app, 'ui');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'index.html'), html);
    console.log(
        `Built self-contained MCP ${app} HTML resource (${Buffer.byteLength(html, 'utf8')} bytes).`,
    );
}
