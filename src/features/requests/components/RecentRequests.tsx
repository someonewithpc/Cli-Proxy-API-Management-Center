import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown } from '@/components/ui/icons';
import type { CredentialDirectory } from '@/services/api/usageQueue';
import { credentialKey, resolveCredential, traceSteps, type RequestTrace } from '../logic';
import { formatCount, formatDateTime, formatLatency } from '../format';
import { CredentialSwatch, Route } from './Route';
import styles from '../RequestsPage.module.scss';

export const RECENT_LIMIT = 100;

interface RecentRequestsProps {
  traces: readonly RequestTrace[];
  directory: CredentialDirectory;
  tones: Record<string, number>;
  nowMs: number;
}

export function RecentRequests({ traces, directory, tones, nowMs }: RecentRequestsProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const shown = traces.slice(0, RECENT_LIMIT);

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className={styles.section} aria-labelledby="requests-recent-title">
      <header className={styles.sectionHeader}>
        <h2 id="requests-recent-title" className={styles.sectionTitle}>
          {t('requests.recent_title')}
        </h2>
        {traces.length > shown.length && (
          <p className={styles.sectionDesc}>
            {t('requests.recent_more', {
              shown: formatCount(shown.length, locale),
              total: formatCount(traces.length, locale),
            })}
          </p>
        )}
      </header>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('requests.col_time')}</th>
              <th scope="col">{t('requests.col_model')}</th>
              <th scope="col">{t('requests.col_path')}</th>
              <th scope="col" className={styles.numeric}>
                {t('requests.col_latency')}
              </th>
              <th scope="col" className={styles.numeric}>
                {t('requests.col_tokens')}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((trace) => {
              const open = expanded.has(trace.id);
              const detailId = `request-${trace.id}`;
              const remapped = trace.upstreamModel && trace.upstreamModel !== trace.requestedModel;
              return (
                <Fragment key={trace.id}>
                  <tr className={styles.traceRow} data-outcome={trace.outcome}>
                    <td>
                      <button
                        type="button"
                        className={styles.expandButton}
                        aria-expanded={open}
                        aria-controls={detailId}
                        aria-label={t(open ? 'requests.hide_attempts' : 'requests.show_attempts')}
                        onClick={() => toggle(trace.id)}
                      >
                        <IconChevronDown size={14} />
                        <time dateTime={new Date(trace.startedAt).toISOString()}>
                          {formatDateTime(trace.startedAt, nowMs, locale)}
                        </time>
                      </button>
                    </td>
                    <td className={styles.modelCell}>
                      <span>{trace.requestedModel || t('requests.unknown_model')}</span>
                      {remapped && (
                        <span className={styles.upstreamModel}>
                          {t('requests.upstream_model', { model: trace.upstreamModel })}
                        </span>
                      )}
                    </td>
                    <td>
                      <Route
                        steps={traceSteps(trace)}
                        directory={directory}
                        tones={tones}
                        size="sm"
                      />
                    </td>
                    <td className={styles.numeric}>{formatLatency(trace.latencyMs, locale)}</td>
                    <td className={styles.numeric}>{formatCount(trace.tokens, locale)}</td>
                  </tr>
                  <tr id={detailId} className={styles.detailRow} hidden={!open}>
                    <td colSpan={5}>
                      <ol className={styles.attemptList}>
                        {trace.attempts.map((attempt) => {
                          const key = credentialKey(attempt);
                          const credential = resolveCredential(directory, key, attempt.source);
                          return (
                            <li
                              key={attempt.executionId}
                              className={styles.attempt}
                              data-state={attempt.failed ? 'fail' : 'ok'}
                            >
                              <span className={styles.attemptWho}>
                                <CredentialSwatch tone={tones[key] ?? 0} />
                                <span className={styles.credentialLabel}>{credential.label}</span>
                                {credential.detail && (
                                  <span className={styles.credentialMeta}>{credential.detail}</span>
                                )}
                              </span>
                              <span
                                className={styles.statusCode}
                                data-state={attempt.failed ? 'fail' : 'ok'}
                              >
                                {attempt.statusCode || '?'}
                              </span>
                              <span className={styles.attemptTimes}>
                                <span>
                                  {t('requests.attempt_latency', {
                                    value: formatLatency(attempt.latencyMs, locale),
                                  })}
                                </span>
                                <span>
                                  {t('requests.attempt_ttft', {
                                    value: formatLatency(attempt.ttftMs, locale),
                                  })}
                                </span>
                                {attempt.upstreamModel && <span>{attempt.upstreamModel}</span>}
                              </span>
                              {attempt.failed && (
                                <span className={styles.attemptError}>
                                  {attempt.errorMessage ||
                                    attempt.errorBody ||
                                    t('requests.no_message')}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ol>
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
