import { CronExpressionParser } from "cron-parser";

const MINIMUM_SCHEDULE_INTERVAL_MINUTES = 5;
export const MINIMUM_SCHEDULE_INTERVAL_MS =
  MINIMUM_SCHEDULE_INTERVAL_MINUTES * 60 * 1_000;

export type ValidatedSchedule = {
  schedule: string;
  timezone: string;
};

const SCHEDULE_VALIDATION_CACHE_LIMIT = 64;
const DST_TRANSITION_SCAN_START = Date.UTC(2025, 0, 1);
const DST_TRANSITION_SCAN_END = Date.UTC(2030, 0, 1);
const DST_TRANSITION_SCAN_STEP_MS = 12 * 60 * 60 * 1_000;
const DST_TRANSITION_WINDOW_MS = 24 * 60 * 60 * 1_000;
const validatedSchedules = new Map<string, ValidatedSchedule>();

export function validateSchedule(
  schedule: string,
  timezone: string,
): ValidatedSchedule {
  const normalizedSchedule = schedule.trim();
  const normalizedTimezone = timezone.trim();
  const cacheKey = `${normalizedSchedule}\u0000${normalizedTimezone}`;
  const cached = validatedSchedules.get(cacheKey);
  if (cached) return cached;
  if (normalizedSchedule.split(/\s+/).length !== 5) {
    throw new Error("Schedule must use exactly five cron fields.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalizedTimezone }).format();
  } catch {
    throw new Error("Schedule must use a valid IANA timezone.");
  }

  let expression: ReturnType<typeof CronExpressionParser.parse>;
  try {
    expression = CronExpressionParser.parse(normalizedSchedule, {
      currentDate: "2026-01-01T00:00:00.000Z",
      tz: normalizedTimezone,
    });
  } catch {
    throw new Error("Schedule must use a valid five-field cron expression.");
  }
  assertMinimumScheduleInterval(
    expression,
    normalizedSchedule,
    normalizedTimezone,
  );
  const validated = {
    schedule: normalizedSchedule,
    timezone: normalizedTimezone,
  };
  if (validatedSchedules.size >= SCHEDULE_VALIDATION_CACHE_LIMIT) {
    validatedSchedules.delete(validatedSchedules.keys().next().value!);
  }
  validatedSchedules.set(cacheKey, validated);
  return validated;
}

export function nextScheduleOccurrence(
  schedule: string,
  timezone: string,
  after: string,
): string {
  const validated = validateSchedule(schedule, timezone);
  let next: Date;
  try {
    next = CronExpressionParser.parse(validated.schedule, {
      currentDate: after,
      tz: validated.timezone,
    })
      .next()
      .toDate();
  } catch {
    throw new Error("Schedule must produce a future occurrence.");
  }
  // Recheck the next local day so persisted schedules stay safe beyond the
  // representative transition scan performed during configuration validation.
  assertMinimumIntervalInWindow(
    validated.schedule,
    validated.timezone,
    next.getTime() - DST_TRANSITION_WINDOW_MS,
    next.getTime() + DST_TRANSITION_WINDOW_MS,
  );
  return next.toISOString();
}

// With five cron fields, sub-five-minute cadence can occur within an hour,
// across adjacent configured hours, or when a forward timezone shift bridges
// otherwise non-adjacent local hours.
function assertMinimumScheduleInterval(
  expression: ReturnType<typeof CronExpressionParser.parse>,
  schedule: string,
  timezone: string,
): void {
  const minutes = expression.fields.minute.values;
  for (let index = 1; index < minutes.length; index += 1) {
    if (
      minutes[index]! - minutes[index - 1]! <
      MINIMUM_SCHEDULE_INTERVAL_MINUTES
    ) {
      throwTooFrequent();
    }
  }

  const shortestHourBoundaryGap =
    minutes[0]! + 60 - minutes[minutes.length - 1]!;

  const hours = expression.fields.hour.values;
  const hasAdjacentHours = hours.some((hour) =>
    hours.some((candidate) => candidate === (hour === 23 ? 0 : hour + 1)),
  );
  if (
    shortestHourBoundaryGap < MINIMUM_SCHEDULE_INTERVAL_MINUTES &&
    hasAdjacentHours
  ) {
    throwTooFrequent();
  }

  assertMinimumIntervalAcrossForwardTimezoneShifts(schedule, timezone);
}

function assertMinimumIntervalAcrossForwardTimezoneShifts(
  schedule: string,
  timezone: string,
): void {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  let previousOffset = timezoneOffsetMinutes(
    formatter,
    new Date(DST_TRANSITION_SCAN_START),
  );

  for (
    let time = DST_TRANSITION_SCAN_START + DST_TRANSITION_SCAN_STEP_MS;
    time <= DST_TRANSITION_SCAN_END;
    time += DST_TRANSITION_SCAN_STEP_MS
  ) {
    const offset = timezoneOffsetMinutes(formatter, new Date(time));
    if (offset > previousOffset) {
      assertMinimumIntervalInWindow(
        schedule,
        timezone,
        time - DST_TRANSITION_SCAN_STEP_MS - DST_TRANSITION_WINDOW_MS,
        time + DST_TRANSITION_WINDOW_MS,
      );
    }
    previousOffset = offset;
  }
}

function assertMinimumIntervalInWindow(
  schedule: string,
  timezone: string,
  start: number,
  end: number,
): void {
  const expression = CronExpressionParser.parse(schedule, {
    currentDate: new Date(start).toISOString(),
    endDate: new Date(end).toISOString(),
    tz: timezone,
  });
  let previous: Date | undefined;
  while (expression.hasNext()) {
    const current = expression.next().toDate();
    if (
      previous &&
      current.getTime() - previous.getTime() < MINIMUM_SCHEDULE_INTERVAL_MS
    ) {
      throwTooFrequent();
    }
    previous = current;
  }
}

function timezoneOffsetMinutes(
  formatter: Intl.DateTimeFormat,
  date: Date,
): number {
  const values = new Map(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return (
    (Date.UTC(
      values.get("year")!,
      values.get("month")! - 1,
      values.get("day")!,
      values.get("hour")!,
      values.get("minute")!,
      values.get("second")!,
    ) -
      date.getTime()) /
    60_000
  );
}

function throwTooFrequent(): never {
  throw new Error("Schedule must run no more often than every five minutes.");
}
