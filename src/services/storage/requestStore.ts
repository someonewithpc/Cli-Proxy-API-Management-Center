/**
 * IndexedDB store for collected usage attempts, one partition per management server.
 *
 * The backend queue is destructive, so this is the only copy of an attempt once collected.
 */

import type { UsageAttempt } from '@/services/api/usageQueue';

export const REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const REQUEST_STORE_CAP = 20_000;

const DB_NAME = 'cpa-requests';
const DB_VERSION = 1;
const STORE = 'attempts';
const BY_SCOPE_TIME = 'scope-time';

export interface StoredAttempt extends UsageAttempt {
  scope: string;
}

/** Keys to delete so that what remains is inside the retention window and under the cap. */
export function selectPruned<T extends { timestamp: number }>(
  entries: readonly T[],
  nowMs: number,
  retentionMs = REQUEST_RETENTION_MS,
  cap = REQUEST_STORE_CAP
): T[] {
  const cutoff = nowMs - retentionMs;
  const expired: T[] = [];
  const kept: T[] = [];
  for (const entry of entries) (entry.timestamp < cutoff ? expired : kept).push(entry);
  if (kept.length <= cap) return expired;
  const oldestFirst = [...kept].sort((a, b) => a.timestamp - b.timestamp);
  return [...expired, ...oldestFirst.slice(0, kept.length - cap)];
}

let dbPromise: Promise<IDBDatabase> | null = null;

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const transactionDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export const isRequestStoreAvailable = (): boolean => typeof indexedDB !== 'undefined';

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, {
          keyPath: ['scope', 'executionId'],
        });
        store.createIndex(BY_SCOPE_TIME, ['scope', 'timestamp']);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

const scopeRange = (scope: string, fromMs = -Infinity) =>
  IDBKeyRange.bound([scope, fromMs], [scope, Infinity]);

export const requestStore = {
  /** Writes attempts under `scope`; an execution id already stored is replaced, not duplicated. */
  async put(scope: string, attempts: readonly UsageAttempt[]): Promise<void> {
    if (!attempts.length) return;
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const attempt of attempts) store.put({ ...attempt, scope } satisfies StoredAttempt);
    await transactionDone(tx);
  },

  async list(scope: string, fromMs = -Infinity): Promise<UsageAttempt[]> {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const rows = await requestResult(
      tx.objectStore(STORE).index(BY_SCOPE_TIME).getAll(scopeRange(scope, fromMs))
    );
    return (rows as StoredAttempt[]).map(({ scope: _scope, ...attempt }) => attempt);
  },

  async count(scope: string): Promise<number> {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    return requestResult(tx.objectStore(STORE).index(BY_SCOPE_TIME).count(scopeRange(scope)));
  },

  async prune(scope: string, nowMs = Date.now()): Promise<number> {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const rows = (await requestResult(
      tx.objectStore(STORE).index(BY_SCOPE_TIME).getAll(scopeRange(scope))
    )) as StoredAttempt[];
    const doomed = selectPruned(rows, nowMs);
    const store = tx.objectStore(STORE);
    for (const row of doomed) store.delete([scope, row.executionId]);
    await transactionDone(tx);
    return doomed.length;
  },

  async clear(scope: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const index = tx.objectStore(STORE).index(BY_SCOPE_TIME);
    const keys = await requestResult(index.getAllKeys(scopeRange(scope)));
    const store = tx.objectStore(STORE);
    for (const key of keys) store.delete(key);
    await transactionDone(tx);
  },
};
