export function formatLatency(ms: number, locale?: string): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(ms / 1000)} s`;
}

export function formatShare(share: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
    share
  );
}

export function formatCount(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    notation: value >= 100_000 ? 'compact' : 'standard',
  }).format(value);
}

export function formatClock(ms: number, locale?: string): string {
  return new Date(ms).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatDateTime(ms: number, nowMs: number, locale?: string): string {
  const date = new Date(ms);
  const sameDay = new Date(nowMs).toDateString() === date.toDateString();
  return sameDay
    ? formatClock(ms, locale)
    : date.toLocaleString(locale, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}
