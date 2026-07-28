/**
 * Global outbound proxy support for staff-mcp.
 *
 * Node's built-in env-proxy support (NODE_USE_ENV_PROXY / --use-env-proxy)
 * only exists in Node >= v22.21.0 / v24.0.0. Installing an undici global
 * dispatcher provides the same behavior on every supported Node (>= 20) and
 * covers every fetch() issued in-process: the mcp-reverse SSE connector, its
 * message POSTs, and the MCP SDK client transports (including EventSource,
 * which delegates to globalThis.fetch).
 */
import { EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from "undici";

/** Redact credentials from a proxy URL for safe logging. */
export function maskProxyUrl(proxyUrl: string): string {
    try {
        const url = new URL(proxyUrl);
        if (url.username) url.username = "***";
        if (url.password) url.password = "***";
        return url.toString();
    } catch {
        return "<invalid proxy URL>";
    }
}

/** True when any proxy environment variable is present. */
export function hasProxyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(
        env.HTTPS_PROXY ||
        env.https_proxy ||
        env.HTTP_PROXY ||
        env.http_proxy
    );
}

/**
 * Install a proxy-aware global dispatcher for fetch(). Intended to be called
 * once at startup, before any outbound request.
 *
 * Priority:
 * 1. explicitProxyUrl (--proxy): routes ALL outbound traffic through it
 *    (undici's ProxyAgent does not apply NO_PROXY).
 * 2. HTTP_PROXY / HTTPS_PROXY environment variables: EnvHttpProxyAgent
 *    honors them per-request, including NO_PROXY bypass rules.
 * 3. Neither: leaves the default dispatcher untouched (no behavior change).
 *
 * @returns true when a proxy dispatcher was installed.
 */
export function configureGlobalProxy(explicitProxyUrl?: string): boolean {
    try {
        if (explicitProxyUrl) {
            setGlobalDispatcher(new ProxyAgent(explicitProxyUrl));
            console.error(
                `[staff-mcp] Outbound proxy: ${maskProxyUrl(explicitProxyUrl)} ` +
                `(applies to all requests; NO_PROXY is not applied for --proxy)`
            );
            return true;
        }
        if (hasProxyEnv()) {
            setGlobalDispatcher(new EnvHttpProxyAgent());
            console.error(
                "[staff-mcp] Outbound proxy: honoring HTTP_PROXY/HTTPS_PROXY/NO_PROXY environment variables"
            );
            return true;
        }
    } catch (error) {
        console.error(
            `[staff-mcp] Failed to configure outbound proxy: ` +
            (error instanceof Error ? error.message : String(error))
        );
    }
    return false;
}
