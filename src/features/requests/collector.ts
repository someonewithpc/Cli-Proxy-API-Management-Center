/**
 * App-wide collector for the usage queue.
 *
 * The queue pop is destructive and the backend keeps records only for its retention window
 * (60 s by default), so collection runs whenever the panel is open and signed in, not only on the
 * Requests page. Popped records always land in the scope of the connection that popped them, even
 * when the connection changes mid-request; only status updates are dropped for a stale session.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { apiClient } from '@/services/api/client';
import { USAGE_QUEUE_MAX_COUNT, usageQueueApi } from '@/services/api/usageQueue';
import { isRequestStoreAvailable, requestStore } from '@/services/storage/requestStore';
import { useAuthStore } from '@/stores';

export const COLLECT_INTERVAL_MS = 3000;
/** Pages popped back to back while the queue keeps returning full pages. */
const MAX_PAGES_PER_TICK = 10;
const PRUNE_EVERY_TICKS = 100;
const ENABLED_STORAGE_KEY = 'cpa-requests-collect';

export type CollectorStatus =
  | 'off'
  | 'starting'
  | 'live'
  | 'error'
  /** The backend has no usage queue route (404). */
  | 'unsupported'
  /** This browser has no IndexedDB. */
  | 'no-storage';

interface CollectorState {
  enabled: boolean;
  status: CollectorStatus;
  lastPollAt: number | null;
  lastError: string;
  /** Bumped whenever stored attempts change, so views reload. */
  revision: number;
  setEnabled: (enabled: boolean) => void;
}

const readEnabled = (): boolean => {
  try {
    return localStorage.getItem(ENABLED_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
};

export const useCollectorStore = create<CollectorState>((set) => ({
  enabled: readEnabled(),
  status: 'off',
  lastPollAt: null,
  lastError: '',
  revision: 0,
  setEnabled: (enabled) => {
    try {
      localStorage.setItem(ENABLED_STORAGE_KEY, String(enabled));
    } catch {
      // Private mode: the toggle still applies for this session.
    }
    set({ enabled });
  },
}));

const bumpRevision = () =>
  useCollectorStore.setState((state) => ({ revision: state.revision + 1 }));

export async function clearCollectedRequests(scope: string): Promise<void> {
  await requestStore.clear(scope);
  bumpRevision();
}

const errorStatus = (error: unknown): number | undefined =>
  typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status: unknown }).status)
    : undefined;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : '';

/** Starts polling for `scope`; returns a stop function. */
export function startCollector(scope: string, intervalMs = COLLECT_INTERVAL_MS): () => void {
  if (!isRequestStoreAvailable()) {
    useCollectorStore.setState({ status: 'no-storage' });
    return () => {};
  }

  const revision = apiClient.getConnectionRevision();
  const client = apiClient.captureConnection();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ticks = 0;
  const isCurrent = () => !stopped && revision === apiClient.getConnectionRevision();

  useCollectorStore.setState({ status: 'starting', lastError: '' });

  const tick = async () => {
    timer = null;
    let stored = 0;
    try {
      if (ticks % PRUNE_EVERY_TICKS === 0 && (await requestStore.prune(scope)) > 0) bumpRevision();
      ticks += 1;
      for (let page = 0; page < MAX_PAGES_PER_TICK && isCurrent(); page += 1) {
        const { received, attempts } = await usageQueueApi.pop(USAGE_QUEUE_MAX_COUNT, client);
        const ordered = attempts.map((attempt) => ({
          ...attempt,
          seq: page * USAGE_QUEUE_MAX_COUNT + attempt.seq,
        }));
        await requestStore.put(scope, ordered);
        stored += ordered.length;
        if (received < USAGE_QUEUE_MAX_COUNT) break;
      }
      if (stored > 0) bumpRevision();
      if (!isCurrent()) return;
      useCollectorStore.setState({ status: 'live', lastPollAt: Date.now(), lastError: '' });
    } catch (error) {
      if (stored > 0) bumpRevision();
      if (!isCurrent()) return;
      if (errorStatus(error) === 404) {
        useCollectorStore.setState({ status: 'unsupported', lastError: '' });
        return;
      }
      useCollectorStore.setState({ status: 'error', lastError: errorMessage(error) });
    }
    if (isCurrent()) timer = setTimeout(tick, intervalMs);
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Mount once inside the authenticated layout. */
export function useRequestsCollector(): void {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const enabled = useCollectorStore((state) => state.enabled);

  useEffect(() => {
    if (!isAuthenticated || !apiBase || !managementKey || !enabled) {
      useCollectorStore.setState({ status: 'off' });
      return;
    }
    return startCollector(apiBase);
  }, [isAuthenticated, apiBase, managementKey, enabled]);
}
