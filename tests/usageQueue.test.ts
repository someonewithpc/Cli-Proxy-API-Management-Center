import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { apiClient } from '../src/services/api/client';
import {
  buildCredentialDirectory,
  extractErrorMessage,
  maskSecret,
  normalizeUsageQueue,
  normalizeUsageRecord,
  usageQueueApi,
} from '../src/services/api/usageQueue';

const TRACE = '01a19464-292d-7000-8000-000000000001';
const SECRET_BAD = 'sk-ant-api03-badbadbadbadbadbad-XYZ1';
const SECRET_GOOD = 'sk-ant-api03-goodgoodgoodgood-WXY2';
const CLIENT_KEY = 'sk-client-proxy-key-0001';

const failed = {
  timestamp: '2026-10-31T12:00:00.100Z',
  trace_id: TRACE,
  execution_id: 'exec-bad',
  request_id: TRACE,
  auth_index: 'ddc7d48e22485b44',
  auth_type: 'apikey',
  source: SECRET_BAD,
  api_key: CLIENT_KEY,
  alias: 'claude-opus-5-5-api',
  model: 'claude-opus-5-5',
  latency_ms: 12,
  ttft_ms: 12,
  failed: true,
  fail: {
    status_code: 400,
    body: JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Your credit balance is too low to access the Anthropic API.',
      },
    }),
  },
  tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
};

const served = {
  ...failed,
  timestamp: '2026-10-31T12:00:00.200Z',
  execution_id: 'exec-good',
  auth_index: 'e180c584b447a18d',
  source: SECRET_GOOD,
  failed: false,
  fail: { status_code: 200, body: '' },
  tokens: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, total_tokens: 15 },
};

const restores: Array<{ mockRestore: () => void }> = [];
afterEach(() => restores.splice(0).forEach((spy) => spy.mockRestore()));

describe('usage record normalization', () => {
  test('masks every secret before it leaves the API layer', () => {
    const attempts = normalizeUsageQueue([failed, served]);
    const serialized = JSON.stringify(attempts);
    expect(serialized).not.toContain(SECRET_BAD);
    expect(serialized).not.toContain(SECRET_GOOD);
    expect(serialized).not.toContain(CLIENT_KEY);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{4,}/);
    expect(attempts[0].source).toBe('sk-…XYZ1');
    expect(attempts[0].clientKey).toBe('sk-…0001');
  });

  test('keeps emails readable and masks short keys entirely', () => {
    expect(maskSecret('work@example.com')).toBe('work@example.com');
    expect(maskSecret('sk-bad')).toBe('sk-…');
    expect(maskSecret('abcdefgh')).toBe('…gh');
    expect(maskSecret('')).toBe('');
  });

  test('accepts JSON-encoded string items next to objects and drops junk', () => {
    const attempts = normalizeUsageQueue([JSON.stringify(failed), served, 'not json', 42, null]);
    expect(attempts.map((attempt) => attempt.executionId)).toEqual(['exec-bad', 'exec-good']);
    expect(attempts.map((attempt) => attempt.seq)).toEqual([0, 1]);
    expect(normalizeUsageQueue({ items: [] })).toEqual([]);
  });

  test('reads the requested model, status, upstream message and tokens', () => {
    const attempt = normalizeUsageRecord(failed)!;
    expect(attempt.traceId).toBe(TRACE);
    expect(attempt.requestedModel).toBe('claude-opus-5-5-api');
    expect(attempt.upstreamModel).toBe('claude-opus-5-5');
    expect(attempt.failed).toBe(true);
    expect(attempt.statusCode).toBe(400);
    expect(attempt.errorMessage).toBe(
      'Your credit balance is too low to access the Anthropic API.'
    );
    expect(attempt.timestamp).toBe(Date.parse('2026-10-31T12:00:00.100Z'));
    const ok = normalizeUsageRecord(served)!;
    expect(ok.errorBody).toBe('');
    expect(ok.tokens).toMatchObject({ input: 10, output: 5, cacheRead: 2, total: 15 });
  });

  test('truncates long fail bodies and falls back to the request id for traces', () => {
    const attempt = normalizeUsageRecord({
      ...failed,
      trace_id: '',
      execution_id: '',
      fail: { status_code: 502, body: 'x'.repeat(2000) },
    })!;
    expect(attempt.traceId).toBe(TRACE);
    expect(attempt.executionId.startsWith(TRACE)).toBe(true);
    expect(attempt.errorBody.length).toBeLessThanOrEqual(501);
    expect(attempt.errorMessage).toBe('');
  });

  test('extracts OpenAI-style and bare error messages', () => {
    expect(extractErrorMessage('{"error":{"message":"Rate limit reached"}}')).toBe(
      'Rate limit reached'
    );
    expect(extractErrorMessage('{"error":"quota exhausted"}')).toBe('quota exhausted');
    expect(extractErrorMessage('{"message":"bad gateway"}')).toBe('bad gateway');
    expect(extractErrorMessage('<html>502</html>')).toBe('');
  });
});

describe('usage queue requests', () => {
  test('pops through apiClient with a clamped count', async () => {
    const get = spyOn(apiClient, 'get').mockResolvedValue([served] as never);
    restores.push(get);
    const result = await usageQueueApi.pop(9999);
    expect(get).toHaveBeenCalledWith('/observability/usage/queue', { params: { count: 500 } });
    expect(result.received).toBe(1);
    expect(result.attempts[0].executionId).toBe('exec-good');
  });
});

describe('credential directory', () => {
  const RAW = {
    'api-keys': {
      claude: [
        {
          name: 'anthropic-api',
          priority: 30,
          keys: [{ 'api-key': SECRET_BAD, auth_index: 'ddc7d48e22485b44' }],
        },
        {
          name: 'pool',
          priority: 5,
          keys: [
            { 'api-key': 'sk-pool-aaaaaaaaaaaa1111', 'auth-index': 'p1' },
            { 'api-key': 'sk-pool-bbbbbbbbbbbb2222', auth_index: 'p2', priority: 7 },
          ],
        },
      ],
      'openai-compatibility': [
        { name: 'openrouter', priority: 1, keys: [{ 'api-key': 'or-key', auth_index: 'c1' }] },
      ],
    },
  };

  test('names config keys and credentials by auth index without exposing keys', () => {
    const directory = buildCredentialDirectory(RAW, [
      {
        name: 'work.json',
        type: 'claude',
        email: 'work@example.com',
        authIndex: 'w1',
        priority: 20,
      },
      { name: 'personal.json', type: 'claude', authIndex: 42, priority: 10 },
      { name: 'no-index.json', type: 'claude' },
    ]);
    expect(directory.ddc7d48e22485b44).toMatchObject({
      label: 'anthropic-api',
      kind: 'apiKey',
      family: 'claude',
      priority: 30,
    });
    expect(directory.p1).toMatchObject({ label: 'pool #1', priority: 5 });
    expect(directory.p2).toMatchObject({ label: 'pool #2', priority: 7 });
    expect(directory.c1).toMatchObject({ label: 'openrouter', kind: 'compat' });
    expect(directory.w1).toMatchObject({ label: 'work@example.com', kind: 'oauth', priority: 20 });
    expect(directory['42']).toMatchObject({ label: 'personal', detail: '' });
    expect(Object.keys(directory)).toHaveLength(6);
    expect(JSON.stringify(directory)).not.toContain(SECRET_BAD);
    expect(JSON.stringify(directory)).not.toContain('sk-pool-aaaa');
  });
});
