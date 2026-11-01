import { describe, expect, test } from 'bun:test';
import { REQUEST_RETENTION_MS, selectPruned } from '../src/services/storage/requestStore';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const at = (id: string, ageMs: number) => ({ id, timestamp: NOW - ageMs });

describe('request store pruning', () => {
  test('drops attempts older than seven days', () => {
    const entries = [
      at('old', REQUEST_RETENTION_MS + 1),
      at('edge', REQUEST_RETENTION_MS),
      at('new', 0),
    ];
    expect(selectPruned(entries, NOW).map((entry) => entry.id)).toEqual(['old']);
  });

  test('drops the oldest attempts beyond the cap', () => {
    const entries = [at('c', 3), at('a', 5), at('d', 1), at('b', 4)];
    expect(selectPruned(entries, NOW, REQUEST_RETENTION_MS, 2).map((entry) => entry.id)).toEqual([
      'a',
      'b',
    ]);
  });

  test('keeps everything inside the window and under the cap', () => {
    expect(selectPruned([at('a', 1), at('b', 2)], NOW)).toEqual([]);
  });
});
