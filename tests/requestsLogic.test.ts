import { describe, expect, test } from 'bun:test';
import type { CredentialDirectory, UsageAttempt } from '../src/services/api/usageQueue';
import {
  aggregateCredentials,
  aggregateFailoverReasons,
  aggregatePaths,
  assignTones,
  DEFAULT_FILTERS,
  filterOptions,
  filterTraces,
  groupTraces,
  median,
  resolveCredential,
} from '../src/features/requests/logic';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const CREDIT = 'Your credit balance is too low to access the Anthropic API.';

let counter = 0;
function attempt(overrides: Partial<UsageAttempt>): UsageAttempt {
  counter += 1;
  return {
    executionId: `exec-${counter}`,
    traceId: `trace-${counter}`,
    timestamp: NOW - 60_000,
    seq: 0,
    authIndex: 'api',
    authType: 'apikey',
    source: 'sk-…aaaa',
    requestedModel: 'claude-opus-5-5-api',
    upstreamModel: 'claude-opus-5-5',
    responseModel: '',
    provider: 'claude',
    endpoint: 'POST /v1/messages',
    failed: false,
    statusCode: 200,
    errorMessage: '',
    errorBody: '',
    latencyMs: 100,
    ttftMs: 50,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cached: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total: 10,
    },
    stream: false,
    clientKey: 'sk-…0001',
    sessionId: '',
    reasoningEffort: '',
    serviceTier: '',
    ...overrides,
  };
}

/** API key fails on credit, the work subscription serves. */
function failover(traceId: string, timestamp: number, latency = 100): UsageAttempt[] {
  return [
    attempt({
      traceId,
      timestamp: timestamp + 5,
      authIndex: 'work',
      source: 'work@example.com',
      latencyMs: latency,
    }),
    attempt({
      traceId,
      timestamp,
      authIndex: 'api',
      failed: true,
      statusCode: 400,
      errorMessage: CREDIT,
      latencyMs: 10,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cached: 0,
        cacheRead: 0,
        cacheCreation: 0,
        total: 0,
      },
    }),
  ];
}

const DIRECTORY: CredentialDirectory = {
  api: {
    label: 'anthropic-api',
    detail: 'sk-…aaaa',
    kind: 'apiKey',
    family: 'claude',
    priority: 30,
  },
  work: { label: 'work@example.com', detail: '', kind: 'oauth', family: 'claude', priority: 20 },
  personal: { label: 'me@example.com', detail: '', kind: 'oauth', family: 'claude', priority: 10 },
};

describe('trace grouping', () => {
  test('orders attempts by time and marks the serving credential', () => {
    const [trace] = groupTraces(failover('t1', NOW - 1000));
    expect(trace.attempts.map((item) => item.authIndex)).toEqual(['api', 'work']);
    expect(trace.outcome).toBe('served');
    expect(trace.servedBy).toBe('work');
    expect(trace.failovers).toBe(1);
    expect(trace.latencyMs).toBe(110);
    expect(trace.startedAt).toBe(NOW - 1000);
  });

  test('breaks timestamp ties by queue position and lists newest traces first', () => {
    const tied = [
      attempt({ traceId: 'tie', timestamp: NOW - 10, seq: 1, authIndex: 'b' }),
      attempt({ traceId: 'tie', timestamp: NOW - 10, seq: 0, authIndex: 'a', failed: true }),
    ];
    const traces = groupTraces([...failover('older', NOW - 5000), ...tied]);
    expect(traces.map((trace) => trace.id)).toEqual(['tie', 'older']);
    expect(traces[0].attempts.map((item) => item.authIndex)).toEqual(['a', 'b']);
  });

  test('a trace where every attempt failed has no serving credential', () => {
    const [trace] = groupTraces([
      attempt({ traceId: 'x', failed: true, statusCode: 429 }),
      attempt({ traceId: 'x', failed: true, statusCode: 429, timestamp: NOW - 59_000 }),
    ]);
    expect(trace.outcome).toBe('failed');
    expect(trace.servedBy).toBeNull();
  });
});

describe('filters', () => {
  const traces = groupTraces([
    ...failover('recent', NOW - 10 * 60_000),
    attempt({ traceId: 'old', timestamp: NOW - 3 * 60 * 60_000, authIndex: 'personal' }),
    attempt({ traceId: 'other', requestedModel: 'gpt-5', failed: true, statusCode: 500 }),
  ]);

  test('time range, model, credential and outcome narrow the traces', () => {
    const ids = (filters: Partial<typeof DEFAULT_FILTERS>) =>
      filterTraces(traces, { ...DEFAULT_FILTERS, ...filters }, NOW)
        .map((trace) => trace.id)
        .sort();
    expect(ids({ range: '1h' })).toEqual(['other', 'recent']);
    expect(ids({ range: '24h' })).toEqual(['old', 'other', 'recent']);
    expect(ids({ model: 'gpt-5' })).toEqual(['other']);
    expect(ids({ credential: 'api' })).toEqual(['other', 'recent']);
    expect(ids({ credential: 'personal' })).toEqual(['old']);
    expect(ids({ outcome: 'failed' })).toEqual(['other']);
  });

  test('options list each model and credential once', () => {
    expect(filterOptions(traces)).toEqual({
      models: ['claude-opus-5-5-api', 'gpt-5'],
      credentials: ['api', 'personal', 'work'],
    });
  });
});

describe('aggregates', () => {
  const traces = groupTraces([
    ...failover('f1', NOW - 4000, 100),
    ...failover('f2', NOW - 3000, 300),
    attempt({ traceId: 'd1', timestamp: NOW - 2000, authIndex: 'work', latencyMs: 80 }),
    attempt({ traceId: 'd2', requestedModel: 'gpt-5', authIndex: 'personal' }),
  ]);

  test('paths group identical credential sequences per requested model', () => {
    const [claude, gpt] = aggregatePaths(traces);
    expect(claude.model).toBe('claude-opus-5-5-api');
    expect(claude.total).toBe(3);
    expect(claude.served).toBe(3);
    expect(claude.paths).toHaveLength(2);
    const [first, second] = claude.paths;
    expect(first.steps).toEqual([
      { credential: 'api', ok: false, status: 400 },
      { credential: 'work', ok: true, status: 200 },
    ]);
    expect(first.count).toBe(2);
    expect(first.share).toBeCloseTo(2 / 3);
    expect(first.medianLatencyMs).toBe(210);
    expect(second.steps).toEqual([{ credential: 'work', ok: true, status: 200 }]);
    expect(gpt.paths[0].share).toBe(1);
  });

  test('credentials count attempts, served, failures by reason and tokens', () => {
    const byKey = Object.fromEntries(
      aggregateCredentials(traces).map((row) => [row.credential, row])
    );
    expect(byKey.api).toMatchObject({ attempts: 2, served: 0, failed: 2, tokens: 0 });
    expect(byKey.api.failures).toEqual([{ status: 400, reason: CREDIT, count: 2 }]);
    expect(byKey.work).toMatchObject({ attempts: 3, served: 3, failed: 0, tokens: 30 });
  });

  test('failover reasons note which failures another credential recovered', () => {
    expect(aggregateFailoverReasons(traces)).toEqual([
      { status: 400, reason: CREDIT, count: 2, credentials: ['api'], recovered: 2 },
    ]);
  });

  test('median handles odd, even and empty inputs', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('credential resolution', () => {
  test('known indexes use the directory; unknown ones fall back to the masked source', () => {
    expect(resolveCredential(DIRECTORY, 'api')).toMatchObject({
      label: 'anthropic-api',
      priority: 30,
      known: true,
    });
    expect(resolveCredential(DIRECTORY, 'gone', 'sk-…zzzz')).toMatchObject({
      label: 'sk-…zzzz',
      detail: 'gone',
      known: false,
    });
    expect(resolveCredential(DIRECTORY, 'source:old@example.com').label).toBe('old@example.com');
  });

  test('tones follow priority order and stay put when filters change', () => {
    const all = assignTones(DIRECTORY, ['work', 'stray']);
    expect(all).toEqual({ api: 0, work: 1, personal: 2, stray: 3 });
    expect(assignTones(DIRECTORY, []).work).toBe(all.work);
  });
});
