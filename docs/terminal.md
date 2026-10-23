# Terminal app UI

This document describes the source contract on the unmerged, unpublished `feat/mcp-file-manager` branch, not a production deployment or full acceptance report. The authoritative custom protocol is `chat-ai/docs/protocol/terminal.md` in the matching checkout.

`terminal` is an independent, human-operated app. Enable it explicitly with `--terminal`, Linux/loadable optional `node-pty`, an administrator-selected executable shell, negotiated terminal/data v1 and a usable duplex dataSession. Local stdio/Docker, direct HTTP and reverse share that public raw HTTP data protocol; standard MCP control transports remain unchanged. The host additionally requires current chat authorization, separate `allowTerminal:true` (default false) and a safe same-origin browser entrypoint (`MCP_TERMINAL_HTTPS_ORIGIN` for public HTTPS). Topology, Docker 0600 metadata/uid-gid and lazy-listener limits are in the [README](../README.md). Its self-contained HTML Resource is built to `dist/src/terminal/ui/index.html`; it does not add model tools, chat messages, command history, or automatic shell startup.

## Opening and stopping

Click **打开终端** to request a terminal in the host's default root. The host must obtain explicit, independent high-risk permission before creating a shell. The toolbar shows the returned shell and starting path; a starting directory is not an operating-system sandbox. The terminal inherits the remote service's configured permissions, not a separate browser-user OS identity.

**清屏** clears only the local terminal display and scrollback; it sends no shell command. **关闭终端** disables input immediately and requests remote cleanup. Closing cannot undo filesystem/network effects and does not guarantee every descendant process has ended. Input, including Ctrl-C and pasted text, goes to the PTY in order; uncertain acknowledgements are never replayed.

When the page is hidden, leaves, or loses its host lifecycle connection/permission, this UI fences the current instance, clears unsent input, stops renewal, and requests best-effort cleanup. Returning to the page or restoring connectivity never resumes or opens a shell automatically: click **打开终端** again. Failed cleanup relies on host cleanup and the remote lease; a disconnected page cannot guarantee that its close request arrived. A pending open cannot be cancelled remotely by this bridge until its terminal ID is known, so the host must also fence and clean late creation results.

## Host bridge contract

The app imports the existing file-manager UI bridge without changing it. It announces `mcp-app-ready` and accepts the existing parent `mcp-app-connect` v1 handshake with nonce, instance ID, and one MessagePort. Theme snapshots and `{type:'lifecycle', enabled, connected, message?}` use that authenticated port. No browser-direct network, CDN, clipboard API, web-link addon, iframe sandbox relaxation, or extra permission is required. OSC 52 clipboard sequences and OSC 8 hyperlinks are consumed without clipboard access or link activation.

The following are direct bridge methods (not wrapped in `rpc`):

| Method | Params | Result used by UI |
| --- | --- | --- |
| `terminalOpen` | `{rootId?:string,cols:number,rows:number}` (root omitted for default) | `{terminalId,rootId,path,shell,leaseMs}` |
| `terminalInput` | `{terminalId,data:string}` | acknowledgement only |
| `terminalResize` | `{terminalId,cols,rows}` | acknowledgement only |
| `terminalClose` | `{terminalId}` | acknowledgement only |
| `terminalRenew` | `{terminalId}` | success receipt; failure must reject |
| `terminalRead` | `{terminalId,cursor:number}` | `{cursor:number,output:string,state:'running'\|'exited'\|'closed',exitCode?:number,outputIncomplete?:boolean,error?:{code:string,message:string}}` |

Cursor starts at `0` and subsequent requests use the returned nondecreasing safe integer. The host must long-poll empty reads for up to 20 seconds; only one read is outstanding per instance. The next read starts after xterm's write callback, so rendering consumption propagates backpressure. The host owns the current connection's shared files/terminal HTTP dataSession and incremental UTF-8 decoding across backend chunks; the iframe receives strings, never independently decodes arbitrary byte fragments. Each read is capped at 64 KiB UTF-8 and the host's output buffer at 256 KiB. Output exceeding the UI's read cap is an error, not silently truncated.

A final `exited`/`closed` response means there are no subsequent output chunks to deliver: if output remains beyond this response, the host must continue returning `running`. The UI disables input and renewal upon receiving a final response, awaits its xterm write callback, then sends `terminalClose` to release host ownership and any final delivery credit. An explicitly requested reopen waits for that cleanup receipt before creating another terminal. `terminalClose` must be idempotent for a terminal belonging to this app instance, including an already-exited terminal; receiving EOF alone is not a browser-consumption acknowledgement. The host must not revoke the reader or discard queued output merely because the child exited or a renewal observes its final status.

The remote terminal status reports detected loss risk as `error:{code:"OUTPUT_INCOMPLETE",message:string}`; it does not have a top-level outputIncomplete field. This is detection and diagnosis, not lossless delivery or recovery of missing bytes. If output may have been lost (including backpressured PTY exit), the host must expose `outputIncomplete: true` and/or a structured `error` in the read result, or reject the read with a diagnostic; it must not translate this condition into a clean EOF. The UI retains already-rendered text, shows **输出可能不完整** as an error even with exit code `0`, and preserves that warning through later read/lifecycle updates. Read rejection is shown as **输出完整性无法确认**, never a clean-exit claim. Error text is displayed as text, not HTML. An absent flag is not a general guarantee of complete terminal history (local scrollback remains bounded).

Input requests are sequential, each at most 32 KiB UTF-8, with code-point-safe splitting. Pending UI input including the in-flight request is bounded at 256 KiB; overflow stops the instance instead of silently dropping/replaying input. Backend deliveries can be 64 KiB; staff splits input into ordered, awaited fd writes of at most 32 KiB without decoding arbitrary byte boundaries. Consumption ACK follows complete fd writes; output ACK follows the browser next-read cursor, never fetch/socket enqueue. The common 256 KiB sliding ACK window allows multiple blocks in flight, not per-block stop-and-wait; final EOF awaits receiver.end and its ACK, while interruption fails visibly and releases blocked work. Input acknowledgement does not prove command execution. Renewal runs every 10 seconds only for the current, connected/enabled, visible instance and never overlaps itself. The host must reject expired/fenced renewal, allow already-exited output to drain without treating it as grant expiry, verify its own current instance scope/grant at every boundary, and clean late creates when a bridge request was invalidated. No iframe-supplied identity replaces those checks.

ResizeObserver fits the local xterm viewport; remote resizes are debounced and ordered. Local display scrollback retains 2000 lines and is not a complete audit log. Terminal output is rendered by xterm, not inserted as HTML. Accessibility mode and the host light/dark semantic palette are enabled.

## Building

With the project's `@xterm/xterm` and `@xterm/addon-fit` dependencies installed:

```sh
npx tsc --project tsconfig.ui.json
node scripts/build-file-manager.mjs
```

The script retains the file-manager build and additionally emits the terminal Resource. It rejects terminal HTML larger than **4 MiB** and embeds both xterm packages' complete LICENSE notices, including dependency copyright, inside the HTML. It does not require external assets at runtime.

For a terminal-only UI check without compiling the server, use `node scripts/build-file-manager.mjs --app terminal --outdir /path/to/scratch`. The output is `/path/to/scratch/terminal/ui/index.html`. App registration, extension negotiation, native PTY packaging, host authorization, and browser/remote lifecycle testing are separate integration responsibilities; a successful UI bundle alone does not verify them.
