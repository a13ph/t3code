// @effect-diagnostics globalDate:off - plain helpers outside the Effect runtime: cron needs local calendar fields.
/**
 * Pure parts of keeping Claude Code's wakeups after its process ends: the frame
 * tracker, a local-time cron matcher, and the pin, park and delivery decisions.
 * Durable CronCreate jobs are left alone; Claude Code fires those itself.
 */
import type {
  ProviderAdapterV2PendingWake,
  ProviderAdapterV2WakeThread,
} from "@t3tools/provider-core/server/ProviderAdapter";

const MINUTE_MS = 60_000;
/** A wakeup due before the next idle check plus this lead keeps its process. */
export const WAKE_LEAD_MS = 2 * MINUTE_MS;
/** A wake turn this close to a one-shot's due time is taken as its firing. */
export const WAKE_MATCH_WINDOW_MS = 90_000;
/** Claude Code expires a recurring job this long after its creation. */
export const RECURRING_JOB_MAX_AGE_MS = 7 * 24 * 60 * MINUTE_MS;

export const SCHEDULE_WAKEUP_TOOL = "ScheduleWakeup";
export const CRON_CREATE_TOOL = "CronCreate";
export const CRON_DELETE_TOOL = "CronDelete";

/** The prompt `/loop` without an interval schedules; sent back, it must be the command. */
export const AUTONOMOUS_LOOP_PROMPT = "<<autonomous-loop-dynamic>>";

/** Seconds until the wakeup, from "Next wakeup scheduled for 10:10:00 (in 602s)". */
export function parseScheduleWakeupDelaySeconds(text: string): number | null {
  const match = /Next wakeup scheduled for [^(]*\(in (\d+)s\)/u.exec(text);
  if (match?.[1] === undefined) return null;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/**
 * The job id from a CronCreate result: "Scheduled one-shot task f851d733 (...)"
 * or "Scheduled recurring job f851d733 (...)".
 */
const CRON_CREATE_RESULT =
  /Scheduled (?:one-shot task|recurring job|[a-z-]+ (?:task|job)) ([\w-]+)/u;

export function parseCronCreateJobId(text: string): string | null {
  const match = CRON_CREATE_RESULT.exec(text);
  return match?.[1] ?? null;
}

/** The job id from a CronDelete result: "Cancelled job f851d733." */
export function parseCronDeleteJobId(text: string): string | null {
  const match = /Cancelled job ([A-Za-z0-9_-]+)/u.exec(text);
  return match?.[1] ?? null;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      if (typeof part !== "object" || part === null) return "";
      const text: unknown = Reflect.get(part, "text");
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

function messageContentBlocks(message: unknown): ReadonlyArray<Record<string, unknown>> {
  if (typeof message !== "object" || message === null) return [];
  const inner: unknown = Reflect.get(message, "message");
  if (typeof inner !== "object" || inner === null) return [];
  const content: unknown = Reflect.get(inner, "content");
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block: unknown): block is Record<string, unknown> =>
      typeof block === "object" && block !== null,
  );
}

function stringField(record: unknown, key: string): string | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const value: unknown = Reflect.get(record, key);
  return typeof value === "string" ? value : undefined;
}

interface CronSpec {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly dayOfMonthAny: boolean;
  readonly dayOfWeekAny: boolean;
}

function parseCronField(text: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText, extra] = part.split("/");
    if (range === undefined || range.length === 0 || extra !== undefined) return null;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isSafeInteger(step) || step < 1) return null;
    let low: number;
    let high: number;
    if (range === "*") {
      low = min;
      high = max;
    } else if (range.includes("-")) {
      const [lowText, highText, rest] = range.split("-");
      if (rest !== undefined || lowText === undefined || highText === undefined) return null;
      if (!/^\d+$/u.test(lowText) || !/^\d+$/u.test(highText)) return null;
      low = Number(lowText);
      high = Number(highText);
    } else {
      if (!/^\d+$/u.test(range)) return null;
      low = Number(range);
      high = stepText === undefined ? low : max;
    }
    if (low < min || high > max || low > high) return null;
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values.size === 0 ? null : values;
}

/** Parses a five-field cron expression; null when it is not one this matcher reads. */
export function parseCron(expression: string): CronSpec | null {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) return null;
  const [minuteText, hourText, dayOfMonthText, monthText, dayOfWeekText] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minutes = parseCronField(minuteText, 0, 59);
  const hours = parseCronField(hourText, 0, 23);
  const daysOfMonth = parseCronField(dayOfMonthText, 1, 31);
  const months = parseCronField(monthText, 1, 12);
  const rawDaysOfWeek = parseCronField(dayOfWeekText, 0, 7);
  if (
    minutes === null ||
    hours === null ||
    daysOfMonth === null ||
    months === null ||
    rawDaysOfWeek === null
  ) {
    return null;
  }
  const daysOfWeek = new Set([...rawDaysOfWeek].map((day) => (day === 7 ? 0 : day)));
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthAny: dayOfMonthText.startsWith("*"),
    dayOfWeekAny: dayOfWeekText.startsWith("*"),
  };
}

function cronDayMatches(spec: CronSpec, date: Date): boolean {
  const dayOfMonth = spec.daysOfMonth.has(date.getDate());
  const dayOfWeek = spec.daysOfWeek.has(date.getDay());
  if (spec.dayOfMonthAny && spec.dayOfWeekAny) return true;
  if (spec.dayOfMonthAny) return dayOfWeek;
  if (spec.dayOfWeekAny) return dayOfMonth;
  // Both restricted: standard cron fires when either matches.
  return dayOfMonth || dayOfWeek;
}

const CRON_SEARCH_LIMIT_MS = 5 * 366 * 24 * 60 * MINUTE_MS;

/**
 * The first minute strictly after `afterMs` that the expression matches, in the
 * server's local time, as epoch ms. Null for an expression this matcher cannot
 * read or one with no match within five years (such as 30 February).
 */
export function nextCronMatch(expression: string, afterMs: number): number | null {
  const spec = parseCron(expression);
  if (spec === null) return null;
  const date = new Date(afterMs);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = afterMs + CRON_SEARCH_LIMIT_MS;
  while (date.getTime() <= limit) {
    if (!spec.months.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cronDayMatches(spec, date)) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hours.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minutes.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0);
      continue;
    }
    return date.getTime();
  }
  return null;
}

export interface ClaudeWakeTracker {
  /** Reads one stream-json frame of the session; `nowMs` is when it arrived. */
  readonly observe: (message: unknown, nowMs: number) => void;
  readonly wakes: () => ReadonlyArray<ProviderAdapterV2PendingWake>;
  readonly wakeTurnActive: () => boolean;
  /** When the process last scheduled or stopped a wakeup; null if it never did. */
  readonly lastWakeupCallAtMs: () => number | null;
  /** Jobs a resumed process restored by itself; a job id already listed is kept as is. */
  readonly adopt: (wakes: ReadonlyArray<ProviderAdapterV2PendingWake>) => void;
  /**
   * The process ended: any wake turn it ran ended with it, and so did the
   * wakeup that turn fired. Its other wakeups stay listed.
   */
  readonly processEnded: () => void;
  /**
   * Removes and returns the ScheduleWakeup calls no turn is firing: a resumed
   * process does not restore them, so T3 takes them over.
   */
  readonly takeWakeups: () => ReadonlyArray<ProviderAdapterV2PendingWake>;
}

const MAX_SETTLED_TOOL_USES = 2_000;

export function makeClaudeWakeTracker(): ClaudeWakeTracker {
  const openToolUses = new Map<
    string,
    { readonly name: string; readonly input: Record<string, unknown> }
  >();
  // Frames can be handled twice (wake buffers replay them); a tool call counts once.
  const settledToolUses = new Set<string>();
  const seenWakeCommands = new Set<string>();
  let pending: Array<ProviderAdapterV2PendingWake> = [];
  let lastWakeupCallAtMs: number | null = null;
  // undefined: no wake turn; null: one runs, its command uuid unknown.
  let activeWakeCommand: string | null | undefined;

  const settle = (toolUseId: string) => {
    if (settledToolUses.size >= MAX_SETTLED_TOOL_USES) settledToolUses.clear();
    settledToolUses.add(toolUseId);
  };

  const applyResult = (
    use: { readonly name: string; readonly input: Record<string, unknown> },
    toolUseId: string,
    text: string,
    nowMs: number,
  ) => {
    if (use.name === SCHEDULE_WAKEUP_TOOL) {
      // Claude Code keeps one pending wakeup: a new one replaces it, stop:true clears it.
      if (use.input.stop === true) {
        lastWakeupCallAtMs = nowMs;
        pending = pending.filter((wake) => wake.kind !== "wakeup");
        return;
      }
      // The call replaced the earlier wakeup even when its result cannot be read.
      lastWakeupCallAtMs = nowMs;
      pending = pending.filter((wake) => wake.kind !== "wakeup");
      const delaySeconds = parseScheduleWakeupDelaySeconds(text);
      const prompt = use.input.prompt;
      if (delaySeconds === null || typeof prompt !== "string") return;
      pending = [
        ...pending,
        { kind: "wakeup", toolUseId, dueAtMs: nowMs + delaySeconds * 1_000, prompt },
      ];
      return;
    }
    if (use.name === CRON_CREATE_TOOL) {
      // A durable job lives in the workspace's file, and Claude Code fires it from there.
      if (use.input.durable === true) return;
      const jobId = parseCronCreateJobId(text);
      const cron = use.input.cron;
      const prompt = use.input.prompt;
      if (jobId === null || typeof cron !== "string" || typeof prompt !== "string") return;
      const recurring = use.input.recurring !== false;
      pending = [
        ...pending.filter((wake) => !(wake.kind === "cron" && wake.jobId === jobId)),
        {
          kind: "cron",
          jobId,
          cron,
          prompt,
          recurring,
          createdAtMs: nowMs,
          dueAtMs: recurring ? null : nextCronMatch(cron, nowMs),
        },
      ];
      return;
    }
    if (use.name === CRON_DELETE_TOOL) {
      const inputId = use.input.id;
      const jobId = typeof inputId === "string" ? inputId : parseCronDeleteJobId(text);
      if (jobId === null) return;
      pending = pending.filter((wake) => !(wake.kind === "cron" && wake.jobId === jobId));
    }
  };

  // A wake turn fired a one-shot: mark the earliest one due by now as firing,
  // so a release does not send it again and a turn cut short sends it once.
  // The frame does not say which job fired: Claude Code 2.1.319 marks a
  // recurring job's turn "schedule_wakeup" too.
  const markFired = (nowMs: number) => {
    // A recurring job due now may be the one that fired; then nothing is marked.
    const recurringDueNow = pending.some((wake) => {
      if (wake.kind !== "cron" || !wake.recurring) return false;
      const match = nextCronMatch(wake.cron, nowMs - WAKE_MATCH_WINDOW_MS);
      return match !== null && match <= nowMs + WAKE_MATCH_WINDOW_MS;
    });
    if (recurringDueNow) return;
    const limit = nowMs + WAKE_MATCH_WINDOW_MS;
    let firedIndex = -1;
    let firedDue = Number.POSITIVE_INFINITY;
    pending.forEach((wake, index) => {
      if (wake.firing === true) return;
      const due = wake.kind === "wakeup" ? wake.dueAtMs : wake.recurring ? null : wake.dueAtMs;
      if (due !== null && due <= limit && due < firedDue) {
        firedIndex = index;
        firedDue = due;
      }
    });
    if (firedIndex >= 0) {
      pending = pending.map((wake, index) =>
        index === firedIndex ? { ...wake, firing: true as const } : wake,
      );
    }
  };

  const endWakeTurn = () => {
    activeWakeCommand = undefined;
    pending = pending.filter((wake) => wake.firing !== true);
  };

  const observe = (message: unknown, nowMs: number): void => {
    const type = stringField(message, "type");
    if (type === "assistant") {
      for (const block of messageContentBlocks(message)) {
        if (block.type !== "tool_use") continue;
        const id = block.id;
        const name = block.name;
        if (typeof id !== "string" || typeof name !== "string") continue;
        if (
          name !== SCHEDULE_WAKEUP_TOOL &&
          name !== CRON_CREATE_TOOL &&
          name !== CRON_DELETE_TOOL
        ) {
          continue;
        }
        if (settledToolUses.has(id)) continue;
        const input = block.input;
        openToolUses.set(id, {
          name,
          input:
            typeof input === "object" && input !== null && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : {},
        });
      }
      return;
    }
    if (type === "user") {
      for (const block of messageContentBlocks(message)) {
        if (block.type !== "tool_result") continue;
        const toolUseId = block.tool_use_id;
        if (typeof toolUseId !== "string") continue;
        const use = openToolUses.get(toolUseId);
        if (use === undefined) continue;
        openToolUses.delete(toolUseId);
        settle(toolUseId);
        // A stop with nothing pending may come back as an error; the loop is stopped all the same.
        const isStop = use.name === SCHEDULE_WAKEUP_TOOL && use.input.stop === true;
        if (block.is_error === true && !isStop) continue;
        applyResult(use, toolUseId, toolResultText(block.content), nowMs);
      }
      return;
    }
    if (type === "result") {
      // Every turn ends with a result frame, a wake turn whose completion went unseen too.
      endWakeTurn();
      return;
    }
    if (type === "command_lifecycle") {
      const state = stringField(message, "state");
      const commandUuid = stringField(message, "command_uuid");
      const wakeupSource = stringField(message, "wakeup_source");
      if (state === "started" && wakeupSource !== undefined && wakeupSource.length > 0) {
        if (commandUuid !== undefined) {
          if (seenWakeCommands.has(commandUuid)) return;
          if (seenWakeCommands.size >= MAX_SETTLED_TOOL_USES) seenWakeCommands.clear();
          seenWakeCommands.add(commandUuid);
        }
        activeWakeCommand = commandUuid ?? null;
        markFired(nowMs);
        return;
      }
      if (
        state === "completed" &&
        activeWakeCommand !== undefined &&
        (activeWakeCommand === null ||
          commandUuid === undefined ||
          commandUuid === activeWakeCommand)
      ) {
        endWakeTurn();
      }
    }
  };

  return {
    observe,
    wakes: () => pending,
    wakeTurnActive: () => activeWakeCommand !== undefined,
    lastWakeupCallAtMs: () => lastWakeupCallAtMs,
    adopt: (wakes) => {
      const listed = new Set(pending.flatMap((wake) => (wake.kind === "cron" ? [wake.jobId] : [])));
      pending = [
        ...pending,
        ...wakes.filter((wake) => wake.kind === "cron" && !listed.has(wake.jobId)),
      ];
    },
    processEnded: () => {
      endWakeTurn();
      openToolUses.clear();
    },
    takeWakeups: () => {
      const taken = pending.filter((wake) => wake.kind === "wakeup" && wake.firing !== true);
      pending = pending.filter((wake) => !taken.includes(wake));
      return taken;
    },
  };
}

/** A wakeup T3 holds while the process that scheduled it is gone. */
export interface ParkedWake {
  readonly wakeId: string;
  readonly threadId: string;
  readonly providerThreadId: string;
  readonly nativeSessionId: string;
  readonly kind: "wakeup" | "cron";
  readonly jobId: string | null;
  readonly cron: string | null;
  readonly prompt: string;
  readonly recurring: boolean;
  readonly createdAtMs: number;
  /** The next time it fires, epoch ms. */
  readonly dueAtMs: number;
  readonly parkedAtMs: number;
}

export type ParkPlan =
  | { readonly type: "none" }
  | { readonly type: "park"; readonly rows: ReadonlyArray<ParkedWake> }
  /** A wakeup this code cannot schedule; keep the process instead of losing it. */
  | {
      readonly type: "unparkable";
      readonly reason: string;
      /** What can be parked when the process cannot be kept any longer. */
      readonly rows: ReadonlyArray<ParkedWake>;
    };

function recurringExpired(createdAtMs: number, dueAtMs: number): boolean {
  return dueAtMs > createdAtMs + RECURRING_JOB_MAX_AGE_MS;
}

/**
 * What to park for the threads of one session. A one-shot whose turn runs now
 * is parked due now: the process ends before that turn does. Any other one-shot
 * already due stays behind, since its live process had its chance to fire it,
 * unless `sendOverdue` says no process held it.
 */
export function planPark(input: {
  readonly threads: ReadonlyArray<ProviderAdapterV2WakeThread>;
  readonly nowMs: number;
  readonly sendOverdue?: boolean;
}): ParkPlan {
  const { nowMs } = input;
  const oneShotDue = (wake: { readonly firing?: true }, dueAtMs: number): number | null => {
    if (wake.firing === true) return nowMs;
    if (dueAtMs > nowMs) return dueAtMs;
    return input.sendOverdue === true ? nowMs : null;
  };
  const rows: Array<ParkedWake> = [];
  let unreadable: string | null = null;
  for (const thread of input.threads) {
    const base = {
      threadId: String(thread.threadId),
      providerThreadId: String(thread.providerThreadId),
      nativeSessionId: thread.nativeSessionId,
      parkedAtMs: nowMs,
    };
    for (const wake of thread.wakes) {
      if (wake.kind === "wakeup") {
        const dueAtMs = oneShotDue(wake, wake.dueAtMs);
        if (dueAtMs === null) continue;
        rows.push({
          ...base,
          wakeId: `${thread.nativeSessionId}:wakeup:${wake.toolUseId}`,
          kind: "wakeup",
          jobId: null,
          cron: null,
          prompt: wake.prompt,
          recurring: false,
          createdAtMs: nowMs,
          dueAtMs,
        });
        continue;
      }
      const scheduled = wake.recurring ? nextCronMatch(wake.cron, nowMs) : wake.dueAtMs;
      if (scheduled === null) {
        unreadable ??= `cannot read the schedule of job ${wake.jobId}`;
        continue;
      }
      const due = wake.recurring ? scheduled : oneShotDue(wake, scheduled);
      if (due === null) continue;
      if (wake.recurring && recurringExpired(wake.createdAtMs, due)) continue;
      rows.push({
        ...base,
        wakeId: `${thread.nativeSessionId}:cron:${wake.jobId}`,
        kind: "cron",
        jobId: wake.jobId,
        cron: wake.cron,
        prompt: wake.prompt,
        recurring: wake.recurring,
        createdAtMs: wake.createdAtMs,
        dueAtMs: due,
      });
    }
  }
  if (unreadable !== null) return { type: "unparkable", reason: unreadable, rows };
  return rows.length === 0 ? { type: "none" } : { type: "park", rows };
}

export function earliestDueMs(rows: ReadonlyArray<Pick<ParkedWake, "dueAtMs">>): number | null {
  return rows.length === 0 ? null : Math.min(...rows.map((row) => row.dueAtMs));
}

/**
 * At an idle release: keep the process (pin) when the earliest wakeup is due
 * before the next idle check plus the lead time, so Claude Code fires it
 * itself; otherwise park and release.
 */
export function decideIdleRelease(input: {
  readonly earliestDueMs: number;
  readonly nowMs: number;
  readonly idleTimeoutMs: number;
}): "pin" | "park" {
  return input.earliestDueMs <= input.nowMs + input.idleTimeoutMs + WAKE_LEAD_MS ? "pin" : "park";
}

/**
 * Parked wakeups (one per thread at most) that a later process replaced: it
 * scheduled or stopped a wakeup after they were parked, and Claude Code keeps
 * only the newest.
 */
export function supersededWakeups(
  rows: ReadonlyArray<ParkedWake>,
  lastWakeupCallAtMs: number | null,
): ReadonlyArray<ParkedWake> {
  if (lastWakeupCallAtMs === null) return [];
  return rows.filter((row) => row.kind === "wakeup" && row.parkedAtMs <= lastWakeupCallAtMs);
}

/**
 * A parked wakeup that a live process of its native session still holds: an
 * undone park or a failed handback left it in both places, and that process
 * fires it itself.
 */
export function heldByLiveProcess(row: ParkedWake, live: ProviderAdapterV2WakeThread): boolean {
  if (live.nativeSessionId !== row.nativeSessionId) return false;
  return live.wakes.some((wake) =>
    wake.kind === "wakeup"
      ? row.kind === "wakeup" && row.wakeId === `${row.nativeSessionId}:wakeup:${wake.toolUseId}`
      : row.kind === "cron" && row.jobId === wake.jobId,
  );
}

/** The message text that makes Claude run a wakeup's prompt. */
export function deliveryText(prompt: string): string {
  return prompt.trim() === AUTONOMOUS_LOOP_PROMPT ? "/loop" : prompt;
}

/**
 * The next due time of a due parked wakeup, sent at `nowMs`; null removes the
 * row. A wakeup is sent however late, and a recurring job that missed several
 * matches is sent once and moves on past `nowMs`.
 */
export function nextDueAfterDelivery(row: ParkedWake, nowMs: number): number | null {
  if (!row.recurring || row.cron === null) return null;
  const next = nextCronMatch(row.cron, nowMs);
  if (next === null || recurringExpired(row.createdAtMs, next)) return null;
  return next;
}

/** A parked scheduled job, as the wakeup a resumed process holds again. */
export function adoptedWake(row: ParkedWake): ProviderAdapterV2PendingWake | null {
  if (row.kind !== "cron" || row.jobId === null || row.cron === null) return null;
  return {
    kind: "cron",
    jobId: row.jobId,
    cron: row.cron,
    prompt: row.prompt,
    recurring: row.recurring,
    createdAtMs: row.createdAtMs,
    dueAtMs: row.recurring ? null : row.dueAtMs,
  };
}

export interface ParkedWakeRow {
  readonly wake_id: string;
  readonly thread_id: string;
  readonly provider_thread_id: string;
  readonly native_session_id: string;
  readonly kind: string;
  readonly job_id: string | null;
  readonly cron: string | null;
  readonly prompt: string;
  readonly recurring: number;
  readonly created_at_ms: number;
  readonly due_at_ms: number;
  readonly parked_at_ms: number;
}

/** Null for a row this build cannot read. */
export function parkedWakeFromRow(row: ParkedWakeRow): ParkedWake | null {
  const kind = row.kind === "wakeup" || row.kind === "cron" ? row.kind : null;
  const dueAtMs = Number(row.due_at_ms);
  const createdAtMs = Number(row.created_at_ms);
  const parkedAtMs = Number(row.parked_at_ms);
  if (
    kind === null ||
    !Number.isFinite(dueAtMs) ||
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(parkedAtMs)
  ) {
    return null;
  }
  return {
    wakeId: row.wake_id,
    threadId: row.thread_id,
    providerThreadId: row.provider_thread_id,
    nativeSessionId: row.native_session_id,
    kind,
    jobId: row.job_id,
    cron: row.cron,
    prompt: row.prompt,
    recurring: Number(row.recurring) === 1,
    createdAtMs,
    dueAtMs,
    parkedAtMs,
  };
}
