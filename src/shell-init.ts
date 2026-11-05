import {
    accessSync,
    constants,
    mkdtempSync,
    rmdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/** Deployment-only configuration, never a tool parameter or parsed environment file. */
export function shellInitPath(): string | undefined {
    const script = process.env.STAFF_MCP_SHELL_INIT;
    if (!script) return undefined;
    if (process.platform !== 'linux')
        throw new Error('STAFF_MCP_SHELL_INIT requires Linux /bin/bash');
    try {
        if (!path.isAbsolute(script) || script.includes('\0'))
            throw new Error();
        accessSync(script, constants.R_OK);
        if (!statSync(script).isFile()) throw new Error();
    } catch {
        throw new Error(
            'STAFF_MCP_SHELL_INIT must be an absolute readable script file',
        );
    }
    try {
        accessSync('/bin/bash', constants.X_OK);
        if (!statSync('/bin/bash').isFile()) throw new Error();
    } catch {
        throw new Error('STAFF_MCP_SHELL_INIT requires executable /bin/bash');
    }
    return script;
}

// Keep startup stdout off MCP stdout. Suppress Bash source diagnostics, which can
// quote script lines containing secrets; report only a fixed failure message.
// Source at top level so declarations survive, while restoring wrapper arguments
// after script `set --`. Keep source standalone so user-enabled errexit works.
const source = `__staff_mcp_init_argv=("$@")
builtin source "$1" -- 1>&2 2>/dev/null
__staff_mcp_init_status=$?
set -- "\${__staff_mcp_init_argv[@]}"
unset __staff_mcp_init_argv
if [ "$__staff_mcp_init_status" -ne 0 ]; then
    builtin printf "%s\\n" "[staff-mcp] Shell initialization failed" >&2
    exit "$__staff_mcp_init_status"
fi
unset __staff_mcp_init_status
export STAFF_MCP_SHELL_INIT="$1"`;
export const SHELL_INIT_COMMAND = `${source}\nbuiltin eval "$2"`;
const rcfileContent = `set -- "$STAFF_MCP_SHELL_INIT"\n${source}\nset --\n`;

/** One owned, private bootstrap per PTY; never copy the user's script contents. */
export function createShellInitRcfile(): { path: string; cleanup(): void } {
    const directory = mkdtempSync(path.join(tmpdir(), 'staff-mcp-shell-init-'));
    const rcfile = path.join(directory, 'init.bash');
    const cleanup = () => {
        try {
            unlinkSync(rcfile);
        } catch {
            /* best effort, exact owned file only */
        }
        try {
            rmdirSync(directory);
        } catch {
            /* never recursively remove */
        }
    };
    try {
        writeFileSync(rcfile, rcfileContent, { flag: 'wx', mode: 0o600 });
    } catch {
        cleanup();
        throw new Error('Unable to create shell initialization bootstrap');
    }
    return { path: rcfile, cleanup };
}
