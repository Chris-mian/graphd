import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { openStore } = await import("../src/db.mjs");

test("a store waits for a competing writer instead of failing immediately", () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), "graphd-db-")), "graph.db");
  const store = openStore(databasePath);

  const { timeout } = store.prepare("PRAGMA busy_timeout").get();

  assert.ok(timeout > 0, "the hourly import and the daemon write to the same file");
  store.close();
});

test("the store is in WAL mode so a reader never blocks the daemon's writes", () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), "graphd-db-")), "graph.db");
  const store = openStore(databasePath);

  const { journal_mode: journalMode } = store.prepare("PRAGMA journal_mode").get();

  assert.equal(journalMode, "wal");
  store.close();
});
