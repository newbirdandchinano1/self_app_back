const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidYmd(value: string): boolean {
  return YMD_RE.test(value.trim());
}

export function formatLocalYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function ymdToLocalDate(ymd: string): Date | null {
  const m = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(year, month - 1, day);
}

export function addDaysToYmd(ymd: string, days: number): string {
  const d = ymdToLocalDate(ymd);
  if (!d) return ymd;
  d.setDate(d.getDate() + days);
  return formatLocalYmd(d);
}

export function listYmdRange(startYmd: string, endYmd: string): string[] {
  const out: string[] = [];
  let cursor = startYmd;
  while (cursor <= endYmd) {
    out.push(cursor);
    cursor = addDaysToYmd(cursor, 1);
  }
  return out;
}

export function dueDateYmd(value: string | null | undefined): string {
  return value?.trim().slice(0, 10) ?? '';
}
