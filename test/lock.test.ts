// test/lock.test.ts — 跨行程鎖（B4：帳本與健康檔共用）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireLock, releaseLock } from "../extensions/pi-compass-router/lock.js";

function scratch(): string {
  return join(mkdtempSync(join(tmpdir(), "compass-lock-")), "state.json");
}

test("acquireLock is exclusive until released", () => {
  const target = scratch();
  try {
    assert.equal(acquireLock(target), true);
    assert.equal(acquireLock(target), false, "second holder is refused");
    releaseLock(target);
    assert.equal(acquireLock(target), true, "released lock can be re-acquired");
  } finally {
    releaseLock(target);
    rmSync(join(target, ".."), { recursive: true, force: true });
  }
});

test("acquireLock steals a stale lock", () => {
  const target = scratch();
  try {
    assert.equal(acquireLock(target), true);
    const lockDir = `${target}.lock`;
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old);
    assert.equal(acquireLock(target), true, "stale lock is stolen");
  } finally {
    releaseLock(target);
    rmSync(join(target, ".."), { recursive: true, force: true });
  }
});

test("releaseLock is a no-op when nothing is held", () => {
  const target = scratch();
  try {
    assert.doesNotThrow(() => releaseLock(target));
    assert.equal(existsSync(`${target}.lock`), false);
  } finally {
    rmSync(join(target, ".."), { recursive: true, force: true });
  }
});
