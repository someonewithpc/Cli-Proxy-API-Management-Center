/**
 * Usage queue API.
 *
 * `GET /observability/usage/queue` pops records: whatever this module reads is gone from the
 * backend. Each record is one upstream attempt; attempts of one inbound request share a trace id.
 * Raw records carry the upstream credential secret (`source` for API keys) and the client's proxy
 * key (`api_key`), so normalization masks both before anything leaves this module.
 */

import { apiClient } from './client';
import { authFilesApi } from './authFiles';
import { routingApi } from './routing';
import type { AuthFileItem } from '@/types/authFile';
import { ROUTING_COMPAT_FAMILY, ROUTING_KEY_FAMILIES } from '@/types/routing';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { isRecord } from '@/utils/helpers';

export const USAGE_QUEUE_MAX_COUNT = 500;
export const FAIL_BODY_LIMIT = 500;

export interface UsageTokens {
  input: number;
  output: number;
  reasoning: number;
  cached: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

export interface UsageAttempt {
  executionId: string;
  traceId: string;
  /** Epoch milliseconds. */
  timestamp: number;
  /** Position within the poll that delivered it; breaks timestamp ties. */
  seq: number;
  authIndex: string;
  authType: string;
  /** Masked credential identity; emails stay readable. */
  source: string;
  /** Model the client asked for. */
  requestedModel: string;
  /** Model sent upstream. */
  upstreamModel: string;
  responseModel: string;
  provider: string;
  endpoint: string;
  failed: boolean;
  statusCode: number;
  errorMessage: string;
  errorBody: string;
  latencyMs: number;
  ttftMs: number;
  tokens: UsageTokens;
  stream: boolean;
  /** Masked client proxy key. */
  clientKey: string;
  sessionId: string;
  reasoningEffort: string;
  serviceTier: string;
}

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const readNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return 0;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Keeps a recognisable tail without exposing enough to reuse the secret. */
export function maskSecret(value: string): string {
  const text = value.trim();
  if (!text) return '';
  if (EMAIL_PATTERN.test(text)) return text;
  const prefix = text.match(/^(sk|pk|rk)-/i)?.[0] ?? '';
  const rest = text.slice(prefix.length);
  if (rest.length >= 12) return `${prefix}…${rest.slice(-4)}`;
  if (rest.length >= 6) return `${prefix}…${rest.slice(-2)}`;
  return `${prefix}…`;
}

const truncate = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/** The upstream error message from an Anthropic- or OpenAI-style JSON body, else ''. */
export function extractErrorMessage(body: string): string {
  const text = body.trim();
  if (!text.startsWith('{')) return '';
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return '';
    const error = parsed.error;
    if (isRecord(error)) return readText(error.message);
    if (typeof error === 'string') return error.trim();
    return readText(parsed.message);
  } catch {
    return '';
  }
}

const readTokens = (value: unknown): UsageTokens => {
  const tokens = isRecord(value) ? value : {};
  return {
    input: readNumber(tokens.input_tokens),
    output: readNumber(tokens.output_tokens),
    reasoning: readNumber(tokens.reasoning_tokens),
    cached: readNumber(tokens.cached_tokens),
    cacheRead: readNumber(tokens.cache_read_tokens),
    cacheCreation: readNumber(tokens.cache_creation_tokens),
    total: readNumber(tokens.total_tokens),
  };
};

/** One queue item (an object or a JSON-encoded string) as an attempt, or null when unusable. */
export function normalizeUsageRecord(item: unknown, seq = 0): UsageAttempt | null {
  let record: unknown = item;
  if (typeof item === 'string') {
    try {
      record = JSON.parse(item);
    } catch {
      return null;
    }
  }
  if (!isRecord(record)) return null;

  const timestamp = Date.parse(readText(record.timestamp));
  if (!Number.isFinite(timestamp)) return null;
  const requestId = readText(record.request_id);
  const traceId = readText(record.trace_id) || requestId;
  const executionId =
    readText(record.execution_id) || (traceId ? `${traceId}:${timestamp}:${seq}` : '');
  if (!executionId) return null;

  const fail = isRecord(record.fail) ? record.fail : {};
  const failed = record.failed === true;
  const rawBody = typeof fail.body === 'string' ? fail.body : '';
  const upstreamModel = readText(record.model);

  return {
    executionId,
    traceId: traceId || executionId,
    timestamp,
    seq,
    authIndex: normalizeAuthIndex(record.auth_index) ?? '',
    authType: readText(record.auth_type),
    source: maskSecret(readText(record.source)),
    requestedModel: readText(record.alias) || upstreamModel,
    upstreamModel,
    responseModel: readText(record.response_model),
    provider: readText(record.provider),
    endpoint: readText(record.endpoint),
    failed,
    statusCode: readNumber(fail.status_code),
    errorMessage: failed ? truncate(extractErrorMessage(rawBody), FAIL_BODY_LIMIT) : '',
    errorBody: failed ? truncate(rawBody.trim(), FAIL_BODY_LIMIT) : '',
    latencyMs: readNumber(record.latency_ms),
    ttftMs: readNumber(record.ttft_ms),
    tokens: readTokens(record.tokens),
    stream: record.stream === true,
    clientKey: maskSecret(readText(record.api_key)),
    sessionId: readText(record.session_id),
    reasoningEffort: readText(record.reasoning_effort),
    serviceTier: readText(record.service_tier),
  };
}

export function normalizeUsageQueue(response: unknown): UsageAttempt[] {
  if (!Array.isArray(response)) return [];
  return response.flatMap((item, index) => normalizeUsageRecord(item, index) ?? []);
}

/* ---------------------------------------------------------------------------------------------
 * Credential directory
 * ------------------------------------------------------------------------------------------- */

export type CredentialKind = 'apiKey' | 'compat' | 'oauth';

export interface CredentialInfo {
  label: string;
  /** Masked key or file name that tells two same-named credentials apart. */
  detail: string;
  kind: CredentialKind;
  family: string;
  priority: number;
}

export type CredentialDirectory = Record<string, CredentialInfo>;

const readInteger = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
};

const readAuthIndex = (record: Record<string, unknown>): string | null =>
  normalizeAuthIndex(record.auth_index ?? record['auth-index']);

const configGroups = (raw: unknown, family: string): Record<string, unknown>[] => {
  const apiKeys = isRecord(raw) ? raw['api-keys'] : undefined;
  const groups = isRecord(apiKeys) ? apiKeys[family] : undefined;
  return Array.isArray(groups) ? groups.filter(isRecord) : [];
};

const stripJsonExtension = (name: string): string =>
  name.toLowerCase().endsWith('.json') ? name.slice(0, -5) : name;

/** auth_index → display info, from the stored config and the credential list. */
export function buildCredentialDirectory(
  raw: unknown,
  files: readonly AuthFileItem[]
): CredentialDirectory {
  const directory: CredentialDirectory = {};

  for (const family of [...ROUTING_KEY_FAMILIES, ROUTING_COMPAT_FAMILY]) {
    const kind: CredentialKind = family === ROUTING_COMPAT_FAMILY ? 'compat' : 'apiKey';
    configGroups(raw, family).forEach((group, groupIndex) => {
      const keys = Array.isArray(group.keys) ? group.keys.filter(isRecord) : [];
      const groupName = readText(group.name) || `${family} #${groupIndex + 1}`;
      keys.forEach((key, keyIndex) => {
        const authIndex = readAuthIndex(key);
        if (!authIndex) return;
        const masked = maskSecret(readText(key['api-key']));
        directory[authIndex] = {
          label: keys.length > 1 ? `${groupName} #${keyIndex + 1}` : groupName,
          detail: masked,
          kind,
          family,
          priority: readInteger(key.priority) ?? readInteger(group.priority) ?? 0,
        };
      });
    });
  }

  for (const file of files) {
    const authIndex = normalizeAuthIndex(file.authIndex);
    if (!authIndex) continue;
    const base = stripJsonExtension(readText(file.name));
    const label = readText(file.email) || readText(file.projectId) || base || authIndex;
    directory[authIndex] = {
      label,
      detail: label === base ? '' : base,
      kind: 'oauth',
      family: readText(file.type) || readText(file.provider) || 'unknown',
      priority: readInteger(file.priority) ?? 0,
    };
  }

  return directory;
}

export const usageQueueApi = {
  /** Removes up to `count` of the oldest records from the backend queue and returns them. */
  async pop(
    count: number,
    client = apiClient
  ): Promise<{ received: number; attempts: UsageAttempt[] }> {
    const safeCount = Math.max(1, Math.min(USAGE_QUEUE_MAX_COUNT, Math.floor(count) || 1));
    const response = await client.get<unknown>('/observability/usage/queue', {
      params: { count: safeCount },
    });
    return {
      received: Array.isArray(response) ? response.length : 0,
      attempts: normalizeUsageQueue(response),
    };
  },

  async loadDirectory(): Promise<CredentialDirectory> {
    const [raw, files] = await Promise.all([
      routingApi.getRawConfig(),
      authFilesApi.list().then((response) => (Array.isArray(response.files) ? response.files : [])),
    ]);
    return buildCredentialDirectory(raw, files);
  },
};
