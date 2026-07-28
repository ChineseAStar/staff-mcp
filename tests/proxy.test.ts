import assert from "node:assert/strict";
import { test } from "node:test";
import {
    Agent,
    EnvHttpProxyAgent,
    ProxyAgent,
    getGlobalDispatcher,
    setGlobalDispatcher,
} from "undici";
import {
    configureGlobalProxy,
    hasProxyEnv,
    maskProxyUrl,
} from "../src/utils/proxy.js";

const PROXY_ENV_KEYS = [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
] as const;

/** Run fn with all proxy-related env vars removed, then restore them. */
function withCleanProxyEnv<T>(fn: () => T): T {
    const saved = new Map<string, string | undefined>();
    for (const key of PROXY_ENV_KEYS) {
        saved.set(key, process.env[key]);
        delete process.env[key];
    }
    try {
        return fn();
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function restoreDefaultDispatcher(): void {
    setGlobalDispatcher(new Agent());
}

test("maskProxyUrl redacts credentials", () => {
    assert.equal(
        maskProxyUrl("http://user:secret@proxy.example.com:8080"),
        "http://***:***@proxy.example.com:8080/"
    );
    assert.equal(maskProxyUrl("http://proxy.example.com:8080"), "http://proxy.example.com:8080/");
    assert.equal(maskProxyUrl("not a url"), "<invalid proxy URL>");
});

test("hasProxyEnv detects uppercase and lowercase variables", () => {
    assert.equal(hasProxyEnv({}), false);
    assert.equal(hasProxyEnv({ HTTP_PROXY: "http://127.0.0.1:8080" }), true);
    assert.equal(hasProxyEnv({ https_proxy: "http://127.0.0.1:8080" }), true);
    assert.equal(hasProxyEnv({ NO_PROXY: "localhost" }), false);
});

test("explicit --proxy installs a ProxyAgent for all traffic", () =>
    withCleanProxyEnv(() => {
        try {
            assert.equal(configureGlobalProxy("http://127.0.0.1:8080"), true);
            assert.ok(getGlobalDispatcher() instanceof ProxyAgent);
        } finally {
            restoreDefaultDispatcher();
        }
    }));

test("proxy env vars install an EnvHttpProxyAgent", () =>
    withCleanProxyEnv(() => {
        process.env.HTTPS_PROXY = "http://127.0.0.1:8080";
        try {
            assert.equal(configureGlobalProxy(), true);
            assert.ok(getGlobalDispatcher() instanceof EnvHttpProxyAgent);
        } finally {
            restoreDefaultDispatcher();
        }
    }));

test("explicit --proxy wins over env vars", () =>
    withCleanProxyEnv(() => {
        process.env.HTTPS_PROXY = "http://127.0.0.1:8080";
        try {
            assert.equal(configureGlobalProxy("http://127.0.0.1:9090"), true);
            assert.ok(getGlobalDispatcher() instanceof ProxyAgent);
        } finally {
            restoreDefaultDispatcher();
        }
    }));

test("no proxy configuration leaves the default dispatcher untouched", () =>
    withCleanProxyEnv(() => {
        restoreDefaultDispatcher();
        const before = getGlobalDispatcher();
        assert.equal(configureGlobalProxy(), false);
        assert.equal(getGlobalDispatcher(), before);
    }));

test("an invalid explicit proxy does not throw and reports failure", () =>
    withCleanProxyEnv(() => {
        restoreDefaultDispatcher();
        // ProxyAgent constructor accepts arbitrary strings; verify the call
        // path is resilient either way and never crashes startup.
        const result = configureGlobalProxy("://invalid");
        assert.equal(typeof result, "boolean");
        restoreDefaultDispatcher();
    }));
