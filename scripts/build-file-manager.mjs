import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

const result = await build({
    entryPoints: ['src/file-manager/ui/main.tsx'],
    outfile: 'file-manager.js',
    bundle: true,
    write: false,
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
});
const js = result.outputFiles.find((file) => file.path.endsWith('.js')).text;
const css =
    result.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '';
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"><title>文件</title><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head><body><div id="root"></div><script>${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
await mkdir('dist/src/file-manager/ui', { recursive: true });
await writeFile('dist/src/file-manager/ui/index.html', html);
console.log('Built self-contained MCP file-manager HTML resource.');
