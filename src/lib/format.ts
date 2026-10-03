const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function appTimeZone(): string {
  return process.env.APP_TIMEZONE || 'America/New_York';
}

/** Today's date as YYYY-MM-DD in the app's time zone. */
export function todayIso(now = new Date(), timeZone = appTimeZone()): string {
  return localDate(now.toISOString(), timeZone);
}

/** The local calendar date (YYYY-MM-DD) of an ISO timestamp. */
export function localDate(iso: string, timeZone = appTimeZone()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(iso),
  );
}

/** "Mar 14, 1941" from "1941-03-14". Leaves anything else alone. */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

export function formatDateTime(iso: string, timeZone = appTimeZone()): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** "medicare_advantage" -> "Medicare advantage" */
export function humanize(value: string): string {
  const s = value.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Lower-cases a label for use mid-sentence, but leaves acronyms like "NPI" alone. */
export function soften(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}
