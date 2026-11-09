// @effect-diagnostics globalDate:off - local calendar times for cron.
import { describe, expect, it } from "@effect/vitest";
import { ProviderThreadId, ThreadId } from "@t3tools/contracts";
import type { ProviderAdapterV2WakeThread } from "@t3tools/provider-core/server/ProviderAdapter";

import {
  type ParkedWake,
  LATE_DELIVERY_LIMIT_MS,
  RECURRING_JOB_MAX_AGE_MS,
  WAKE_LEAD_MS,
  adoptedWake,
  decideIdleRelease,
  deliveryText,
  makeClaudeWakeTracker,
  nextCronMatch,
  parseCronCreateJobId,
  parseCronDeleteJobId,
  parseScheduleWakeupDelaySeconds,
  parkedWakeFromRow,
  planDelivery,
  planPark,
  supersededWakeups,
} from "./ClaudeWakeParking.ts";

const MINUTE = 60_000;
const local = (year: number, month: number, day: number, hour: number, minute: number) =>
  new Date(year, month - 1, day, hour, minute).getTime();
const NOW = local(2026, 6, 15, 10, 0);

const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (id: string, content: unknown, isError = false) => ({
  type: "user",
  parent_tool_use_id: null,
  message: {
    content: [
      { type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) },
    ],
  },
});
const lifecycle = (state: string, extra: Record<string, unknown> = {}) => ({
  type: "command_lifecycle",
  state,
  ...extra,
});

const scheduleWakeup = (
  tracker: ReturnType<typeof makeClaudeWakeTracker>,
  id: string,
  delaySeconds: number,
  at: number,
  prompt = "<<autonomous-loop-dynamic>>",
) => {
  tracker.observe(toolUse(id, "ScheduleWakeup", { delaySeconds, prompt, reason: "poll" }), at);
  tracker.observe(toolResult(id, `Next wakeup scheduled for 10:10:00 (in ${delaySeconds}s).`), at);
};

const thread = (
  wakes: ProviderAdapterV2WakeThread["wakes"],
  lastWakeupCallAtMs: number | null = null,
): ProviderAdapterV2WakeThread => ({
  threadId: ThreadId.make("thread-a"),
  providerThreadId: ProviderThreadId.make("provider-thread-a"),
  nativeSessionId: "session-a",
  wakes,
  lastWakeupCallAtMs,
});

const parked = (overrides: Partial<ParkedWake>): ParkedWake => ({
  wakeId: "session-a:wakeup:toolu_1",
  threadId: "thread-a",
  providerThreadId: "provider-thread-a",
  nativeSessionId: "session-a",
  kind: "wakeup",
  jobId: null,
  cron: null,
  prompt: "<<autonomous-loop-dynamic>>",
  recurring: false,
  createdAtMs: NOW,
  dueAtMs: NOW + 30 * MINUTE,
  parkedAtMs: NOW,
  ...overrides,
});

describe("tool result parsing", () => {
  it("reads the delay of a ScheduleWakeup result", () => {
    expect(
      parseScheduleWakeupDelaySeconds(
        "Next wakeup scheduled for 10:10:00 (in 602s). Give the user a status update.",
      ),
    ).toBe(602);
    expect(parseScheduleWakeupDelaySeconds("Loop stopped.")).toBeNull();
  });

  it("reads the job id of one-shot and recurring CronCreate results", () => {
    expect(
      parseCronCreateJobId(
        "Scheduled one-shot task f851d733 (at 23:59 on 31 Dec). Next run: soon.",
      ),
    ).toBe("f851d733");
    expect(
      parseCronCreateJobId(
        "Scheduled recurring job 0a1b2c3d (every 5 minutes). Auto-expires after 7 days.",
      ),
    ).toBe("0a1b2c3d");
    expect(parseCronCreateJobId("Something else")).toBeNull();
  });

  it("reads the job id of a CronDelete result", () => {
    expect(parseCronDeleteJobId("Cancelled job f851d733.")).toBe("f851d733");
  });
});

describe("wake tracker", () => {
  it("records a ScheduleWakeup due relative to the result's arrival, once", () => {
    const tracker = makeClaudeWakeTracker();
    tracker.observe(
      toolUse("toolu_1", "ScheduleWakeup", {
        delaySeconds: 600,
        prompt: "<<autonomous-loop-dynamic>>",
      }),
      NOW - 5_000,
    );
    const result = toolResult("toolu_1", "Next wakeup scheduled for 10:10:00 (in 600s).");
    tracker.observe(result, NOW);
    // A wake-buffer replay of the same frames must not add it again.
    tracker.observe(result, NOW + 30_000);
    expect(tracker.wakes()).toEqual([
      {
        kind: "wakeup",
        toolUseId: "toolu_1",
        dueAtMs: NOW + 10 * MINUTE,
        prompt: "<<autonomous-loop-dynamic>>",
      },
    ]);
    expect(tracker.lastWakeupCallAtMs()).toBe(NOW);
  });

  it("keeps one pending wakeup: a new ScheduleWakeup replaces the earlier one", () => {
    const tracker = makeClaudeWakeTracker();
    scheduleWakeup(tracker, "toolu_1", 600, NOW);
    scheduleWakeup(tracker, "toolu_2", 1200, NOW + MINUTE);
    expect(tracker.wakes()).toEqual([
      {
        kind: "wakeup",
        toolUseId: "toolu_2",
        dueAtMs: NOW + MINUTE + 20 * MINUTE,
        prompt: "<<autonomous-loop-dynamic>>",
      },
    ]);
    expect(tracker.lastWakeupCallAtMs()).toBe(NOW + MINUTE);
  });

  it("ignores a failed call, and stop:true clears every wakeup but no job", () => {
    const tracker = makeClaudeWakeTracker();
    tracker.observe(toolUse("toolu_e", "ScheduleWakeup", { prompt: "p", delaySeconds: 60 }), NOW);
    tracker.observe(
      toolResult("toolu_e", "Next wakeup scheduled for 10:01:00 (in 60s).", true),
      NOW,
    );
    expect(tracker.wakes()).toEqual([]);
    expect(tracker.lastWakeupCallAtMs()).toBeNull();
    scheduleWakeup(tracker, "toolu_1", 60, NOW);
    tracker.observe(toolUse("toolu_c", "CronCreate", { cron: "*/5 * * * *", prompt: "poll" }), NOW);
    tracker.observe(
      toolResult("toolu_c", "Scheduled recurring job 0a1b2c3d (every 5 minutes)."),
      NOW,
    );
    tracker.observe(toolUse("toolu_2", "ScheduleWakeup", { stop: true }), NOW + MINUTE);
    tracker.observe(toolResult("toolu_2", [{ type: "text", text: "Loop stopped." }]), NOW + MINUTE);
    expect(tracker.wakes().map((wake) => wake.kind)).toEqual(["cron"]);
    expect(tracker.lastWakeupCallAtMs()).toBe(NOW + MINUTE);
  });

  it("drops the replaced wakeup when a new ScheduleWakeup result cannot be read", () => {
    const tracker = makeClaudeWakeTracker();
    scheduleWakeup(tracker, "toolu_1", 600, NOW);
    tracker.observe(toolUse("toolu_2", "ScheduleWakeup", { delaySeconds: 60, prompt: "p" }), NOW);
    tracker.observe(toolResult("toolu_2", "Wakeup set."), NOW + MINUTE);
    expect(tracker.wakes()).toEqual([]);
    expect(tracker.lastWakeupCallAtMs()).toBe(NOW + MINUTE);
  });

  it("counts a stop that comes back as an error, so a parked loop is not sent", () => {
    const tracker = makeClaudeWakeTracker();
    tracker.observe(toolUse("toolu_s", "ScheduleWakeup", { stop: true }), NOW);
    tracker.observe(toolResult("toolu_s", "No wakeup is scheduled.", true), NOW);
    expect(tracker.lastWakeupCallAtMs()).toBe(NOW);
  });

  it("records session CronCreate jobs, drops them on CronDelete, and leaves durable jobs alone", () => {
    const tracker = makeClaudeWakeTracker();
    tracker.observe(
      toolUse("toolu_c1", "CronCreate", {
        cron: "59 23 31 12 *",
        prompt: "say PING",
        recurring: false,
      }),
      NOW,
    );
    tracker.observe(
      toolResult("toolu_c1", [
        { type: "text", text: "Scheduled one-shot task f851d733 (at 23:59 on 31 Dec)." },
      ]),
      NOW,
    );
    tracker.observe(
      toolUse("toolu_c2", "CronCreate", { cron: "*/5 * * * *", prompt: "poll", durable: true }),
      NOW,
    );
    tracker.observe(
      toolResult("toolu_c2", "Scheduled recurring job 0a1b2c3d (every 5 minutes)."),
      NOW,
    );
    expect(tracker.wakes()).toEqual([
      {
        kind: "cron",
        jobId: "f851d733",
        cron: "59 23 31 12 *",
        prompt: "say PING",
        recurring: false,
        createdAtMs: NOW,
        dueAtMs: local(2026, 12, 31, 23, 59),
      },
    ]);
    tracker.observe(toolUse("toolu_d", "CronDelete", { id: "f851d733" }), NOW);
    tracker.observe(toolResult("toolu_d", "Cancelled job f851d733."), NOW);
    expect(tracker.wakes()).toEqual([]);
  });

  it("marks a self-started wake turn busy until it completes, and drops the one-shot it fired", () => {
    const tracker = makeClaudeWakeTracker();
    scheduleWakeup(tracker, "toolu_1", 600, NOW);
    tracker.observe(
      lifecycle("started", { command_uuid: "c1", wakeup_source: "schedule_wakeup" }),
      NOW + 10 * MINUTE,
    );
    expect(tracker.wakeTurnActive()).toBe(true);
    expect(tracker.wakes()).toEqual([]);
    tracker.observe(lifecycle("completed", { command_uuid: "c1" }), NOW + 11 * MINUTE);
    expect(tracker.wakeTurnActive()).toBe(false);
  });

  it("ends a wake turn on its result frame when no completed frame comes", () => {
    const tracker = makeClaudeWakeTracker();
    tracker.observe(
      lifecycle("started", { command_uuid: "c1", wakeup_source: "schedule_wakeup" }),
      NOW,
    );
    expect(tracker.wakeTurnActive()).toBe(true);
    tracker.observe({ type: "result", subtype: "success" }, NOW + MINUTE);
    expect(tracker.wakeTurnActive()).toBe(false);
  });

  it("keeps a wakeup not yet due when a wake turn starts, and ends the turn with the process", () => {
    const tracker = makeClaudeWakeTracker();
    scheduleWakeup(tracker, "toolu_1", 3600, NOW);
    tracker.observe(lifecycle("started", { wakeup_source: "schedule_wakeup" }), NOW + MINUTE);
    expect(tracker.wakes()).toHaveLength(1);
    expect(tracker.wakeTurnActive()).toBe(true);
    tracker.processEnded();
    expect(tracker.wakeTurnActive()).toBe(false);
    expect(tracker.wakes()).toHaveLength(1);
  });

  it("drops no wakeup when a wake turn starts while a recurring job is due", () => {
    const tracker = makeClaudeWakeTracker();
    tracker.observe(
      toolUse("toolu_c", "CronCreate", { cron: "*/15 * * * *", prompt: "poll" }),
      NOW,
    );
    tracker.observe(
      toolResult("toolu_c", "Scheduled recurring job 0a1b2c3d (every 15 minutes)."),
      NOW,
    );
    scheduleWakeup(tracker, "toolu_1", 15 * 60 + 60, NOW);
    tracker.observe(
      lifecycle("started", { command_uuid: "c1", wakeup_source: "schedule_wakeup" }),
      NOW + 15 * MINUTE,
    );
    expect(tracker.wakes().map((wake) => wake.kind)).toEqual(["cron", "wakeup"]);
  });

  it("adopts restored jobs once, and never a ScheduleWakeup", () => {
    const tracker = makeClaudeWakeTracker();
    const job = {
      kind: "cron" as const,
      jobId: "0a1b2c3d",
      cron: "*/5 * * * *",
      prompt: "poll",
      recurring: true,
      createdAtMs: NOW - MINUTE,
      dueAtMs: null,
    };
    tracker.adopt([
      job,
      { kind: "wakeup", toolUseId: "toolu_old", dueAtMs: NOW + MINUTE, prompt: "p" },
    ]);
    tracker.adopt([job]);
    expect(tracker.wakes()).toEqual([job]);
  });
});

describe("cron matching", () => {
  it("finds the next local minute matching each field", () => {
    expect(nextCronMatch("59 23 31 12 *", local(2026, 6, 15, 10, 7))).toBe(
      local(2026, 12, 31, 23, 59),
    );
    expect(nextCronMatch("*/15 * * * *", local(2026, 6, 15, 10, 7))).toBe(
      local(2026, 6, 15, 10, 15),
    );
    expect(nextCronMatch("0 9-17/4 * * *", local(2026, 6, 15, 10, 7))).toBe(
      local(2026, 6, 15, 13, 0),
    );
    expect(nextCronMatch("30 8 * 1,7 *", local(2026, 6, 15, 10, 7))).toBe(local(2026, 7, 1, 8, 30));
  });

  it("is strictly after the given time", () => {
    const at = local(2026, 6, 15, 10, 15);
    expect(nextCronMatch("15 10 * * *", at)).toBe(local(2026, 6, 16, 10, 15));
    expect(nextCronMatch("15 10 * * *", at - 30_000)).toBe(at);
  });

  it("fires on either day field when both are restricted, and reads 7 as Sunday", () => {
    // 2026-06-15 is a Monday.
    expect(nextCronMatch("0 9 20 * 3", local(2026, 6, 15, 10, 0))).toBe(local(2026, 6, 17, 9, 0));
    expect(nextCronMatch("0 9 * * 7", local(2026, 6, 15, 10, 0))).toBe(local(2026, 6, 21, 9, 0));
  });

  it("returns null for expressions it cannot read or that never match", () => {
    expect(nextCronMatch("61 * * * *", 0)).toBeNull();
    expect(nextCronMatch("0-61 * * * *", 0)).toBeNull();
    expect(nextCronMatch("* * * *", 0)).toBeNull();
    expect(nextCronMatch("@hourly", 0)).toBeNull();
    expect(nextCronMatch("0 0 30 2 *", local(2026, 1, 1, 0, 0))).toBeNull();
  });
});

describe("parking", () => {
  it("pins when the earliest wakeup is due before the next idle check plus the lead time", () => {
    const idleTimeoutMs = 5 * MINUTE;
    expect(
      decideIdleRelease({
        earliestDueMs: NOW + idleTimeoutMs + WAKE_LEAD_MS,
        nowMs: NOW,
        idleTimeoutMs,
      }),
    ).toBe("pin");
    expect(
      decideIdleRelease({
        earliestDueMs: NOW + idleTimeoutMs + WAKE_LEAD_MS + 1,
        nowMs: NOW,
        idleTimeoutMs,
      }),
    ).toBe("park");
  });

  it("parks wakeups and session jobs, leaving behind one-shots already due", () => {
    const plan = planPark({
      nowMs: NOW,
      threads: [
        thread([
          { kind: "wakeup", toolUseId: "toolu_1", dueAtMs: NOW + 30 * MINUTE, prompt: "loop" },
          {
            kind: "cron",
            jobId: "a1",
            cron: "*/15 * * * *",
            prompt: "poll",
            recurring: true,
            createdAtMs: NOW - MINUTE,
            dueAtMs: null,
          },
          {
            kind: "cron",
            jobId: "b2",
            cron: "59 9 15 6 *",
            prompt: "late",
            recurring: false,
            createdAtMs: NOW - 10 * MINUTE,
            dueAtMs: NOW - MINUTE,
          },
        ]),
      ],
    });
    expect(plan.type).toBe("park");
    const rows = plan.type === "park" ? plan.rows : [];
    expect(rows.map((row) => [row.wakeId, row.dueAtMs])).toEqual([
      ["session-a:wakeup:toolu_1", NOW + 30 * MINUTE],
      ["session-a:cron:a1", local(2026, 6, 15, 10, 15)],
    ]);
    expect(rows.every((row) => row.parkedAtMs === NOW)).toBe(true);
    const due = planPark({
      nowMs: NOW,
      threads: [thread([{ kind: "wakeup", toolUseId: "toolu_2", dueAtMs: NOW, prompt: "p" }])],
    });
    expect(due.type).toBe("none");
  });

  it("refuses a schedule it cannot read but keeps the rest, and skips an expired recurring job", () => {
    const unreadable = planPark({
      nowMs: NOW,
      threads: [
        thread([
          {
            kind: "cron",
            jobId: "x",
            cron: "@hourly",
            prompt: "p",
            recurring: true,
            createdAtMs: NOW,
            dueAtMs: null,
          },
          { kind: "wakeup", toolUseId: "toolu_1", dueAtMs: NOW + 30 * MINUTE, prompt: "loop" },
        ]),
      ],
    });
    expect(unreadable.type).toBe("unparkable");
    expect(
      unreadable.type === "unparkable" ? unreadable.rows.map((row) => row.wakeId) : [],
    ).toEqual(["session-a:wakeup:toolu_1"]);
    const expired = planPark({
      nowMs: NOW,
      threads: [
        thread([
          {
            kind: "cron",
            jobId: "y",
            cron: "*/5 * * * *",
            prompt: "p",
            recurring: true,
            createdAtMs: NOW - RECURRING_JOB_MAX_AGE_MS,
            dueAtMs: null,
          },
        ]),
      ],
    });
    expect(expired.type).toBe("none");
  });

  it("finds a parked wakeup that a later process replaced or stopped", () => {
    const row = parked({ parkedAtMs: NOW });
    const job = parked({
      wakeId: "session-a:cron:a1",
      kind: "cron",
      jobId: "a1",
      cron: "*/5 * * * *",
    });
    expect(supersededWakeups([row, job], null)).toEqual([]);
    expect(supersededWakeups([row, job], NOW - 1)).toEqual([]);
    expect(supersededWakeups([row, job], NOW + MINUTE)).toEqual([row]);
  });
});

describe("delivery", () => {
  it("sends /loop for the placeholder and any other prompt as it is", () => {
    expect(deliveryText("<<autonomous-loop-dynamic>>")).toBe("/loop");
    expect(deliveryText("/loop check the deploy")).toBe("/loop check the deploy");
    expect(deliveryText("say PING")).toBe("say PING");
  });

  it("removes a one-shot and moves a recurring job on to its next match", () => {
    expect(planDelivery(parked({}), NOW + 30 * MINUTE)).toEqual({ send: true, nextDueAtMs: null });
    const oneShotJob = parked({
      wakeId: "session-a:cron:b2",
      kind: "cron",
      jobId: "b2",
      cron: "*/15 * * * *",
      recurring: false,
      dueAtMs: local(2026, 6, 15, 10, 15),
    });
    expect(planDelivery(oneShotJob, local(2026, 6, 15, 10, 15))).toEqual({
      send: true,
      nextDueAtMs: null,
    });
    const job = parked({
      kind: "cron",
      jobId: "a1",
      cron: "*/15 * * * *",
      recurring: true,
      dueAtMs: local(2026, 6, 15, 10, 15),
    });
    expect(planDelivery(job, local(2026, 6, 15, 10, 15))).toEqual({
      send: true,
      nextDueAtMs: local(2026, 6, 15, 10, 30),
    });
    expect(planDelivery({ ...job, createdAtMs: NOW - RECURRING_JOB_MAX_AGE_MS }, NOW)).toEqual({
      send: true,
      nextDueAtMs: null,
    });
  });

  it("drops a wakeup found long overdue instead of sending it", () => {
    const row = parked({ dueAtMs: NOW });
    expect(planDelivery(row, NOW + LATE_DELIVERY_LIMIT_MS).send).toBe(true);
    expect(planDelivery(row, NOW + LATE_DELIVERY_LIMIT_MS + 1).send).toBe(false);
  });

  it("hands back parked jobs as wakeups a resumed process holds, never a ScheduleWakeup", () => {
    expect(adoptedWake(parked({}))).toBeNull();
    expect(
      adoptedWake(
        parked({
          kind: "cron",
          jobId: "b2",
          cron: "59 23 31 12 *",
          dueAtMs: local(2026, 12, 31, 23, 59),
        }),
      ),
    ).toEqual({
      kind: "cron",
      jobId: "b2",
      cron: "59 23 31 12 *",
      prompt: "<<autonomous-loop-dynamic>>",
      recurring: false,
      createdAtMs: NOW,
      dueAtMs: local(2026, 12, 31, 23, 59),
    });
  });
});

describe("table rows", () => {
  it("reads rows back, and refuses rows it does not know", () => {
    const row = {
      wake_id: "session-a:cron:a1",
      thread_id: "thread-a",
      provider_thread_id: "provider-thread-a",
      native_session_id: "session-a",
      kind: "cron",
      job_id: "a1",
      cron: "*/5 * * * *",
      prompt: "poll",
      recurring: 1,
      created_at_ms: NOW,
      due_at_ms: NOW + 5 * MINUTE,
      parked_at_ms: NOW,
    };
    expect(parkedWakeFromRow(row)).toEqual(
      parked({
        wakeId: "session-a:cron:a1",
        kind: "cron",
        jobId: "a1",
        cron: "*/5 * * * *",
        prompt: "poll",
        recurring: true,
        dueAtMs: NOW + 5 * MINUTE,
      }),
    );
    expect(parkedWakeFromRow({ ...row, kind: "future" })).toBeNull();
  });
});
