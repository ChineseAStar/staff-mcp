import { test } from "node:test";
import assert from "node:assert";
import path from "path";
import { SecurityManager } from "../src/security.js";

test("SecurityManager - Should allow paths inside allowed directories", () => {
  const security = new SecurityManager("/tmp/sandbox");
  const validated = security.resolveAndValidatePath("test.txt", "/tmp/sandbox");
  assert.strictEqual(validated, path.resolve("/tmp/sandbox/test.txt"));
});

test("SecurityManager - Should block paths outside allowed directories", () => {
  const security = new SecurityManager("/tmp/sandbox");
  assert.throws(() => {
    security.resolveAndValidatePath("../outside.txt", "/tmp/sandbox");
  }, /Security Error/);
});

test("SecurityManager - Should allow subdirectory access", () => {
  const security = new SecurityManager("/tmp/sandbox");
  const validated = security.resolveAndValidatePath("subdir/file.ts", "/tmp/sandbox");
  assert.strictEqual(validated, path.resolve("/tmp/sandbox/subdir/file.ts"));
});
