import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

// Use the project's existing TypeScript compiler; no additional test packages.
const source = await readFile(new URL("../src/storage.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { parseBackup, importBackup, loadData, LOCAL_USER_ID } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const session = {
  id: "session-1", user_id: "former-cloud-user", location: "Library", subject: "Physics",
  started_at: "2026-11-12T09:00:00Z", ended_at: "2026-11-12T10:00:00Z", duration_seconds: 3600,
};
const checkIn = { id: "visit-1", user_id: "former-cloud-user", location: "Library", checked_in_at: "2026-11-12T08:55:00Z" };
const backup = (overrides = {}) => JSON.stringify({
  format: "libris-backup", version: 1, exported_at: "2026-11-12T10:05:00Z",
  study_sessions: [session], library_check_ins: [checkIn], ...overrides,
});

test("parses a full backup and moves former cloud records to the local profile", () => {
  const result = parseBackup(backup());
  assert.equal(result.sessions[0].user_id, LOCAL_USER_ID);
  assert.equal(result.checkIns[0].user_id, LOCAL_USER_ID);
  assert.equal(result.sessions[0].started_at, "2026-11-12T09:00:00.000Z");
  assert.equal(result.sessions[0].duration_seconds, 3600);
});

test("accepts table-only exports and PostgreSQL timestamp offsets", () => {
  const result = parseBackup(JSON.stringify({
    study_sessions: [{ ...session, started_at: "2026-11-12 09:00:00+00", ended_at: "2026-11-12 10:00:00+00" }],
    library_check_ins: [checkIn],
  }));
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].started_at, "2026-11-12T09:00:00.000Z");
});

test("deduplicates identical IDs and rejects conflicting records", () => {
  assert.equal(parseBackup(backup({ study_sessions: [session, session] })).sessions.length, 1);
  assert.throws(() => parseBackup(backup({ study_sessions: [session, { ...session, subject: "Chemistry" }] })), /conflicting/);
});

test("rejects unsupported backup versions and malformed collections", () => {
  for (const value of ["{", "null", "[]", "{}", backup({ version: 2 }), backup({ format: "other" }), backup({ study_sessions: null }), backup({ library_check_ins: {} })]) {
    assert.throws(() => parseBackup(value));
  }
});

test("rejects invalid data including impossible dates and unsafe durations", () => {
  for (const patch of [
    { duration_seconds: -1 }, { duration_seconds: 1.5 }, { duration_seconds: Number.MAX_SAFE_INTEGER + 1 },
    { started_at: "2026-02-30T09:00:00Z" }, { started_at: "123" }, { ended_at: "2026-11-12T08:00:00Z" },
    { location: " " }, { location: "x".repeat(101) }, { subject: "x".repeat(81) }, { id: "" },
  ]) {
    assert.throws(() => parseBackup(backup({ study_sessions: [{ ...session, ...patch }] })));
  }
  assert.throws(() => parseBackup(backup({ library_check_ins: [{ ...checkIn, checked_in_at: "not-a-date" }] })));
  assert.throws(() => parseBackup(backup({ exported_at: "not-a-date" })));
});

test("allows empty backups and zero-duration sessions", () => {
  assert.deepEqual(parseBackup(backup({ study_sessions: [], library_check_ins: [] })), { sessions: [], checkIns: [] });
  assert.equal(parseBackup(backup({ study_sessions: [{ ...session, duration_seconds: 0 }] })).sessions[0].duration_seconds, 0);
});

test("validates every record before attempting to open local storage", async () => {
  await assert.rejects(importBackup(backup({ library_check_ins: [{ ...checkIn, id: "" }] })), /ID/);
});

test("reports unavailable browser storage without pretending to save", async () => {
  await assert.rejects(loadData(), /could not access local saves/);
});
