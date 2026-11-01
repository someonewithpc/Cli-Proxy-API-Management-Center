import { useTranslation } from 'react-i18next';
import type { CredentialDirectory } from '@/services/api/usageQueue';
import type { ModelPaths } from '../logic';
import { formatCount, formatLatency, formatShare } from '../format';
import { Route } from './Route';
import styles from '../RequestsPage.module.scss';

interface PathsSectionProps {
  models: readonly ModelPaths[];
  directory: CredentialDirectory;
  tones: Record<string, number>;
}

export function PathsSection({ models, directory, tones }: PathsSectionProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  return (
    <section className={styles.section} aria-labelledby="requests-paths-title">
      <header className={styles.sectionHeader}>
        <h2 id="requests-paths-title" className={styles.sectionTitle}>
          {t('requests.paths_title')}
        </h2>
        <p className={styles.sectionDesc}>{t('requests.paths_desc')}</p>
      </header>

      {models.map((model) => (
        <div key={model.model} className={styles.modelBlock}>
          <h3 className={styles.modelName}>
            <span>{model.model || t('requests.unknown_model')}</span>
            <span className={styles.modelSummary}>
              {t('requests.model_summary', {
                total: formatCount(model.total, locale),
                served: formatCount(model.served, locale),
              })}
            </span>
          </h3>
          <ul className={styles.pathList}>
            {model.paths.map((path) => {
              const last = path.steps[path.steps.length - 1];
              return (
                <li
                  key={path.signature}
                  className={styles.pathRow}
                  data-outcome={path.outcome}
                  data-tone={tones[last?.credential ?? ''] ?? 0}
                >
                  <span className={styles.pathShare}>{formatShare(path.share, locale)}</span>
                  <Route steps={path.steps} directory={directory} tones={tones} />
                  <span className={styles.pathStats}>
                    <span className={styles.pathCount}>
                      {t('requests.path_count', { value: formatCount(path.count, locale) })}
                    </span>
                    <span>
                      {t('requests.median_latency', {
                        value: formatLatency(path.medianLatencyMs, locale),
                      })}
                    </span>
                  </span>
                  <span
                    className={styles.pathBar}
                    style={{ inlineSize: `${Math.max(path.share * 100, 0.5)}%` }}
                    aria-hidden="true"
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
