import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { checkServerIdentity } from 'node:tls';
import { selectProxyForOrigin } from '../utils/proxy.js';

export function validateReverseUrl(value: string): URL {
    const url = new URL(value);
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/api/mcp/reverse'
    )
        throw new Error(
            'Reverse URL must be an HTTP(S) base endpoint without credentials, query or fragment.',
        );
    return url;
}

export function reverseProxyUrl(
    url: URL,
    explicit?: string,
    env = process.env,
): URL | undefined {
    const selected =
        explicit ??
        selectProxyForOrigin(url, {
            httpProxy: env.HTTP_PROXY || env.http_proxy,
            httpsProxy: env.HTTPS_PROXY || env.https_proxy,
            noProxy: env.NO_PROXY || env.no_proxy,
        });
    if (selected === null || selected === undefined) return undefined;
    try {
        const proxy = new URL(selected);
        if (
            !['http:', 'https:'].includes(proxy.protocol) ||
            proxy.search ||
            proxy.hash
        )
            throw new Error('Invalid proxy');
        decodeURIComponent(proxy.username);
        decodeURIComponent(proxy.password);
        return proxy;
    } catch {
        throw new Error('Reverse proxy must be a valid HTTP(S) proxy URL.');
    }
}

/** One attempt's outbound control/data HTTP pool; never follows redirects or logs credentials. */
export function createReverseHttp(
    url: URL,
    proxy: URL | undefined,
    signal: AbortSignal,
) {
    const tls = {
        rejectUnauthorized: true,
        checkServerIdentity: (
            _hostname: string,
            certificate: Parameters<typeof checkServerIdentity>[1],
        ) =>
            checkServerIdentity(
                url.hostname.replace(/^\[|\]$/g, ''),
                certificate,
            ),
    };
    let dispatcher: Agent | ProxyAgent;
    if (proxy) {
        const address = new URL(proxy);
        const token =
            address.username || address.password
                ? 'Basic ' +
                  Buffer.from(
                      `${decodeURIComponent(address.username)}:${decodeURIComponent(address.password)}`,
                  ).toString('base64')
                : undefined;
        address.username = '';
        address.password = '';
        dispatcher = new ProxyAgent({
            uri: address.href,
            token,
            requestTls: tls,
            proxyTls: { rejectUnauthorized: true },
        });
    } else {
        dispatcher = new Agent({ connect: tls });
    }
    const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const target = new URL(request.url);
        if (
            target.origin !== url.origin ||
            target.username ||
            target.password ||
            target.hash ||
            !target.pathname.startsWith(url.pathname + '/')
        )
            throw new Error('Reverse HTTP endpoint rejected');
        const response = await undiciFetch(target, {
            method: request.method,
            headers: Object.fromEntries(request.headers),
            body: request.body,
            duplex: 'half',
            signal: AbortSignal.any([signal, request.signal]),
            redirect: 'manual',
            dispatcher,
        });
        return response as unknown as Response;
    };
    return { fetch, close: () => dispatcher.destroy() };
}
