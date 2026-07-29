import { Agent, Dispatcher, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

const ENV_HTTP_PROXY = ["HTTP_PROXY", "http_proxy"] as const;
const ENV_HTTPS_PROXY = ["HTTPS_PROXY", "https_proxy"] as const;
const ENV_NO_PROXY = ["NO_PROXY", "no_proxy"] as const;

/**
 * Whether proxy environment variables are present (NO_PROXY alone does not count).
 */
export function hasProxyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return [...ENV_HTTP_PROXY, ...ENV_HTTPS_PROXY].some((key) => Boolean(env[key]));
}

// ============================================================
//  NO_PROXY parsing & matching
//
//  undici's EnvHttpProxyAgent only understands "*", exact hosts, and
//  leading-dot domain suffixes. Real-world NO_PROXY values (curl,
//  wget, Golang, Java semantics) also include IPv4/IPv6 CIDR ranges,
//  bare-domain suffixes and ":port" qualifiers. Corporate container
//  configs routinely use CIDR (e.g. "172.16.0.0/12"), which undici
//  silently fails to match — traffic to private addresses then hits
//  the proxy and gets rejected. We therefore match NO_PROXY ourselves.
// ============================================================

export type NoProxyEntryKind = "wildcard" | "exact" | "suffix" | "cidr4" | "cidr6";

export interface NoProxyEntry {
  kind: NoProxyEntryKind;
  /** normalized host: lowercase, no trailing dot, no IPv6 brackets */
  host: string;
  /** optional port restriction; null = any port */
  port: number | null;
  /** network base for cidr4 (32-bit int) / cidr6 (128-bit bigint) */
  network?: number | bigint;
  /** prefix length for cidr kinds */
  bits?: number;
}

/** Parse an IPv4 literal into a 32-bit number (using multiplication to avoid sign issues). */
function parseIpv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let result = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result;
}

function matchIpv4Cidr(ip: number, base: number, bits: number): boolean {
  if (bits <= 0) return true;
  if (bits >= 32) return ip === base;
  const shift = 32 - bits;
  return Math.floor(ip / 2 ** shift) === Math.floor(base / 2 ** shift);
}

/** Parse an IPv6 literal (with "::" compression and optional embedded IPv4 tail) into a 128-bit bigint. */
function parseIpv6ToBigInt(ipInput: string): bigint | null {
  let ip = ipInput;
  const zoneIdx = ip.indexOf("%"); // strip zone id, e.g. fe80::1%eth0
  if (zoneIdx >= 0) ip = ip.slice(0, zoneIdx);
  ip = ip.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(ip)) return null;

  const expandV4Tail = (groups: string[]): string[] | null => {
    const last = groups[groups.length - 1];
    if (last && last.includes(".")) {
      const v4 = parseIpv4ToInt(last);
      if (v4 === null) return null;
      groups[groups.length - 1] = Math.floor(v4 / 65536).toString(16);
      groups.push((v4 % 65536).toString(16));
    }
    return groups;
  };

  let groups: string[];
  if (ip.includes("::")) {
    const halves = ip.split("::");
    if (halves.length !== 2) return null; // at most one "::"
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves[1] ? halves[1].split(":") : [];
    const expandedTail = expandV4Tail(tail);
    if (expandedTail === null) return null;
    const missing = 8 - (head.length + expandedTail.length);
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...expandedTail];
  } else {
    const expanded = expandV4Tail(ip.split(":"));
    if (expanded === null) return null;
    groups = expanded;
  }
  if (groups.length !== 8) return null;

  let result = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    result = (result << 16n) | BigInt(parseInt(g, 16));
  }
  return result;
}

function matchIpv6Cidr(ip: bigint, base: bigint, bits: number): boolean {
  if (bits <= 0) return true;
  if (bits >= 128) return ip === base;
  const shift = BigInt(128 - bits);
  return ip >> shift === base >> shift;
}

function parsePort(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 0 && port <= 65535 ? port : null;
}

function makeEntry(hostInput: string, port: number | null): NoProxyEntry {
  let host = hostInput.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1); // strip FQDN trailing dot

  if (host.includes("/")) {
    let [base, bitsStr] = host.split("/", 2);
    // Optional port after the prefix length: "10.0.0.0/8:8080"
    if (bitsStr.includes(":")) {
      const [bitsPart, portPart] = bitsStr.split(":", 2);
      const parsed = parsePort(portPart);
      if (parsed !== null) {
        bitsStr = bitsPart;
        port = port ?? parsed;
      }
    }
    const bits = Number(bitsStr);
    const v4 = parseIpv4ToInt(base);
    if (v4 !== null && Number.isInteger(bits) && bits >= 0 && bits <= 32) {
      return { kind: "cidr4", host, port, network: v4, bits };
    }
    const v6 = parseIpv6ToBigInt(base);
    if (v6 !== null && Number.isInteger(bits) && bits >= 0 && bits <= 128) {
      return { kind: "cidr6", host, port, network: v6, bits };
    }
    // Unparseable CIDR: never matches (fail closed toward proxying, like undici).
    return { kind: "exact", host: "￼invalid￼", port };
  }
  if (host.startsWith("*.")) return { kind: "suffix", host: host.slice(2), port };
  if (host.startsWith(".")) return { kind: "suffix", host: host.slice(1), port };
  return { kind: "exact", host, port };
}

/**
 * Parse a NO_PROXY value into matchable entries.
 * Supported: "*", exact hosts, ".example.com"/"*.example.com" suffixes,
 * bare domains (exact + subdomains, curl semantics), "host:port",
 * IPv4/IPv6 literals and CIDR ranges ("10.0.0.0/8", "fd00::/8").
 */
export function parseNoProxy(value: string | undefined | null): NoProxyEntry[] {
  if (!value) return [];
  const entries: NoProxyEntry[] = [];

  for (const raw of value.split(",")) {
    const token0 = raw.trim();
    if (!token0) continue;
    if (token0 === "*") {
      entries.push({ kind: "wildcard", host: "*", port: null });
      continue;
    }

    // Bracketed IPv6, optionally with port: "[::1]" / "[::1]:8080"
    if (token0.startsWith("[")) {
      const close = token0.indexOf("]");
      if (close > 0) {
        const inner = token0.slice(1, close);
        const rest = token0.slice(close + 1);
        const port = rest.startsWith(":") ? parsePort(rest.slice(1)) : null;
        entries.push(makeEntry(inner, port));
        continue;
      }
    }

    // "host:port" — only when there is exactly one colon (otherwise it is IPv6)
    let host = token0;
    let port: number | null = null;
    if (!token0.includes("/")) {
      const colonCount = (token0.match(/:/g) || []).length;
      if (colonCount === 1) {
        const [h, p] = token0.split(":");
        const parsed = parsePort(p);
        if (parsed !== null) {
          host = h;
          port = parsed;
        }
      }
    }
    entries.push(makeEntry(host, port));
  }
  return entries;
}

function isIpLiteral(host: string): boolean {
  return parseIpv4ToInt(host) !== null || host.includes(":");
}

/** Whether a target host:port matches any NO_PROXY entry (i.e. should bypass the proxy). */
export function matchesNoProxy(hostname: string, port: number | null, entries: NoProxyEntry[]): boolean {
  if (!hostname) return false;
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);

  for (const entry of entries) {
    if (entry.kind === "wildcard") return true;
    if (entry.port !== null && entry.port !== port) continue;
    switch (entry.kind) {
      case "exact":
        if (host === entry.host) return true;
        // Bare-domain entries also cover subdomains (curl/wget semantics).
        if (!isIpLiteral(entry.host) && host.endsWith(`.${entry.host}`)) return true;
        break;
      case "suffix":
        if (host === entry.host || host.endsWith(`.${entry.host}`)) return true;
        break;
      case "cidr4": {
        const v4 = parseIpv4ToInt(host);
        if (v4 !== null && matchIpv4Cidr(v4, entry.network as number, entry.bits!)) return true;
        break;
      }
      case "cidr6": {
        const v6 = parseIpv6ToBigInt(host);
        if (v6 !== null && matchIpv6Cidr(v6, entry.network as bigint, entry.bits!)) return true;
        break;
      }
    }
  }
  return false;
}

// ============================================================
//  Environment-based proxy dispatcher
// ============================================================

export interface EnvProxyConfig {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

/**
 * Pure routing decision used by EnvProxyDispatcher (exported for tests):
 * returns the proxy URL to use for the given origin, or null for a direct connection.
 */
export function selectProxyForOrigin(origin: string | URL, config: EnvProxyConfig): string | null {
  let url: URL;
  try {
    url = typeof origin === "string" ? new URL(origin) : origin;
  } catch {
    return null;
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return null;
  const port = url.port ? Number(url.port) : protocol === "https:" ? 443 : 80;
  if (matchesNoProxy(url.hostname, port, parseNoProxy(config.noProxy))) return null;
  if (protocol === "https:") return config.httpsProxy ?? config.httpProxy ?? null;
  return config.httpProxy ?? null;
}

export interface EnvProxyDispatcherOptions extends EnvProxyConfig {
  agentOptions?: Agent.Options;
}

/**
 * Dispatcher that routes traffic through HTTP(S)_PROXY unless the target
 * matches NO_PROXY. Mirrors undici's EnvHttpProxyAgent fallback semantics
 * (https targets fall back to HTTP_PROXY when HTTPS_PROXY is unset) but
 * with full NO_PROXY support (CIDR, suffixes, ports, wildcard).
 */
export class EnvProxyDispatcher extends Dispatcher {
  private directAgent: Agent;
  private httpAgent: Dispatcher;
  private httpsAgent: Dispatcher;
  private noProxyEntries: NoProxyEntry[];
  private ownedAgents: Array<Agent | ProxyAgent>;

  constructor(opts: EnvProxyDispatcherOptions = {}) {
    super();
    const agentOpts = opts.agentOptions ?? {};
    this.directAgent = new Agent(agentOpts);
    this.ownedAgents = [this.directAgent];
    this.noProxyEntries = parseNoProxy(opts.noProxy);

    const mkProxy = (uri: string): ProxyAgent => {
      const agent = new ProxyAgent({ ...agentOpts, uri });
      this.ownedAgents.push(agent);
      return agent;
    };
    this.httpAgent = opts.httpProxy ? mkProxy(opts.httpProxy) : this.directAgent;
    this.httpsAgent = opts.httpsProxy ? mkProxy(opts.httpsProxy) : this.httpAgent;
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    let agent: Dispatcher = this.directAgent;
    try {
      const url = new URL(options.origin as string | URL);
      const protocol = url.protocol.toLowerCase();
      const port = url.port ? Number(url.port) : protocol === "https:" ? 443 : 80;
      if (!matchesNoProxy(url.hostname, port, this.noProxyEntries)) {
        agent = protocol === "https:" ? this.httpsAgent : this.httpAgent;
      }
    } catch {
      // Unparseable origin: fall back to direct.
    }
    return agent.dispatch(options, handler);
  }

  async close(): Promise<void> {
    await Promise.all(this.ownedAgents.map((agent) => agent.close()));
  }

  async destroy(): Promise<void> {
    await Promise.all(this.ownedAgents.map((agent) => agent.destroy()));
  }
}

// ============================================================
//  Global installation
// ============================================================

/**
 * Configure global proxy for all fetch/undici-based traffic.
 *
 * - If explicitProxyUrl is provided (--proxy), it takes precedence and is
 *   used for ALL traffic (NO_PROXY is intentionally not applied).
 * - Otherwise, standard HTTP_PROXY / HTTPS_PROXY / NO_PROXY environment
 *   variables are honored with full NO_PROXY support (exact hosts, domain
 *   suffixes, wildcards, ":port" qualifiers, IPv4/IPv6 CIDR ranges).
 *
 * Works on any supported Node.js version without NODE_USE_ENV_PROXY.
 */
export function configureGlobalProxy(explicitProxyUrl?: string): boolean {
  if (explicitProxyUrl) {
    try {
      setGlobalDispatcher(new ProxyAgent(explicitProxyUrl));
      console.error(`[staff-mcp] Outbound proxy: using ${explicitProxyUrl} for all traffic (NO_PROXY not applied)`);
      return true;
    } catch (err: any) {
      console.error(`[staff-mcp] Outbound proxy: failed to configure explicit proxy "${explicitProxyUrl}": ${err?.message ?? err}`);
      return false;
    }
  }

  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;

  if (httpProxy || httpsProxy) {
    setGlobalDispatcher(new EnvProxyDispatcher({ httpProxy, httpsProxy, noProxy }));
    const proxiesFound = [httpProxy && "HTTP_PROXY", httpsProxy && "HTTPS_PROXY"].filter(Boolean).join("/");
    console.error(`[staff-mcp] Outbound proxy: honoring ${proxiesFound}${noProxy ? "/NO_PROXY" : ""} environment variables`);
    return true;
  }

  return false;
}

export function maskProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "***";
    }
    return u.toString();
  } catch {
    return "<invalid proxy URL>";
  }
}

export function logGlobalDispatcherDebug(): void {
  const d = getGlobalDispatcher() as unknown as {
    constructor?: { name?: string };
    [key: symbol]: unknown;
  };
  const name = d?.constructor?.name ?? "unknown";
  const proxyKeys = Object.getOwnPropertySymbols(d)
    .map((s) => s.toString())
    .filter((s) => s.includes("proxy") || s.includes("Proxy"));
  console.error(`[staff-mcp][debug] global dispatcher: ${name} symbols: ${proxyKeys.join(", ") || "none"}`);
}
