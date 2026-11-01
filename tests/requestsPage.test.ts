import { afterAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import en from '../src/i18n/locales/en.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';
import ru from '../src/i18n/locales/ru.json';
import vi from '../src/i18n/locales/vi.json';
import ko from '../src/i18n/locales/ko.json';
import tr from '../src/i18n/locales/tr.json';
import {
  isUsageStatisticsDisabled,
  normalizeUsageQueue,
  type CredentialDirectory,
} from '../src/services/api/usageQueue';
import { DEFAULT_FILTERS, groupTraces } from '../src/features/requests/logic';
import {
  RequestsPage,
  RequestsView,
  type RequestsViewProps,
} from '../src/features/requests/RequestsPage';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const SECRET_BAD = 'sk-ant-api03-badbadbadbadbadbad-XYZ1';
const SECRET_GOOD = 'sk-ant-api03-goodgoodgoodgood-WXY2';
const iso = (offsetMs: number) => new Date(NOW - offsetMs).toISOString();

const record = (overrides: Record<string, unknown>) => ({
  trace_id: 't1',
  request_id: 't1',
  auth_type: 'apikey',
  api_key: 'sk-client-proxy-key-0001',
  alias: 'claude-opus-5-5-api',
  model: 'claude-opus-5-5',
  latency_ms: 40,
  ttft_ms: 20,
  tokens: { total_tokens: 12 },
  ...overrides,
});

const RAW = [
  record({
    timestamp: iso(5000),
    execution_id: 'e1',
    auth_index: 'api',
    source: SECRET_BAD,
    failed: true,
    fail: {
      status_code: 400,
      body: '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}',
    },
  }),
  record({
    timestamp: iso(4990),
    execution_id: 'e2',
    auth_index: 'work',
    source: 'work@example.com',
    failed: false,
    fail: { status_code: 200, body: '' },
  }),
  JSON.stringify(
    record({
      trace_id: 't2',
      timestamp: iso(2000),
      execution_id: 'e3',
      auth_index: 'gone',
      source: SECRET_GOOD,
      failed: false,
      fail: { status_code: 200, body: '' },
    })
  ),
];

const DIRECTORY: CredentialDirectory = {
  api: {
    label: 'anthropic-api',
    detail: 'sk-…aaaa',
    kind: 'apiKey',
    family: 'claude',
    priority: 30,
  },
  work: { label: 'work@example.com', detail: '', kind: 'oauth', family: 'claude', priority: 20 },
};

const props = (overrides: Partial<RequestsViewProps> = {}): RequestsViewProps => ({
  server: 'http://127.0.0.1:8317',
  enabled: true,
  status: 'live',
  lastPollAt: NOW,
  lastError: '',
  usageDisabled: false,
  traces: groupTraces(normalizeUsageQueue(RAW)),
  storedCount: 3,
  directory: DIRECTORY,
  filters: DEFAULT_FILTERS,
  nowMs: NOW,
  onToggle: () => {},
  onFiltersChange: () => {},
  onClear: () => {},
  ...overrides,
});

const render = (overrides?: Partial<RequestsViewProps>) =>
  renderToStaticMarkup(createElement(RequestsView, props(overrides)));

const initialLanguage = i18n.language;
afterAll(async () => {
  await i18n.changeLanguage(initialLanguage);
});

describe('requests page rendering', () => {
  test('renders paths, credentials and recent requests without secrets', async () => {
    await i18n.changeLanguage('en');
    const html = render();
    expect(html).toContain('Paths');
    expect(html).toContain('claude-opus-5-5-api');
    expect(html).toContain('anthropic-api');
    expect(html).toContain('work@example.com');
    expect(html).toContain('Your credit balance is too low');
    expect(html).toContain('Path: anthropic-api: failed with 400, work@example.com: served');
    // Unknown auth index falls back to the masked source.
    expect(html).toContain('sk-…WXY2');
    expect(html).toContain('50%');
    expect(html).toContain('Why attempts failed');
    expect(html).not.toContain(SECRET_BAD);
    expect(html).not.toContain(SECRET_GOOD);
    expect(html).not.toContain('sk-client-proxy-key');
  });

  test('uses real buttons and native hidden for expandable attempts', async () => {
    await i18n.changeLanguage('en');
    const html = render();
    expect(html).toMatch(
      /<button type="button"[^>]*aria-expanded="false"[^>]*aria-controls="request-t1"/
    );
    expect(html).toMatch(/<tr id="request-t1"[^>]*hidden=""/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>24 h</);
    expect(html).toMatch(/<input type="checkbox"[^>]*checked=""/);
    expect(html).not.toContain('class="disabled"');
  });

  test('explains the destructive queue read and the backend hints', async () => {
    await i18n.changeLanguage('en');
    const html = render({ status: 'unsupported', usageDisabled: true, traces: [], storedCount: 0 });
    expect(html).toContain('Reading removes records from the queue');
    expect(html).toContain('answered 404');
    expect(html).toContain('Usage statistics are off');
    expect(html).toContain('No requests yet');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*><span>Clear history/);
  });

  test('a paused collector says how to resume', async () => {
    await i18n.changeLanguage('en');
    const html = render({ enabled: false, status: 'off', traces: [], storedCount: 0 });
    expect(html).toContain('Collection paused');
    expect(html).toContain('Turn on Collect requests');
  });

  test('the page renders its empty state before storage loads', async () => {
    await i18n.changeLanguage('en');
    const html = renderToStaticMarkup(createElement(RequestsPage));
    expect(html).toContain('Requests');
    expect(html).toContain('No requests yet');
  });

  test('every locale defines the same requests keys', () => {
    const keys = (locale: { requests: Record<string, string> }) =>
      Object.keys(locale.requests).sort();
    const expected = keys(en);
    for (const locale of [zhCN, zhTW, ru, vi, ko, tr]) expect(keys(locale)).toEqual(expected);
  });
});

describe('usage statistics flag', () => {
  test('an omitted flag reads as off, an empty config as unknown', () => {
    expect(
      isUsageStatisticsDisabled({ observability: { usage: { 'usage-statistics-enabled': true } } })
    ).toBe(false);
    expect(isUsageStatisticsDisabled({ routing: {} })).toBe(true);
    expect(isUsageStatisticsDisabled({})).toBe(false);
    expect(isUsageStatisticsDisabled(undefined)).toBe(false);
  });
});
