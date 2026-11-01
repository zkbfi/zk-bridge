/** A span of seconds in plain words: `45 s`, `12 min`, `2 h`, `26 h`, `1.5 h`. */
export function duration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 90) return `${seconds} s`;
  if (seconds < 3600) return `${Math.min(59, Math.round(seconds / 60))} min`;
  const hours = seconds / 3600;
  return `${hours < 10 ? String(Number(hours.toFixed(1))) : Math.round(hours)} h`;
}

/** The first and last characters of a long value are not needed on the page; this keeps a short form. */
export const shorten = (value: string, length = 10): string => (value.length <= length + 3 ? value : `${value.slice(0, length)}...`);
