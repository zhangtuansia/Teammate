/**
 * Minimal cron scheduling for workspace automations.
 *
 * Supports five-field cron expressions (lists, ranges, steps), @every <n><unit>
 * intervals, the common @alias shorthands, and an optional CRON_TZ=<zone> or
 * TZ=<zone> prefix evaluated through Intl rather than a tz database.
 */

const MINUTE_MS = 60_000;
const EVERY_PATTERN = /^@every\s+(\d+)\s*(s|m|h|d)$/i;
const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};
const MAX_SEARCH_MINUTES = 366 * 24 * 60;

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** Standard cron quirk: when both day fields are restricted they OR. */
  domAndDowBothRestricted: boolean;
  timeZone?: string;
}

interface WallClock {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0 || (stepPart !== undefined && stepPart.trim() === "")) return null;
    let start: number;
    let end: number;
    if (rangePart === "*" || rangePart === "") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      start = Number(a);
      end = Number(b);
    } else {
      start = Number(rangePart);
      end = stepPart === undefined ? start : max;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size > 0 ? values : null;
}

function splitTimeZone(expression: string): { body: string; timeZone?: string } {
  const match = /^(?:CRON_TZ|TZ)=(\S+)\s+/.exec(expression);
  if (!match) return { body: expression };
  return { body: expression.slice(match[0].length), timeZone: match[1] };
}

function zonedWallClock(date: Date, timeZone: string): WallClock | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    const parts: Record<string, string> = {};
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== "literal") parts[part.type] = part.value;
    }
    const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      minute: Number(parts.minute),
      hour: Number(parts.hour) % 24,
      dayOfMonth: Number(parts.day),
      month: Number(parts.month),
      dayOfWeek: weekdays[parts.weekday ?? ""] ?? 0,
    };
  } catch {
    return null;
  }
}

function localWallClock(date: Date): WallClock {
  return {
    minute: date.getMinutes(),
    hour: date.getHours(),
    dayOfMonth: date.getDate(),
    month: date.getMonth() + 1,
    dayOfWeek: date.getDay(),
  };
}

export function parseCronExpression(raw: string): CronFields | null {
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (/^@every\s+\d+\s*(s|m|h|d)$/i.test(normalized)) return null;
  const expanded = ALIASES[normalized.toLowerCase()] ?? normalized;
  const { body, timeZone } = splitTimeZone(expanded);
  const fields = body.split(" ");
  if (fields.length !== 5) return null;
  const minute = parseField(fields[0] ?? "", 0, 59);
  const hour = parseField(fields[1] ?? "", 0, 23);
  const dayOfMonth = parseField(fields[2] ?? "", 1, 31);
  const month = parseField(fields[3] ?? "", 1, 12);
  const dayOfWeekRaw = parseField(fields[4] ?? "", 0, 7);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeekRaw) return null;
  if (timeZone && zonedWallClock(new Date(), timeZone) == null) return null;
  const dayOfWeek = new Set([...dayOfWeekRaw].map((day) => (day === 7 ? 0 : day)));
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    domAndDowBothRestricted: fields[2] !== "*" && fields[4] !== "*",
    ...(timeZone ? { timeZone } : {}),
  };
}

export function validateSchedule(raw: string): boolean {
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (EVERY_PATTERN.test(normalized)) {
    const amount = Number(/@every\s+(\d+)/i.exec(normalized)?.[1]);
    return Number.isInteger(amount) && amount > 0 && amount <= 365;
  }
  return parseCronExpression(normalized) != null;
}

function matchesAt(fields: CronFields, wall: WallClock): boolean {
  if (!fields.month.has(wall.month)) return false;
  if (!fields.minute.has(wall.minute) || !fields.hour.has(wall.hour)) return false;
  const dom = fields.dayOfMonth.has(wall.dayOfMonth);
  const dow = fields.dayOfWeek.has(wall.dayOfWeek);
  if (fields.domAndDowBothRestricted) return dom || dow;
  return dom && dow;
}

/** Next matching instant strictly after `afterMs`, or null within ~366 days. */
export function nextRunAfter(raw: string, afterMs: number): number | null {
  const normalized = raw.trim().replace(/\s+/g, " ");
  const every = /^@every\s+(\d+)\s*(s|m|h|d)$/i.exec(normalized);
  if (every) {
    const unitMs = { s: 1_000, m: MINUTE_MS, h: 3_600_000, d: 86_400_000 }[
      (every[2] ?? "").toLowerCase() as "s" | "m" | "h" | "d"
    ];
    if (!unitMs) return null;
    return afterMs + Number(every[1]) * unitMs;
  }
  const fields = parseCronExpression(normalized);
  if (!fields) return null;
  const wallClockOf = fields.timeZone
    ? (date: Date) => zonedWallClock(date, fields.timeZone as string) ?? localWallClock(date)
    : localWallClock;
  let cursor = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const deadline = cursor + MAX_SEARCH_MINUTES * MINUTE_MS;
  while (cursor < deadline) {
    if (matchesAt(fields, wallClockOf(new Date(cursor)))) return cursor;
    cursor += MINUTE_MS;
  }
  return null;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/** Render a schedule as short human prose, e.g. "Every day at 09:00". */
export function describeSchedule(raw: string): string {
  const normalized = raw.trim().replace(/\s+/g, " ");
  const every = /^@every\s+(\d+)\s*(s|m|h|d)$/i.exec(normalized);
  if (every) {
    const units: Record<string, [string, string]> = {
      s: ["second", "seconds"],
      m: ["minute", "minutes"],
      h: ["hour", "hours"],
      d: ["day", "days"],
    };
    const [singular, plural] = units[(every[2] ?? "").toLowerCase()] ?? ["unit", "units"];
    return every[1] === "1" ? `Every ${singular}` : `Every ${every[1]} ${plural}`;
  }
  const fields = parseCronExpression(normalized);
  if (!fields) return normalized;
  const times = [...fields.hour]
    .flatMap((hour) => [...fields.minute].map((minute) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`))
    .sort()
    .slice(0, 4);
  const timeText = times.length > 0 ? ` at ${joinList(times)}` : "";
  const wholeWeek = fields.dayOfWeek.size === 7;
  const days = [...fields.dayOfWeek].sort((a, b) => a - b).map((day) => DAY_NAMES[day] ?? "");
  let dayText = "Every day";
  if (!wholeWeek) {
    if (days.length === 5 && [1, 2, 3, 4, 5].every((day) => fields.dayOfWeek.has(day))) dayText = "Weekdays";
    else if (days.length === 2 && fields.dayOfWeek.has(0) && fields.dayOfWeek.has(6)) dayText = "Weekends";
    else if (days.length > 0) dayText = joinList(days);
  }
  const suffix = fields.timeZone ? ` (${fields.timeZone})` : "";
  return `${dayText}${timeText}${suffix}`;
}
