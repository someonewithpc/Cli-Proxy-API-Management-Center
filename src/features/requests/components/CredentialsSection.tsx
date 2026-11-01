import { useTranslation } from 'react-i18next';
import type { CredentialDirectory } from '@/services/api/usageQueue';
import { resolveCredential, type CredentialAggregate, type FailoverReason } from '../logic';
import { formatCount } from '../format';
import { CredentialSwatch } from './Route';
import styles from '../RequestsPage.module.scss';

interface CredentialsSectionProps {
  credentials: readonly CredentialAggregate[];
  reasons: readonly FailoverReason[];
  directory: CredentialDirectory;
  tones: Record<string, number>;
}

export function CredentialsSection({
  credentials,
  reasons,
  directory,
  tones,
}: CredentialsSectionProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const scale = Math.max(1, ...credentials.map((row) => row.attempts));

  return (
    <section className={styles.section} aria-labelledby="requests-credentials-title">
      <header className={styles.sectionHeader}>
        <h2 id="requests-credentials-title" className={styles.sectionTitle}>
          {t('requests.credentials_title')}
        </h2>
        <p className={styles.sectionDesc}>{t('requests.credentials_desc')}</p>
      </header>

      <ul className={styles.credentialList}>
        {credentials.map((row) => {
          const credential = resolveCredential(directory, row.credential, row.source);
          const tone = tones[row.credential] ?? 0;
          return (
            <li key={row.credential} className={styles.credentialRow} data-tone={tone}>
              <div className={styles.credentialName}>
                <CredentialSwatch tone={tone} />
                <span className={styles.credentialLabel}>{credential.label}</span>
                {credential.priority !== null ? (
                  <span className={styles.credentialMeta}>
                    {t('requests.priority', { value: credential.priority })}
                  </span>
                ) : (
                  <span className={styles.credentialMeta}>{t('requests.unknown_credential')}</span>
                )}
              </div>
              <div
                className={styles.credentialBar}
                role="img"
                aria-label={t('requests.credential_bar_label', {
                  served: row.served,
                  failed: row.failed,
                })}
              >
                <span
                  className={styles.barServed}
                  style={{ inlineSize: `${(row.served / scale) * 100}%` }}
                />
                <span
                  className={styles.barFailed}
                  style={{ inlineSize: `${(row.failed / scale) * 100}%` }}
                />
              </div>
              <div className={styles.credentialCounts}>
                <span>
                  {t('requests.served_count', { value: formatCount(row.served, locale) })}
                </span>
                <span data-state={row.failed ? 'fail' : undefined}>
                  {t('requests.failed_count', { value: formatCount(row.failed, locale) })}
                </span>
                <span>
                  {t('requests.tokens_count', { value: formatCount(row.tokens, locale) })}
                </span>
              </div>
              {row.failures.length > 0 && (
                <ul className={styles.reasonInline}>
                  {row.failures.map((failure) => (
                    <li key={`${failure.status}|${failure.reason}`}>
                      <span className={styles.statusCode}>{failure.status || '?'}</span>
                      <span className={styles.reasonText}>
                        {failure.reason || t('requests.no_message')}
                      </span>
                      <span className={styles.reasonCount}>
                        {t('requests.times', { value: formatCount(failure.count, locale) })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      <h3 className={styles.subTitle}>{t('requests.reasons_title')}</h3>
      {reasons.length === 0 ? (
        <p className={styles.sectionDesc}>{t('requests.reasons_empty')}</p>
      ) : (
        <ul className={styles.reasonList}>
          {reasons.map((reason) => (
            <li key={`${reason.status}|${reason.reason}`} className={styles.reasonRow}>
              <span className={styles.statusCode}>{reason.status || '?'}</span>
              <span className={styles.reasonText}>{reason.reason || t('requests.no_message')}</span>
              <span className={styles.reasonCount}>
                {t('requests.times', { value: formatCount(reason.count, locale) })}
              </span>
              <span className={styles.reasonMeta}>
                {reason.credentials.map((key) => (
                  <span key={key} className={styles.reasonCredential}>
                    <CredentialSwatch tone={tones[key] ?? 0} />
                    {resolveCredential(directory, key).label}
                  </span>
                ))}
                <span>
                  {t('requests.reason_recovered', {
                    value: formatCount(reason.recovered, locale),
                  })}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
