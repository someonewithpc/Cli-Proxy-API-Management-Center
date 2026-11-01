import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useNow } from '@/hooks/useNow';
import {
  isUsageStatisticsDisabled,
  usageQueueApi,
  type CredentialDirectory,
  type UsageAttempt,
} from '@/services/api/usageQueue';
import {
  isRequestStoreAvailable,
  REQUEST_RETENTION_MS,
  requestStore,
} from '@/services/storage/requestStore';
import { useAuthStore, useConfigStore } from '@/stores';
import { clearCollectedRequests, useCollectorStore, type CollectorStatus } from './collector';
import {
  aggregateCredentials,
  aggregateFailoverReasons,
  aggregatePaths,
  assignTones,
  DEFAULT_FILTERS,
  filterOptions,
  filterTraces,
  groupTraces,
  OUTCOME_FILTERS,
  resolveCredential,
  TIME_RANGES,
  type RequestFilters,
  type RequestTrace,
} from './logic';
import { formatClock, formatCount } from './format';
import { CredentialsSection } from './components/CredentialsSection';
import { PathsSection } from './components/PathsSection';
import { RecentRequests } from './components/RecentRequests';
import styles from './RequestsPage.module.scss';

export interface RequestsViewProps {
  server: string;
  enabled: boolean;
  status: CollectorStatus;
  lastPollAt: number | null;
  lastError: string;
  usageDisabled: boolean;
  traces: readonly RequestTrace[];
  storedCount: number;
  directory: CredentialDirectory;
  filters: RequestFilters;
  nowMs: number;
  onToggle: (enabled: boolean) => void;
  onFiltersChange: (filters: RequestFilters) => void;
  onClear: () => void;
}

const STATUS_KEYS: Record<CollectorStatus, string> = {
  off: 'requests.status_off',
  starting: 'requests.status_starting',
  live: 'requests.status_live',
  error: 'requests.status_error',
  unsupported: 'requests.status_unsupported',
  'no-storage': 'requests.status_no_storage',
};

export function RequestsView({
  server,
  enabled,
  status,
  lastPollAt,
  lastError,
  usageDisabled,
  traces,
  storedCount,
  directory,
  filters,
  nowMs,
  onToggle,
  onFiltersChange,
  onClear,
}: RequestsViewProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [confirmClear, setConfirmClear] = useState(false);

  const options = useMemo(() => filterOptions(traces), [traces]);
  const tones = useMemo(() => assignTones(directory, options.credentials), [directory, options]);
  const visible = useMemo(() => filterTraces(traces, filters, nowMs), [traces, filters, nowMs]);
  const paths = useMemo(() => aggregatePaths(visible), [visible]);
  const credentials = useMemo(() => aggregateCredentials(visible), [visible]);
  const reasons = useMemo(() => aggregateFailoverReasons(visible), [visible]);

  const setFilter = <K extends keyof RequestFilters>(key: K, value: RequestFilters[K]) =>
    onFiltersChange({ ...filters, [key]: value });

  const statusText =
    status === 'error' && lastError
      ? t('requests.status_error_detail', { message: lastError })
      : t(STATUS_KEYS[status]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headline}>
          <h1 className={styles.title}>{t('requests.title')}</h1>
          <p className={styles.status} data-status={status} role="status">
            <span className={styles.liveDot} aria-hidden="true" />
            <span>{statusText}</span>
            {lastPollAt !== null && status === 'live' && (
              <span className={styles.statusMeta}>
                {t('requests.last_poll', { time: formatClock(lastPollAt, locale) })}
              </span>
            )}
            <span className={styles.statusMeta}>
              {t('requests.stored_count', { value: formatCount(storedCount, locale) })}
            </span>
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmClear(true)}
            disabled={storedCount === 0}
          >
            {t('requests.clear')}
          </Button>
        </div>
      </header>

      <div className={styles.collect}>
        <ToggleSwitch
          checked={enabled}
          onChange={onToggle}
          label={t('requests.collect_label')}
          ariaDescribedBy="requests-collect-hint"
        />
        <p id="requests-collect-hint" className={styles.collectHint}>
          {t('requests.collect_hint')}
        </p>
      </div>

      {status === 'unsupported' && (
        <p className={styles.notice} role="note">
          {t('requests.unsupported_hint')}
        </p>
      )}
      {usageDisabled && (
        <p className={styles.notice} role="note">
          {t('requests.usage_disabled_hint')}
        </p>
      )}

      <div className={styles.filters} role="group" aria-label={t('requests.filters_label')}>
        <div className={styles.segmented} role="group" aria-label={t('requests.range_label')}>
          {TIME_RANGES.map((range) => (
            <button
              key={range}
              type="button"
              className={styles.segment}
              aria-pressed={filters.range === range}
              onClick={() => setFilter('range', range)}
            >
              {t(`requests.range_${range}`)}
            </button>
          ))}
        </div>
        <div className={styles.filterSelect}>
          <Select
            size="sm"
            value={filters.model}
            ariaLabel={t('requests.model_label')}
            onChange={(value) => setFilter('model', value)}
            options={[
              { value: '', label: t('requests.model_all') },
              ...options.models.map((model) => ({ value: model, label: model })),
            ]}
          />
        </div>
        <div className={styles.filterSelect}>
          <Select
            size="sm"
            value={filters.credential}
            ariaLabel={t('requests.credential_label')}
            onChange={(value) => setFilter('credential', value)}
            options={[
              { value: '', label: t('requests.credential_all') },
              ...options.credentials.map((key) => ({
                value: key,
                label: resolveCredential(directory, key).label,
              })),
            ]}
          />
        </div>
        <div className={styles.filterSelect}>
          <Select
            size="sm"
            value={filters.outcome}
            ariaLabel={t('requests.outcome_label')}
            onChange={(value) => setFilter('outcome', value as RequestFilters['outcome'])}
            options={OUTCOME_FILTERS.map((outcome) => ({
              value: outcome,
              label: t(`requests.outcome_${outcome}`),
            }))}
          />
        </div>
      </div>

      {traces.length === 0 ? (
        <EmptyState
          title={t('requests.empty_title')}
          description={t(enabled ? 'requests.empty_desc' : 'requests.empty_paused')}
        />
      ) : visible.length === 0 ? (
        <EmptyState title={t('requests.no_match')} />
      ) : (
        <>
          <PathsSection models={paths} directory={directory} tones={tones} />
          <CredentialsSection
            credentials={credentials}
            reasons={reasons}
            directory={directory}
            tones={tones}
          />
          <RecentRequests traces={visible} directory={directory} tones={tones} nowMs={nowMs} />
        </>
      )}

      <Modal
        open={confirmClear}
        title={t('requests.clear_title')}
        onClose={() => setConfirmClear(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmClear(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmClear(false);
                onClear();
              }}
            >
              {t('requests.clear_confirm')}
            </Button>
          </>
        }
      >
        <p>{t('requests.clear_body', { server })}</p>
      </Modal>
    </div>
  );
}

export function RequestsPage() {
  const apiBase = useAuthStore((state) => state.apiBase);
  const config = useConfigStore((state) => state.config);
  const { enabled, status, lastPollAt, lastError, revision, setEnabled } = useCollectorStore();
  const nowMs = useNow();
  const [attempts, setAttempts] = useState<UsageAttempt[]>([]);
  const [directory, setDirectory] = useState<CredentialDirectory>({});
  const [filters, setFilters] = useState<RequestFilters>(DEFAULT_FILTERS);
  const loadToken = useRef(0);

  useEffect(() => {
    if (!apiBase || !isRequestStoreAvailable()) return;
    const token = (loadToken.current += 1);
    requestStore
      .list(apiBase, Date.now() - REQUEST_RETENTION_MS)
      .then((rows) => {
        if (token === loadToken.current) setAttempts(rows);
      })
      .catch(() => {
        if (token === loadToken.current) setAttempts([]);
      });
  }, [apiBase, revision]);

  useEffect(() => {
    if (!apiBase) return;
    let current = true;
    usageQueueApi
      .loadDirectory()
      .then((next) => {
        if (current) setDirectory(next);
      })
      .catch(() => {
        if (current) setDirectory({});
      });
    return () => {
      current = false;
    };
  }, [apiBase]);

  const traces = useMemo(() => groupTraces(attempts), [attempts]);

  return (
    <RequestsView
      server={apiBase}
      enabled={enabled}
      status={status}
      lastPollAt={lastPollAt}
      lastError={lastError}
      usageDisabled={isUsageStatisticsDisabled(config?.raw)}
      traces={traces}
      storedCount={attempts.length}
      directory={directory}
      filters={filters}
      nowMs={Math.max(nowMs, lastPollAt ?? 0)}
      onToggle={setEnabled}
      onFiltersChange={setFilters}
      onClear={() => {
        void clearCollectedRequests(apiBase);
      }}
    />
  );
}
