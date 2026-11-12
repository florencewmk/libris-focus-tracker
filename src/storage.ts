import type { CheckIn, StudySession } from "./types";

export const LOCAL_USER_ID = "local";
const DATABASE_NAME = "libris-focus-local";
const SESSION_STORE = "study_sessions";
const CHECK_IN_STORE = "library_check_ins";

type StoredData = { sessions: StudySession[]; checkIns: CheckIn[] };
type JsonObject = Record<string, unknown>;

let databasePromise: Promise<IDBDatabase> | undefined;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must contain between 1 and ${maxLength} characters.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const input = text(value, label, 64);
  const parts = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.exec(input);
  const milliseconds = Date.parse(input);
  if (!parts || !Number.isFinite(milliseconds)) throw new Error(`${label} must be a valid timestamp.`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!daysInMonth || day < 1 || day > daysInMonth || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) {
    throw new Error(`${label} must be a valid timestamp.`);
  }
  return new Date(milliseconds).toISOString();
}

function sessionRecord(value: unknown, label: string): StudySession {
  const item = object(value, label);
  const startedAt = timestamp(item.started_at, `${label}: start time`);
  const endedAt = timestamp(item.ended_at, `${label}: end time`);
  if (Date.parse(endedAt) < Date.parse(startedAt)) throw new Error(`${label}: end time cannot be before start time.`);
  if (typeof item.duration_seconds !== "number" || !Number.isSafeInteger(item.duration_seconds) || item.duration_seconds < 0) {
    throw new Error(`${label}: duration must be a nonnegative whole number of seconds.`);
  }
  return {
    id: text(item.id, `${label}: ID`, 200),
    user_id: LOCAL_USER_ID,
    location: text(item.location, `${label}: location`, 100),
    subject: text(item.subject, `${label}: subject`, 80),
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: item.duration_seconds,
  };
}

function checkInRecord(value: unknown, label: string): CheckIn {
  const item = object(value, label);
  return {
    id: text(item.id, `${label}: ID`, 200),
    user_id: LOCAL_USER_ID,
    location: text(item.location, `${label}: location`, 100),
    checked_in_at: timestamp(item.checked_in_at, `${label}: check-in time`),
  };
}

function uniqueRecords<T extends { id: string }>(values: unknown, label: string, normalize: (value: unknown, label: string) => T): T[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`);
  const records = new Map<string, T>();
  values.forEach((value, index) => {
    const record = normalize(value, `${label} record ${index + 1}`);
    const existing = records.get(record.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error(`${label} contains conflicting records with the same ID.`);
    }
    records.set(record.id, record);
  });
  return [...records.values()];
}

/** Validate the entire backup before opening a write transaction. */
export function parseBackup(input: string): StoredData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("This file is not valid JSON. Choose a Libris backup file.");
  }
  const backup = object(parsed, "Backup");
  if ("format" in backup || "version" in backup) {
    if (backup.format !== "libris-backup" || backup.version !== 1) {
      throw new Error("This backup format or version is not supported by Libris.");
    }
    timestamp(backup.exported_at, "Backup export time");
  }
  return {
    sessions: uniqueRecords(backup.study_sessions, "Study sessions", sessionRecord),
    checkIns: uniqueRecords(backup.library_check_ins, "Library check-ins", checkInRecord),
  };
}

function storageError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return new Error("Your device has run out of storage. Export a backup, free some space, and try again.");
  }
  return new Error("Libris could not access local saves. Allow this site's browser storage and try again. Your existing records have not been cleared.");
}

async function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw storageError(undefined);
  if (!databasePromise) {
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(SESSION_STORE)) database.createObjectStore(SESSION_STORE, { keyPath: "id" });
        if (!database.objectStoreNames.contains(CHECK_IN_STORE)) database.createObjectStore(CHECK_IN_STORE, { keyPath: "id" });
      };
      request.onerror = () => { settled = true; reject(storageError(request.error)); };
      request.onblocked = () => {
        settled = true;
        reject(new Error("Another Libris tab is blocking local saves. Close other Libris tabs, then reload."));
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        const database = request.result;
        database.onversionchange = () => { database.close(); databasePromise = undefined; };
        resolve(database);
      };
    }).catch((error: unknown) => {
      databasePromise = undefined;
      throw error instanceof Error && !(error instanceof DOMException) ? error : storageError(error);
    });
  }
  return databasePromise;
}

/** Resolve only after the transaction commits, including all its requests. */
async function transaction<T>(stores: string[], mode: IDBTransactionMode, prepare: (tx: IDBTransaction) => () => T): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = database.transaction(stores, mode); } catch (error) { reject(storageError(error)); return; }
    let result: () => T;
    tx.onabort = () => reject(storageError(tx.error));
    tx.onerror = () => reject(storageError(tx.error));
    tx.oncomplete = () => {
      try { resolve(result()); } catch (error) { reject(error); }
    };
    try { result = prepare(tx); } catch (error) {
      tx.abort();
      reject(storageError(error));
    }
  });
}

export async function loadData(): Promise<StoredData> {
  return transaction([SESSION_STORE, CHECK_IN_STORE], "readonly", (tx) => {
    const sessions = tx.objectStore(SESSION_STORE).getAll() as IDBRequest<StudySession[]>;
    const checkIns = tx.objectStore(CHECK_IN_STORE).getAll() as IDBRequest<CheckIn[]>;
    return () => ({
      sessions: sessions.result.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)),
      checkIns: checkIns.result.sort((a, b) => Date.parse(b.checked_in_at) - Date.parse(a.checked_in_at)),
    });
  });
}

export async function saveSession(session: StudySession): Promise<void> {
  const record = sessionRecord(session, "Study session");
  return transaction([SESSION_STORE], "readwrite", (tx) => {
    tx.objectStore(SESSION_STORE).put(record);
    return () => undefined;
  });
}

export async function deleteSession(id: string): Promise<void> {
  text(id, "Study session ID", 200);
  return transaction([SESSION_STORE], "readwrite", (tx) => {
    tx.objectStore(SESSION_STORE).delete(id);
    return () => undefined;
  });
}

export async function saveCheckIn(checkIn: CheckIn): Promise<void> {
  const record = checkInRecord(checkIn, "Library check-in");
  return transaction([CHECK_IN_STORE], "readwrite", (tx) => {
    tx.objectStore(CHECK_IN_STORE).put(record);
    return () => undefined;
  });
}

export async function exportBackup(): Promise<string> {
  const data = await loadData();
  return JSON.stringify({
    format: "libris-backup",
    version: 1,
    exported_at: new Date().toISOString(),
    study_sessions: data.sessions,
    library_check_ins: data.checkIns,
  }, null, 2);
}

export async function importBackup(input: string): Promise<{ sessions: number; checkIns: number }> {
  const data = parseBackup(input);
  return transaction([SESSION_STORE, CHECK_IN_STORE], "readwrite", (tx) => {
    const sessions = tx.objectStore(SESSION_STORE);
    const checkIns = tx.objectStore(CHECK_IN_STORE);
    data.sessions.forEach((item) => sessions.put(item));
    data.checkIns.forEach((item) => checkIns.put(item));
    return () => ({ sessions: data.sessions.length, checkIns: data.checkIns.length });
  });
}
