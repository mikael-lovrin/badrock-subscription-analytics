/** "YYYY-MM-DDTHH:..." or "YYYY-MM-DD" -> "YYYY-MM-DD" */
export function toDateOnly(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

/** "YYYY-MM-DD" -> "DD-MM", the display format requested for every daily chart axis. */
export function formatDDMM(dateOnly: string): string {
  const [, month, day] = dateOnly.split("-");
  return `${day}-${month}`;
}

/** Every calendar day from `from` to `to`, inclusive, both "YYYY-MM-DD". */
export function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * Fills every day in [from, to] with a zero-value row where `rowsByDate`
 * has no entry — the site shows a continuous daily axis even on days with
 * no orders, rather than skipping straight from one active day to the
 * next.
 */
export function zeroFillDaily<T extends Record<string, unknown>>(
  rowsByDate: Map<string, T>,
  from: string,
  to: string,
  zeroRow: (date: string) => T,
): T[] {
  return enumerateDays(from, to).map((date) => rowsByDate.get(date) ?? zeroRow(date));
}
