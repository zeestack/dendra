import { describe, expect, it, vi } from "vitest";
import { enqueueDueSchedules, nextOccurrence, validateCalendar, type JobCalendar, type JobScheduleStore, type ScheduleRecord } from "../src/job-schedules.ts";
import type { NewJob } from "../src/jobs.ts";

const time = (iso: string) => Date.parse(iso);
const daily: JobCalendar = { kind: "daily", hourUTC: 9, minuteUTC: 30 };
const weekly: JobCalendar = { kind: "weekly", weekdayUTC: 0, hourUTC: 9, minuteUTC: 30 };

describe("UTC job calendars", () => {
  it.each([
    ["2026-10-27T09:29:59.999Z", "2026-10-27T09:30:00.000Z"],
    ["2026-10-27T09:30:00.000Z", "2026-10-28T09:30:00.000Z"],
    ["2026-10-27T23:59:59.999Z", "2026-10-28T09:30:00.000Z"],
    ["2024-02-28T12:00:00.000Z", "2024-02-29T09:30:00.000Z"],
    ["2024-02-29T12:00:00.000Z", "2024-03-01T09:30:00.000Z"],
    ["2025-02-28T12:00:00.000Z", "2025-03-01T09:30:00.000Z"],
    ["2026-12-31T12:00:00.000Z", "2027-01-01T09:30:00.000Z"],
  ])("finds the strictly future daily occurrence after %s", (after, expected) => {
    expect(nextOccurrence(daily, time(after))).toBe(time(expected));
  });

  it.each([
    ["2026-10-30T23:00:00.000Z", "2026-11-01T09:30:00.000Z"],
    ["2026-11-01T09:29:59.999Z", "2026-11-01T09:30:00.000Z"],
    ["2026-11-01T09:30:00.000Z", "2026-11-08T09:30:00.000Z"],
    ["2026-11-02T00:00:00.000Z", "2026-11-08T09:30:00.000Z"],
    ["2024-02-28T12:00:00.000Z", "2024-03-03T09:30:00.000Z"],
    ["2026-12-31T12:00:00.000Z", "2027-01-03T09:30:00.000Z"],
  ])("finds Sunday in UTC after %s, independent of local daylight saving", (after, expected) => {
    expect(nextOccurrence(weekly, time(after))).toBe(time(expected));
  });

  it("accepts midnight, the last minute, and Saturday", () => {
    expect(nextOccurrence({ kind: "daily", hourUTC: 0, minuteUTC: 0 }, time("2026-10-27T00:00:00Z"))).toBe(time("2026-10-28T00:00:00Z"));
    expect(nextOccurrence({ kind: "weekly", weekdayUTC: 6, hourUTC: 23, minuteUTC: 59 }, time("2026-10-30T23:59:00Z"))).toBe(time("2026-10-31T23:59:00Z"));
  });

  it.each([
    null, {}, { ...daily, kind: "monthly" },
    ...[-1, 24, 0.5, NaN, Infinity, "9", undefined].map((hourUTC) => ({ ...daily, hourUTC })),
    ...[-1, 60, 0.5, NaN, Infinity, "30", undefined].map((minuteUTC) => ({ ...daily, minuteUTC })),
    ...[-1, 7, 0.5, NaN, Infinity, "0", undefined].map((weekdayUTC) => ({ ...weekly, weekdayUTC })),
  ])("rejects invalid calendar %j", (calendar) => {
    expect(() => validateCalendar(calendar as JobCalendar)).toThrow(RangeError);
    expect(() => nextOccurrence(calendar as JobCalendar, 0)).toThrow(RangeError);
  });

  it.each([NaN, Infinity, -Infinity, 8_640_000_000_000_001])("rejects invalid timestamp %s", (after) => {
    expect(() => nextOccurrence(daily, after)).toThrow(RangeError);
  });

  it("rejects a date whose next occurrence exceeds the Date range", () => {
    expect(() => nextOccurrence(daily, 8_640_000_000_000_000)).toThrow(RangeError);
  });
});

function schedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: "daily-report", name: "report", input: { scope: "team-a" }, key: "team-a",
    maxAttempts: 3, timeoutMs: 5000, onInterrupt: "fail", calendar: daily,
    nextRunAt: time("2026-01-01T09:30:00Z"), revision: 17, ...overrides,
  };
}

/** Snapshot reads race; the comparison and both writes are one synchronous operation. */
function mockStore(initial: ScheduleRecord[]) {
  const records = new Map(initial.map((record) => [record.id, structuredClone(record)]));
  const jobs: NewJob[] = [];
  const store: JobScheduleStore = {
    async putSchedule(value) {
      const record = { ...value, revision: 99 };
      records.set(value.id, record);
      return record;
    },
    async removeSchedule(id) { return records.delete(id); },
    dueSchedules: vi.fn(async (names, now, limit = 100) => [...records.values()]
      .filter((record) => names.includes(record.name) && record.nextRunAt <= now)
      .slice(0, limit).map((record) => structuredClone(record))),
    advanceSchedule: vi.fn(async (record, nextRunAt, job) => {
      const current = records.get(record.id);
      if (!current || current.revision !== record.revision || current.nextRunAt !== record.nextRunAt) return false;
      jobs.push(structuredClone(job));
      current.nextRunAt = nextRunAt;
      return true;
    }),
  };
  return { store, records, jobs };
}

describe("enqueueDueSchedules", () => {
  const now = time("2026-10-27T12:00:00Z");

  it("coalesces months of missed daily runs into one immediate catch-up", async () => {
    const { store, records, jobs } = mockStore([schedule()]);
    expect(await enqueueDueSchedules(store, ["report"], now)).toBe(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({ id: expect.any(String), name: "report", input: { scope: "team-a" }, key: "team-a", maxAttempts: 3, timeoutMs: 5000, onInterrupt: "fail", runAt: now });
    expect(records.get("daily-report")?.nextRunAt).toBe(time("2026-10-28T09:30:00Z"));
    expect(await enqueueDueSchedules(store, ["report"], now)).toBe(0);
    expect(jobs).toHaveLength(1);
  });

  it("coalesces missed weekly runs and includes a run due exactly now", async () => {
    const { store, records, jobs } = mockStore([schedule({ calendar: weekly }), schedule({ id: "exact", nextRunAt: now })]);
    expect(await enqueueDueSchedules(store, ["report"], now)).toBe(2);
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(2);
    expect(records.get("daily-report")?.nextRunAt).toBe(time("2026-11-01T09:30:00Z"));
    expect(records.get("exact")?.nextRunAt).toBe(time("2026-10-28T09:30:00Z"));
  });

  it("uses CAS so simultaneous scheduler ticks enqueue one occurrence", async () => {
    const { store, jobs } = mockStore([schedule()]);
    const counts = await Promise.all([enqueueDueSchedules(store, ["report"], now), enqueueDueSchedules(store, ["report"], now)]);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(store.advanceSchedule).toHaveBeenCalledTimes(2);
    expect(jobs).toHaveLength(1);
  });

  it.each(["changed", "removed", "recreated"])("does not enqueue a stale snapshot after its schedule was %s", async (change) => {
    const initial = schedule();
    const { store, records, jobs } = mockStore([initial]);
    store.dueSchedules = async () => {
      const snapshot = structuredClone(initial);
      if (change === "removed") records.delete(initial.id);
      else records.set(initial.id, { ...initial, revision: initial.revision + 10 });
      return [snapshot];
    };
    expect(await enqueueDueSchedules(store, ["report"], now)).toBe(0);
    expect(jobs).toHaveLength(0);
  });

  it("asks for a bounded batch, even if a custom store returns extra records", async () => {
    const initial = Array.from({ length: 125 }, (_, i) => schedule({ id: `schedule-${i}` }));
    const { store, jobs } = mockStore(initial);
    store.dueSchedules = vi.fn(async () => initial.map((record) => structuredClone(record)));
    expect(await enqueueDueSchedules(store, ["report"], now)).toBe(100);
    expect(store.dueSchedules).toHaveBeenCalledWith(["report"], now, 100);
    expect(jobs).toHaveLength(100);
  });

  it("does not tick without registered job names or consume future/unregistered records", async () => {
    const { store, jobs } = mockStore([]);
    expect(await enqueueDueSchedules(store, [], now)).toBe(0);
    expect(store.dueSchedules).not.toHaveBeenCalled();
    store.dueSchedules = async () => [schedule({ name: "other" }), schedule({ nextRunAt: now + 1 })];
    expect(await enqueueDueSchedules(store, ["report"], now)).toBe(0);
    expect(jobs).toHaveLength(0);
  });

  it("leaves the occurrence available after an atomic store failure", async () => {
    const { store, records, jobs } = mockStore([schedule()]);
    const advance = store.advanceSchedule;
    store.advanceSchedule = async () => { throw new Error("database unavailable"); };
    await expect(enqueueDueSchedules(store, ["report"], now)).rejects.toThrow("database unavailable");
    expect(records.get("daily-report")?.nextRunAt).toBe(schedule().nextRunAt);
    store.advanceSchedule = advance;
    expect(await enqueueDueSchedules(store, ["report"], now)).toBe(1);
    expect(jobs).toHaveLength(1);
  });

  it("rejects invalid tick times before querying the store", async () => {
    const { store } = mockStore([]);
    await expect(enqueueDueSchedules(store, ["report"], NaN)).rejects.toThrow(RangeError);
    expect(store.dueSchedules).not.toHaveBeenCalled();
  });
});
