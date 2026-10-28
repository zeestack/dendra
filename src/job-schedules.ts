import type { NewJob } from "./jobs.ts";

/** Recurring wall-clock times in UTC. Sunday is weekday 0; Saturday is 6. */
export type JobCalendar =
  | { kind: "daily"; hourUTC: number; minuteUTC: number }
  | { kind: "weekly"; weekdayUTC: number; hourUTC: number; minuteUTC: number };

export interface ScheduleRecord {
  id: string;
  name: string;
  input: unknown;
  key: string | null;
  maxAttempts: number;
  timeoutMs?: number;
  onInterrupt?: "retry" | "fail";
  calendar: JobCalendar;
  /** Epoch milliseconds of the next unconsumed occurrence. */
  nextRunAt: number;
  /** Fences configuration changes and deletion/recreation. Compare for equality only. */
  revision: number;
}

export type NewSchedule = Omit<ScheduleRecord, "revision">;

/** Durable scheduling is optional for custom JobStores; advertise it in capabilities. */
export interface JobScheduleStore {
  /**
   * Upsert by id. Identical configuration preserves the cursor and revision, so
   * restarting a process cannot postpone a missed occurrence. Compare all fields
   * except nextRunAt/revision; JSON object order is irrelevant and omitted
   * onInterrupt means "retry". A change, or deletion/recreation, gets a new revision.
   */
  putSchedule(schedule: NewSchedule): Promise<ScheduleRecord>;
  /** Remove future occurrences; already queued/running jobs are unaffected. */
  removeSchedule(id: string): Promise<boolean>;
  /** Return due records for these job names, ordered by nextRunAt then id, up to limit. */
  dueSchedules(names: string[], now: number, limit?: number): Promise<ScheduleRecord[]>;
  /**
   * Atomically compare id/revision/nextRunAt, enqueue the job, and advance the
   * cursor. Return false if the snapshot is stale or removed. An existing active
   * job with the same name/key still consumes this occurrence. Neither write
   * may survive alone if enqueue fails; nextRunAt must advance the old cursor.
   */
  advanceSchedule(record: ScheduleRecord, nextRunAt: number, job: NewJob): Promise<boolean>;
}

export function validateCalendar(calendar: JobCalendar): void {
  if (!calendar || typeof calendar !== "object" || (calendar.kind !== "daily" && calendar.kind !== "weekly")) {
    throw new RangeError("[dendra] job calendar: kind must be daily or weekly");
  }
  if (!Number.isInteger(calendar.hourUTC) || calendar.hourUTC < 0 || calendar.hourUTC > 23) {
    throw new RangeError("[dendra] job calendar: hourUTC must be an integer from 0 to 23");
  }
  if (!Number.isInteger(calendar.minuteUTC) || calendar.minuteUTC < 0 || calendar.minuteUTC > 59) {
    throw new RangeError("[dendra] job calendar: minuteUTC must be an integer from 0 to 59");
  }
  if (calendar.kind === "weekly" && (!Number.isInteger(calendar.weekdayUTC) || calendar.weekdayUTC < 0 || calendar.weekdayUTC > 6)) {
    throw new RangeError("[dendra] job calendar: weekdayUTC must be an integer from 0 to 6");
  }
}

function validTime(time: number): void {
  if (!Number.isFinite(time) || !Number.isFinite(new Date(time).getTime())) {
    throw new RangeError("[dendra] job calendar: time must be a valid epoch millisecond timestamp");
  }
}

/** First calendar occurrence strictly after the supplied epoch millisecond timestamp. */
export function nextOccurrence(calendar: JobCalendar, after: number): number {
  validateCalendar(calendar);
  validTime(after);
  const next = new Date(after);
  next.setUTCHours(calendar.hourUTC, calendar.minuteUTC, 0, 0);
  if (calendar.kind === "weekly") {
    next.setUTCDate(next.getUTCDate() + (calendar.weekdayUTC - next.getUTCDay() + 7) % 7);
  }
  if (next.getTime() <= after) next.setUTCDate(next.getUTCDate() + (calendar.kind === "daily" ? 1 : 7));
  const result = next.getTime();
  validTime(result);
  return result;
}

const BATCH_SIZE = 100;

/**
 * Consume at most 100 due schedules per tick. Each produces at most one catch-up
 * job, even after a long outage; the next cursor is strictly after now. Concurrent
 * workers may read the same records, but the store's atomic comparison chooses
 * one winner. Returns the number of advanced cursors (including keyed dedupes).
 */
export async function enqueueDueSchedules(store: JobScheduleStore, names: string[], now = Date.now()): Promise<number> {
  validTime(now);
  if (!names.length) return 0;
  const due = await store.dueSchedules(names, now, BATCH_SIZE);
  let advanced = 0;
  for (const record of due.slice(0, BATCH_SIZE)) {
    if (!names.includes(record.name) || record.nextRunAt > now) continue;
    const nextRunAt = nextOccurrence(record.calendar, now);
    const job: NewJob = {
      id: crypto.randomUUID(),
      name: record.name,
      input: record.input,
      key: record.key,
      maxAttempts: record.maxAttempts,
      timeoutMs: record.timeoutMs,
      onInterrupt: record.onInterrupt,
      runAt: now,
    };
    if (await store.advanceSchedule(record, nextRunAt, job)) advanced++;
  }
  return advanced;
}
