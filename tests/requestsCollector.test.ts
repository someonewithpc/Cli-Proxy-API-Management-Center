import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { apiClient } from '../src/services/api/client';
import { usageQueueApi, type UsageAttempt } from '../src/services/api/usageQueue';
import { requestStore } from '../src/services/storage/requestStore';
import { startCollector, useCollectorStore } from '../src/features/requests/collector';

const attempt = (id: string, seq: number) => ({ executionId: id, seq }) as UsageAttempt;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const restores: Array<{ mockRestore: () => void }> = [];
const globals = globalThis as { indexedDB?: unknown };
let stop: () => void = () => {};

beforeEach(() => {
  globals.indexedDB = {};
  restores.push(spyOn(requestStore, 'prune').mockResolvedValue(0));
  useCollectorStore.setState({ status: 'off', lastPollAt: null, lastError: '', revision: 0 });
});

afterEach(() => {
  stop();
  delete globals.indexedDB;
  restores.splice(0).forEach((spy) => spy.mockRestore());
});

describe('usage queue collector', () => {
  test('keeps draining while full pages come back, then stores them under the scope', async () => {
    const pages = [
      { received: 500, attempts: [attempt('a', 0)] },
      { received: 1, attempts: [attempt('b', 0)] },
    ];
    const pop = spyOn(usageQueueApi, 'pop').mockImplementation(async () => pages.shift()!);
    const put = spyOn(requestStore, 'put').mockResolvedValue(undefined);
    restores.push(pop, put);

    stop = startCollector('http://cpa.test', 60_000);
    await flush();

    expect(pop).toHaveBeenCalledTimes(2);
    expect(put.mock.calls.map((call) => call[0])).toEqual(['http://cpa.test', 'http://cpa.test']);
    // Seq continues across pages so attempts with equal timestamps keep queue order.
    expect(put.mock.calls[1][1][0].seq).toBe(500);
    expect(useCollectorStore.getState().status).toBe('live');
    expect(useCollectorStore.getState().revision).toBe(1);
  });

  test('a missing queue route stops polling and reports it', async () => {
    const pop = spyOn(usageQueueApi, 'pop').mockRejectedValue({ status: 404 });
    restores.push(pop);
    stop = startCollector('http://cpa.test', 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pop).toHaveBeenCalledTimes(1);
    expect(useCollectorStore.getState().status).toBe('unsupported');
  });

  test('records popped before a connection switch still land in the old scope', async () => {
    const put = spyOn(requestStore, 'put').mockResolvedValue(undefined);
    const pop = spyOn(usageQueueApi, 'pop').mockImplementation(async () => {
      apiClient.setConfig({ apiBase: 'http://other.test', managementKey: 'k2' });
      return { received: 1, attempts: [attempt('late', 0)] };
    });
    restores.push(pop, put);
    apiClient.setConfig({ apiBase: 'http://cpa.test', managementKey: 'k1' });

    stop = startCollector('http://cpa.test', 60_000);
    await flush();

    expect(put).toHaveBeenCalledWith('http://cpa.test', [attempt('late', 0)]);
    expect(useCollectorStore.getState().status).toBe('starting');
    apiClient.setConfig({ apiBase: '', managementKey: '' });
  });

  test('the layout mounts the collector app-wide', () => {
    const layout = readFileSync('src/components/layout/MainLayout.tsx', 'utf8');
    expect(layout).toContain('useRequestsCollector();');
  });
});
