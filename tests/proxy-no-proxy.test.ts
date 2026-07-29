import assert from "node:assert/strict";
import { test, after } from "node:test";
import http from "node:http";
import net from "node:net";
import { AddressInfo } from "node:net";
import { fetch } from "undici";
import {
  EnvProxyDispatcher,
  matchesNoProxy,
  parseNoProxy,
  selectProxyForOrigin,
} from "../src/utils/proxy.js";

// ------------------------------------------------------------
//  Pure matcher tests
// ------------------------------------------------------------

function m(noProxy: string, host: string, port: number | null = 80): boolean {
  return matchesNoProxy(host, port, parseNoProxy(noProxy));
}

test("NO_PROXY wildcard bypasses everything", () => {
  assert.equal(m("*", "anything.example.com", 443), true);
  assert.equal(m("*,proxy.internal", "proxy.internal"), true);
});

test("NO_PROXY exact hosts and case-insensitivity", () => {
  assert.equal(m("172.25.44.201", "172.25.44.201"), true);
  assert.equal(m("172.25.44.201", "172.25.44.202"), false);
  assert.equal(m("EXAMPLE.com", "example.COM"), true);
  assert.equal(m("example.com.", "example.com"), true); // FQDN trailing dot
  assert.equal(m("example.com", "example.com."), true);
});

test("NO_PROXY domain suffixes (leading dot, star, bare domain)", () => {
  assert.equal(m(".example.com", "www.example.com"), true);
  assert.equal(m(".example.com", "example.com"), true);
  assert.equal(m("*.example.com", "a.b.example.com"), true);
  // bare domain covers subdomains too (curl/wget semantics)
  assert.equal(m("example.com", "www.example.com"), true);
  assert.equal(m("example.com", "notexample.com"), false);
  assert.equal(m("ample.com", "example.com"), false);
});

test("NO_PROXY port qualifier restricts the entry to that port", () => {
  assert.equal(m("example.com:8080", "example.com", 8080), true);
  assert.equal(m("example.com:8080", "example.com", 80), false);
  assert.equal(m("10.0.0.0/8:8080", "10.1.2.3", 8080), true);
  assert.equal(m("10.0.0.0/8:8080", "10.1.2.3", 80), false);
});

test("NO_PROXY IPv4 CIDR ranges", () => {
  // the corporate container case: 172.16.0.0/12 covers 172.16.0.0 - 172.31.255.255
  assert.equal(m("172.16.0.0/12", "172.25.44.201"), true);
  assert.equal(m("172.16.0.0/12", "172.31.255.254"), true);
  assert.equal(m("172.16.0.0/12", "172.32.0.1"), false);
  assert.equal(m("172.16.0.0/12", "10.0.0.1"), false);
  assert.equal(m("10.0.0.0/8", "10.3.0.4"), true);
  assert.equal(m("192.168.0.0/16", "192.168.1.1"), true);
  assert.equal(m("192.168.0.0/16", "192.167.1.1"), false);
  // boundary prefix lengths
  assert.equal(m("0.0.0.0/0", "203.0.113.9"), true);
  assert.equal(m("10.1.2.3/32", "10.1.2.3"), true);
  assert.equal(m("10.1.2.3/32", "10.1.2.4"), false);
  // hostnames never match IP CIDRs
  assert.equal(m("10.0.0.0/8", "host.example.com"), false);
});

test("NO_PROXY IPv6 literals and CIDR ranges", () => {
  assert.equal(m("::1", "::1"), true);
  assert.equal(m("::1", "[::1]"), true);
  assert.equal(m("[::1]", "::1"), true);
  assert.equal(m("fd00::/8", "fd12::3456"), true);
  assert.equal(m("fd00::/8", "fe80::1"), false);
  assert.equal(m("fe80::/10", "fe80::1%eth0"), true); // zone id tolerated
  // embedded IPv4 tail
  assert.equal(m("::ffff:10.0.0.0/104", "::ffff:10.1.2.3"), true);
});

test("NO_PROXY invalid entries never match and never throw", () => {
  assert.equal(m("10.0.0.0/33", "10.1.2.3"), false);
  assert.equal(m("garbage///", "garbage"), false);
  assert.equal(m("", "anything"), false);
  assert.doesNotThrow(() => parseNoProxy(":::,,,[/8,"));
});

test("selectProxyForOrigin routing decisions", () => {
  const cfg = { httpProxy: "http://proxy:10808", httpsProxy: "http://sproxy:10809" };

  // CIDR bypass — the exact regression scenario from the field report
  assert.equal(
    selectProxyForOrigin("http://172.25.44.201/api/mcp/reverse/sse", {
      httpProxy: "http://172.25.44.201:10808",
      noProxy: "localhost,127.0.0.1,192.168.0.0/16,172.16.0.0/12,10.0.0.0/8",
    }),
    null
  );

  // not covered by NO_PROXY → use the per-protocol proxy
  assert.equal(selectProxyForOrigin("http://8.8.8.8/x", { ...cfg, noProxy: "172.16.0.0/12" }), "http://proxy:10808");
  assert.equal(selectProxyForOrigin("https://8.8.8.8/x", { ...cfg, noProxy: "" }), "http://sproxy:10809");

  // https falls back to HTTP_PROXY when HTTPS_PROXY is unset (undici semantics)
  assert.equal(selectProxyForOrigin("https://8.8.8.8/x", { httpProxy: "http://proxy:10808" }), "http://proxy:10808");
  // http never uses HTTPS_PROXY
  assert.equal(selectProxyForOrigin("http://8.8.8.8/x", { httpsProxy: "http://sproxy:10809" }), null);

  // default ports participate in port-qualified NO_PROXY entries
  assert.equal(selectProxyForOrigin("http://example.com/path", { httpProxy: "http://p:1", noProxy: "example.com:80" }), null);
  assert.equal(selectProxyForOrigin("http://example.com:8080/path", { httpProxy: "http://p:1", noProxy: "example.com:80" }), "http://p:1");

  // non-http protocols and garbage go direct
  assert.equal(selectProxyForOrigin("ws://example.com/x", cfg), null);
  assert.equal(selectProxyForOrigin("not a url", cfg), null);
});

// ------------------------------------------------------------
//  Integration: dispatcher routes bypass directly, rest via proxy
// ------------------------------------------------------------

interface MiniServer {
  url: string;
  close: () => Promise<void>;
}

async function startTargetServer(): Promise<MiniServer> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("target-ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Minimal HTTP proxy that handles CONNECT tunnels and counts them. */
async function startConnectProxy(): Promise<MiniServer & { hits: () => number }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(418);
    res.end("unexpected plain proxy request");
  });
  server.on("connect", (req, socket: net.Socket, head: Buffer) => {
    hits++;
    const [host, portStr] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(portStr), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.end());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

test("EnvProxyDispatcher bypasses NO_PROXY CIDR targets, proxies the rest", async () => {
  const target = await startTargetServer();
  const proxy = await startConnectProxy();
  cleanups.push(target.close, proxy.close);

  // 1) target inside NO_PROXY range → direct, proxy untouched
  const bypass = new EnvProxyDispatcher({ httpProxy: proxy.url, noProxy: "127.0.0.0/8" });
  cleanups.push(() => bypass.close());
  const res1 = await fetch(`${target.url}/ping`, { dispatcher: bypass });
  assert.equal(res1.status, 200);
  assert.equal(await res1.text(), "target-ok");
  assert.equal(proxy.hits(), 0, "proxy must not be consulted for NO_PROXY targets");

  // 2) target outside NO_PROXY range → CONNECT through the proxy
  const proxied = new EnvProxyDispatcher({ httpProxy: proxy.url, noProxy: "10.0.0.0/8" });
  cleanups.push(() => proxied.close());
  const res2 = await fetch(`${target.url}/ping`, { dispatcher: proxied });
  assert.equal(res2.status, 200);
  assert.equal(await res2.text(), "target-ok");
  assert.ok(proxy.hits() >= 1, "request should have been tunneled through the proxy");
});
