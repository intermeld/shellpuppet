/** Numeric five-field cron evaluated against UTC calendar minutes. */
export interface Cron {
  matches(time: Date): boolean;
  next(after: Date): Date | null;
}

function field(raw: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!match || (match[1] === '*' && match[2] !== undefined)) return null;
    const from = match[1] === '*' ? min : Number(match[1]);
    const throughEnd = match[1] === '*' || match[3] !== undefined;
    const to = Number(match[2] ?? (throughEnd ? max : from));
    const step = Number(match[3] ?? 1);
    if (from < min || to > max || from > to || !Number.isSafeInteger(step) || step < 1) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

export function parseCron(raw: string): Cron | null {
  const parts = raw.trim().split(/[ \t]+/);
  if (parts.length !== 5 || /[^0-9*,/ \t-]/.test(raw)) return null;
  const minutes = field(parts[0]!, 0, 59);
  const hours = field(parts[1]!, 0, 23);
  const dates = field(parts[2]!, 1, 31);
  const months = field(parts[3]!, 1, 12);
  const weekdays = field(parts[4]!, 0, 7);
  if (!minutes || !hours || !dates || !months || !weekdays) return null;
  const eitherDay = !parts[2]!.startsWith('*') && !parts[4]!.startsWith('*');
  const matchesDay = (day: Date): boolean => {
    const date = dates.includes(day.getUTCDate());
    const weekday = weekdays.includes(day.getUTCDay()) || (day.getUTCDay() === 0 && weekdays.includes(7));
    return eitherDay ? date || weekday : date && weekday;
  };
  return {
    matches: time => months.includes(time.getUTCMonth() + 1) && matchesDay(time) &&
      hours.includes(time.getUTCHours()) && minutes.includes(time.getUTCMinutes()),
    next(after) {
      const day = new Date(after);
      day.setUTCHours(0, 0, 0, 0);
      // All Gregorian weekday and leap-year combinations repeat within 400 years.
      const end = day.getUTCFullYear() + 400;
      while (day.getUTCFullYear() <= end) {
        if (!months.includes(day.getUTCMonth() + 1)) {
          day.setUTCMonth(day.getUTCMonth() + 1, 1);
          continue;
        }
        if (matchesDay(day)) {
          for (const hour of hours) {
            for (const minute of minutes) {
              const time = day.getTime() + (hour * 60 + minute) * 60_000;
              if (time > after.getTime()) return new Date(time);
            }
          }
        }
        day.setUTCDate(day.getUTCDate() + 1);
      }
      return null;
    },
  };
}
