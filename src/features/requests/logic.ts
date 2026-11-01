/**
 * Request history view model: attempts grouped into traces, filtered, and aggregated into the
 * paths each requested model took through the credential tiers.
 */

import type { CredentialDirectory, CredentialKind, UsageAttempt } from '@/services/api/usageQueue';

export const TIME_RANGES = ['1h', '24h', '7d'] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

const HOUR_MS = 60 * 60 * 1000;
export const TIME_RANGE_MS: Record<TimeRange, number> = {
  '1h': HOUR_MS,
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
};

export const OUTCOME_FILTERS = ['all', 'served', 'failed'] as const;
export type OutcomeFilter = (typeof OUTCOME_FILTERS)[number];

export interface RequestFilters {
  range: TimeRange;
  /** Requested model; '' matches every model. */
  model: string;
  /** Credential key; '' matches every credential. */
  credential: string;
  outcome: OutcomeFilter;
}

export const DEFAULT_FILTERS: RequestFilters = {
  range: '24h',
  model: '',
  credential: '',
  outcome: 'all',
};

/** Number of credential tones the stylesheet defines. */
export const TONE_COUNT = 8;

export const credentialKey = (attempt: UsageAttempt): string =>
  attempt.authIndex || (attempt.source ? `source:${attempt.source}` : 'unknown');

export interface ResolvedCredential {
  key: string;
  label: string;
  detail: string;
  kind: CredentialKind | null;
  family: string;
  priority: number | null;
  known: boolean;
}

/** Display info for a credential key; unknown indexes fall back to the masked source. */
export function resolveCredential(
  directory: CredentialDirectory,
  key: string,
  fallbackSource = ''
): ResolvedCredential {
  const info = directory[key];
  if (info) return { key, ...info, known: true };
  const source = key.startsWith('source:') ? key.slice('source:'.length) : fallbackSource;
  return {
    key,
    label: source || key,
    detail: source && !key.startsWith('source:') ? key : '',
    kind: null,
    family: '',
    priority: null,
    known: false,
  };
}

export interface RequestTrace {
  id: string;
  startedAt: number;
  requestedModel: string;
  /** Upstream model of the serving attempt, else of the last attempt. */
  upstreamModel: string;
  attempts: UsageAttempt[];
  outcome: 'served' | 'failed';
  /** Credential key that served the request. */
  servedBy: string | null;
  failovers: number;
  latencyMs: number;
  tokens: number;
}

const byAttemptOrder = (a: UsageAttempt, b: UsageAttempt) =>
  a.timestamp - b.timestamp || a.seq - b.seq;

/** Traces newest first; attempts inside a trace oldest first. */
export function groupTraces(attempts: readonly UsageAttempt[]): RequestTrace[] {
  const groups = new Map<string, UsageAttempt[]>();
  for (const attempt of attempts) {
    const id = attempt.traceId || attempt.executionId;
    const group = groups.get(id);
    if (group) group.push(attempt);
    else groups.set(id, [attempt]);
  }

  const traces: RequestTrace[] = [];
  for (const [id, group] of groups) {
    const ordered = [...group].sort(byAttemptOrder);
    const served = [...ordered].reverse().find((attempt) => !attempt.failed) ?? null;
    const last = ordered[ordered.length - 1];
    const first = ordered[0];
    traces.push({
      id,
      startedAt: first.timestamp,
      requestedModel: first.requestedModel || last.requestedModel,
      upstreamModel: (served ?? last).upstreamModel,
      attempts: ordered,
      outcome: served ? 'served' : 'failed',
      servedBy: served ? credentialKey(served) : null,
      failovers: ordered.length - 1,
      latencyMs: ordered.reduce((sum, attempt) => sum + attempt.latencyMs, 0),
      tokens: ordered.reduce((sum, attempt) => sum + attempt.tokens.total, 0),
    });
  }
  return traces.sort((a, b) => b.startedAt - a.startedAt);
}

export function filterTraces(
  traces: readonly RequestTrace[],
  filters: RequestFilters,
  nowMs: number
): RequestTrace[] {
  const from = nowMs - TIME_RANGE_MS[filters.range];
  return traces.filter(
    (trace) =>
      trace.startedAt >= from &&
      (!filters.model || trace.requestedModel === filters.model) &&
      (!filters.credential ||
        trace.attempts.some((attempt) => credentialKey(attempt) === filters.credential)) &&
      (filters.outcome === 'all' || trace.outcome === filters.outcome)
  );
}

export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface PathStep {
  credential: string;
  /** Masked source, for credentials the directory does not know. */
  source: string;
  ok: boolean;
  status: number;
}

export interface PathAggregate {
  signature: string;
  steps: PathStep[];
  count: number;
  /** Fraction of the model's traces, 0..1. */
  share: number;
  medianLatencyMs: number;
  outcome: 'served' | 'failed';
}

export interface ModelPaths {
  model: string;
  total: number;
  served: number;
  paths: PathAggregate[];
}

export const traceSteps = (trace: RequestTrace): PathStep[] =>
  trace.attempts.map((attempt) => ({
    credential: credentialKey(attempt),
    source: attempt.source,
    ok: !attempt.failed,
    status: attempt.statusCode,
  }));

const stepsSignature = (steps: readonly PathStep[]): string =>
  steps.map((step) => `${step.credential}:${step.ok ? 'ok' : step.status}`).join('>');

/** Per requested model, each distinct sequence of credentials and outcomes, most common first. */
export function aggregatePaths(traces: readonly RequestTrace[]): ModelPaths[] {
  const models = new Map<string, Map<string, { steps: PathStep[]; traces: RequestTrace[] }>>();
  for (const trace of traces) {
    const steps = traceSteps(trace);
    const signature = stepsSignature(steps);
    let paths = models.get(trace.requestedModel);
    if (!paths) {
      paths = new Map();
      models.set(trace.requestedModel, paths);
    }
    const path = paths.get(signature);
    if (path) path.traces.push(trace);
    else paths.set(signature, { steps, traces: [trace] });
  }

  return [...models.entries()]
    .map(([model, paths]) => {
      const total = [...paths.values()].reduce((sum, path) => sum + path.traces.length, 0);
      return {
        model,
        total,
        served: [...paths.values()].reduce(
          (sum, path) => sum + path.traces.filter((trace) => trace.outcome === 'served').length,
          0
        ),
        paths: [...paths.entries()]
          .map(([signature, path]) => ({
            signature,
            steps: path.steps,
            count: path.traces.length,
            share: path.traces.length / total,
            medianLatencyMs: median(path.traces.map((trace) => trace.latencyMs)),
            outcome: path.traces[0].outcome,
          }))
          .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature)),
      };
    })
    .sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
}

export interface ReasonCount {
  status: number;
  /** Upstream error message; '' when the body carried none. */
  reason: string;
  count: number;
}

export interface CredentialAggregate {
  credential: string;
  source: string;
  attempts: number;
  served: number;
  failed: number;
  failures: ReasonCount[];
  tokens: number;
}

const reasonKey = (attempt: UsageAttempt) => `${attempt.statusCode}|${attempt.errorMessage}`;

const tallyReasons = (attempts: readonly UsageAttempt[]): ReasonCount[] => {
  const reasons = new Map<string, ReasonCount>();
  for (const attempt of attempts) {
    const key = reasonKey(attempt);
    const entry = reasons.get(key);
    if (entry) entry.count += 1;
    else {
      reasons.set(key, { status: attempt.statusCode, reason: attempt.errorMessage, count: 1 });
    }
  }
  return [...reasons.values()].sort((a, b) => b.count - a.count || a.status - b.status);
};

export function aggregateCredentials(traces: readonly RequestTrace[]): CredentialAggregate[] {
  const byCredential = new Map<string, UsageAttempt[]>();
  for (const trace of traces) {
    for (const attempt of trace.attempts) {
      const key = credentialKey(attempt);
      const list = byCredential.get(key);
      if (list) list.push(attempt);
      else byCredential.set(key, [attempt]);
    }
  }
  return [...byCredential.entries()]
    .map(([credential, attempts]) => {
      const failures = attempts.filter((attempt) => attempt.failed);
      return {
        credential,
        source: attempts[0].source,
        attempts: attempts.length,
        served: attempts.length - failures.length,
        failed: failures.length,
        failures: tallyReasons(failures),
        tokens: attempts.reduce((sum, attempt) => sum + attempt.tokens.total, 0),
      };
    })
    .sort((a, b) => b.attempts - a.attempts || a.credential.localeCompare(b.credential));
}

export interface FailoverReason extends ReasonCount {
  credentials: string[];
  /** Failures another credential then picked up. */
  recovered: number;
}

/** Every failed attempt grouped by status and upstream message. */
export function aggregateFailoverReasons(traces: readonly RequestTrace[]): FailoverReason[] {
  const reasons = new Map<string, FailoverReason & { credentialSet: Set<string> }>();
  for (const trace of traces) {
    trace.attempts.forEach((attempt, index) => {
      if (!attempt.failed) return;
      const key = reasonKey(attempt);
      let entry = reasons.get(key);
      if (!entry) {
        entry = {
          status: attempt.statusCode,
          reason: attempt.errorMessage,
          count: 0,
          credentials: [],
          recovered: 0,
          credentialSet: new Set(),
        };
        reasons.set(key, entry);
      }
      entry.count += 1;
      entry.credentialSet.add(credentialKey(attempt));
      const recovered =
        trace.outcome === 'served' && trace.attempts.slice(index + 1).some((next) => !next.failed);
      if (recovered) entry.recovered += 1;
    });
  }
  return [...reasons.values()]
    .map(({ credentialSet, ...entry }) => ({ ...entry, credentials: [...credentialSet] }))
    .sort((a, b) => b.count - a.count || a.status - b.status);
}

/**
 * A stable tone per credential: configured credentials in priority order first, so the same
 * credential keeps its color across filters; unknown ones follow in key order.
 */
export function assignTones(
  directory: CredentialDirectory,
  seen: Iterable<string>
): Record<string, number> {
  const configured = Object.entries(directory)
    .sort(
      ([keyA, a], [keyB, b]) =>
        b.priority - a.priority || a.label.localeCompare(b.label) || keyA.localeCompare(keyB)
    )
    .map(([key]) => key);
  const known = new Set(configured);
  const extra = [...new Set(seen)].filter((key) => !known.has(key)).sort();
  const tones: Record<string, number> = {};
  [...configured, ...extra].forEach((key, index) => {
    tones[key] = index % TONE_COUNT;
  });
  return tones;
}

export interface FilterOptions {
  models: string[];
  credentials: string[];
}

export function filterOptions(traces: readonly RequestTrace[]): FilterOptions {
  const models = new Set<string>();
  const credentials = new Set<string>();
  for (const trace of traces) {
    if (trace.requestedModel) models.add(trace.requestedModel);
    for (const attempt of trace.attempts) credentials.add(credentialKey(attempt));
  }
  return { models: [...models].sort(), credentials: [...credentials].sort() };
}
