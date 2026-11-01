import { useTranslation } from 'react-i18next';
import type { CredentialDirectory } from '@/services/api/usageQueue';
import { resolveCredential, type PathStep } from '../logic';
import styles from '../RequestsPage.module.scss';

interface RouteProps {
  steps: readonly PathStep[];
  directory: CredentialDirectory;
  tones: Record<string, number>;
  size?: 'md' | 'sm';
}

/** A request's attempts as stops on a line, in the order the proxy tried them. */
export function Route({ steps, directory, tones, size = 'md' }: RouteProps) {
  const { t } = useTranslation();
  const described = steps.map((step) => {
    const credential = resolveCredential(directory, step.credential, step.source);
    const outcome = step.ok
      ? t('requests.step_served')
      : t('requests.step_failed', { status: step.status || '?' });
    return { step, credential, outcome };
  });
  const label = described
    .map(({ credential, outcome }) => `${credential.label}: ${outcome}`)
    .join(', ');

  return (
    <ol className={styles.route} data-size={size} aria-label={t('requests.route_label', { label })}>
      {described.map(({ step, credential, outcome }, index) => (
        <li
          key={`${step.credential}-${index}`}
          className={styles.stop}
          data-state={step.ok ? 'ok' : 'fail'}
          data-tone={tones[step.credential] ?? 0}
          title={[credential.label, credential.detail, outcome].filter(Boolean).join('\n')}
        >
          <span className={styles.stopMark} aria-hidden="true">
            {step.ok ? '✓' : '✗'}
          </span>
          <span className={styles.stopName}>{credential.label}</span>
          {!step.ok && (
            <span className={styles.stopCode} aria-hidden="true">
              {step.status || '?'}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

interface CredentialSwatchProps {
  tone: number;
}

export function CredentialSwatch({ tone }: CredentialSwatchProps) {
  return <span className={styles.swatch} data-tone={tone} aria-hidden="true" />;
}
