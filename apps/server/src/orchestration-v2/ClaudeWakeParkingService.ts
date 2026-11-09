/**
 * Keeps Claude Code's own wakeups (ScheduleWakeup, CronCreate) alive across an
 * idle release of the session and across a server restart.
 *
 * - Park: before a release, ProviderSessionManager hands over the wakeups the
 *   process holds, and they go into `claude_parked_wakes`. A wakeup due soon
 *   keeps the process instead (ProviderSessionManager pins it), so Claude Code
 *   fires it itself.
 * - Deliver: when a parked wakeup is due, its prompt is sent to the thread as
 *   one message ("/loop" for the placeholder `/loop` schedules), which resumes
 *   the Claude session. A recurring job moves on to its next due time.
 * - Adopt: a resumed Claude session restores its scheduled jobs by itself, so
 *   when a session opens for the thread, its parked jobs leave the table and
 *   go back to the adapter. Parked ScheduleWakeup calls are not restored by a
 *   resume and stay, unless the new process schedules or stops a wakeup.
 *
 * Nothing here touches Claude Code's own files. Pure parts are in
 * ClaudeWakeParking.ts.
 */
import { ProviderDriverKind, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as Parking from "./ClaudeWakeParking.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
/** After a failed delivery pass, the next one runs this much later. */
const DELIVERY_RETRY_MS = 60_000;
/** The delivery loop wakes at least this often, so a clock jump cannot strand a row. */
const DELIVERY_MAX_SLEEP_MS = 60 * 60_000;
/** The notification summary every delivered wakeup carries. */
export const DELIVERY_SUMMARY = "Scheduled wakeup";

export class ClaudeWakeParkingError extends Data.TaggedError("ClaudeWakeParkingError")<{
  readonly detail: string;
  readonly cause: unknown;
}> {}

export type ClaudeWakeParkOutcome =
  | { readonly type: "none" }
  /** Keep the process: a wakeup is due soon, or parking could not be done safely. */
  | { readonly type: "pin"; readonly reason: string }
  | { readonly type: "parked"; readonly rows: ReadonlyArray<Parking.ParkedWake> };

/** What the live process of a thread holds now; null when no process runs for it. */
export type LiveWakeProbe = (
  threadId: string,
) => Effect.Effect<ProviderAdapter.ProviderAdapterV2WakeThread | null>;

export interface ClaudeWakeParkingShape {
  /**
   * Before a release. `idleTimeoutMs` null means the process ends regardless
   * (pin budget spent, server shutdown), so nothing is pinned for being due
   * soon. Never fails: a failure is a pin.
   */
  readonly parkBeforeRelease: (input: {
    readonly threads: ReadonlyArray<ProviderAdapter.ProviderAdapterV2WakeThread>;
    readonly idleTimeoutMs: number | null;
  }) => Effect.Effect<ClaudeWakeParkOutcome>;
  /** The release did not happen after all: the process still holds these. */
  readonly undoPark: (rows: ReadonlyArray<Parking.ParkedWake>) => Effect.Effect<void>;
  /**
   * The process lives on past a server restart (kept mid-turn): park nothing,
   * but drop parked wakeups it replaced, since the next server cannot see that.
   */
  readonly dropSuperseded: (
    threads: ReadonlyArray<ProviderAdapter.ProviderAdapterV2WakeThread>,
  ) => Effect.Effect<void>;
  /**
   * A session opened for the thread, so its next process resumes the Claude
   * session and restores the scheduled jobs itself. Returns those jobs, which
   * leave the table; parked ScheduleWakeup calls stay.
   */
  readonly threadOpened: (threadId: string) => Effect.Effect<ReadonlyArray<Parking.ParkedWake>>;
  /** Lets delivery skip a parked wakeup a live process has replaced. */
  readonly setLiveWakeProbe: (probe: LiveWakeProbe) => Effect.Effect<void>;
}

export class ClaudeWakeParking extends Context.Service<ClaudeWakeParking, ClaudeWakeParkingShape>()(
  "t3/orchestration-v2/ClaudeWakeParkingService/ClaudeWakeParking",
) {}

/**
 * The table is created here rather than by a numbered migration: this build is
 * a fork, and a fork's migration id would collide with upstream's next one,
 * which the migrator then skips.
 */
const ensureTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS claude_parked_wakes (
      wake_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      native_session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      job_id TEXT,
      cron TEXT,
      prompt TEXT NOT NULL,
      recurring INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      due_at_ms INTEGER NOT NULL,
      parked_at_ms INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS claude_parked_wakes_due_idx
    ON claude_parked_wakes(due_at_ms)
  `;
});

export const layer = Layer.effect(
  ClaudeWakeParking,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const continuations = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    // One writer at a time over the table.
    const lock = yield* Semaphore.make(1);
    const scheduleChanged = yield* Queue.dropping<void>(1);
    const liveProbe = yield* Ref.make<LiveWakeProbe>(() => Effect.succeed(null));

    const sqlError = (detail: string) => (cause: unknown) =>
      new ClaudeWakeParkingError({ detail, cause });

    const tableReady = yield* ensureTable.pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logError("orchestration-v2.claude-wake.table-failed", { cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

    const signal = Queue.offer(scheduleChanged, undefined).pipe(Effect.asVoid);

    const insertRows = (rows: ReadonlyArray<Parking.ParkedWake>) =>
      sql
        .withTransaction(
          Effect.forEach(
            rows,
            (row) => sql`
              INSERT OR REPLACE INTO claude_parked_wakes (
                wake_id, thread_id, provider_thread_id, native_session_id, kind,
                job_id, cron, prompt, recurring, created_at_ms, due_at_ms, parked_at_ms
              ) VALUES (
                ${row.wakeId}, ${row.threadId}, ${row.providerThreadId}, ${row.nativeSessionId},
                ${row.kind}, ${row.jobId}, ${row.cron}, ${row.prompt}, ${row.recurring ? 1 : 0},
                ${row.createdAtMs}, ${row.dueAtMs}, ${row.parkedAtMs}
              )
            `,
            { discard: true },
          ),
        )
        .pipe(Effect.mapError(sqlError("insert parked wakeups")));

    const deleteRows = (wakeIds: ReadonlyArray<string>) =>
      wakeIds.length === 0
        ? Effect.void
        : sql`DELETE FROM claude_parked_wakes WHERE wake_id IN ${sql.in(wakeIds)}`.pipe(
            Effect.asVoid,
            Effect.mapError(sqlError("delete parked wakeups")),
          );

    const moveRow = (wakeId: string, dueAtMs: number) =>
      sql`UPDATE claude_parked_wakes SET due_at_ms = ${dueAtMs} WHERE wake_id = ${wakeId}`.pipe(
        Effect.asVoid,
        Effect.mapError(sqlError("move a recurring wakeup")),
      );

    const decodeRows = (rows: ReadonlyArray<Parking.ParkedWakeRow>) =>
      Effect.gen(function* () {
        const parked: Array<Parking.ParkedWake> = [];
        for (const row of rows) {
          const decoded = Parking.parkedWakeFromRow(row);
          if (decoded === null) {
            yield* Effect.logWarning("orchestration-v2.claude-wake.unreadable-row", {
              wakeId: row.wake_id,
            });
          } else {
            parked.push(decoded);
          }
        }
        return parked;
      });

    const rowsForThreads = (threadIds: ReadonlyArray<string>) =>
      threadIds.length === 0
        ? Effect.succeed([] as ReadonlyArray<Parking.ParkedWake>)
        : sql<Parking.ParkedWakeRow>`
            SELECT * FROM claude_parked_wakes WHERE thread_id IN ${sql.in(threadIds)}
          `.pipe(Effect.mapError(sqlError("read parked wakeups")), Effect.flatMap(decodeRows));

    // A due row this build cannot read is removed: left in place, it would stay
    // the earliest due time and keep the delivery loop from sleeping.
    const dueRows = (nowMs: number) =>
      sql<Parking.ParkedWakeRow>`
        SELECT * FROM claude_parked_wakes WHERE due_at_ms <= ${nowMs} ORDER BY due_at_ms ASC
      `.pipe(
        Effect.mapError(sqlError("read due wakeups")),
        Effect.flatMap((rows) =>
          decodeRows(rows).pipe(
            Effect.tap((decoded) => {
              const readable = new Set(decoded.map((row) => row.wakeId));
              return deleteRows(rows.flatMap((row) => (readable.has(row.wake_id) ? [] : [row.wake_id])));
            }),
          ),
        ),
      );

    const earliestDue = sql<{ readonly due: number | null }>`
      SELECT MIN(due_at_ms) AS due FROM claude_parked_wakes
    `.pipe(
      Effect.map((rows) => (rows[0]?.due === null || rows[0] === undefined ? null : Number(rows[0].due))),
      Effect.mapError(sqlError("read the next due time")),
    );

    const offerMessage = (row: Parking.ParkedWake) =>
      continuations.offer({
        threadId: ThreadId.make(row.threadId),
        providerThreadId: ProviderThreadId.make(row.providerThreadId),
        driver: CLAUDE_DRIVER,
        detail: Parking.deliveryText(row.prompt),
        delivery: "message_text",
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: DELIVERY_SUMMARY,
        },
      });

    const isSuperseded = (row: Parking.ParkedWake) =>
      row.kind !== "wakeup"
        ? Effect.succeed(false)
        : Ref.get(liveProbe).pipe(
            Effect.flatMap((probe) => probe(row.threadId)),
            Effect.map(
              (live) =>
                live !== null &&
                Parking.supersededWakeups([row], live.lastWakeupCallAtMs).length > 0,
            ),
            Effect.catchCause(() => Effect.succeed(false)),
          );

    /** Sends every due row once and moves or removes it. Under the lock. */
    const deliverDue = Effect.fn("ClaudeWakeParking.deliverDue")(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const row of yield* dueRows(now)) {
        const plan = Parking.planDelivery(row, now);
        // Move or remove first: a crash after the send must not send it again.
        if (plan.nextDueAtMs === null) {
          yield* deleteRows([row.wakeId]);
        } else {
          yield* moveRow(row.wakeId, plan.nextDueAtMs);
        }
        if (yield* isSuperseded(row)) {
          yield* Effect.logInfo("orchestration-v2.claude-wake.superseded", {
            threadId: row.threadId,
            wakeId: row.wakeId,
          });
          continue;
        }
        if (!plan.send) {
          yield* Effect.logWarning("orchestration-v2.claude-wake.too-late", {
            threadId: row.threadId,
            wakeId: row.wakeId,
            dueAtMs: row.dueAtMs,
          });
          continue;
        }
        yield* offerMessage(row);
        yield* Effect.logInfo("orchestration-v2.claude-wake.delivered", {
          threadId: row.threadId,
          wakeId: row.wakeId,
          dueAtMs: row.dueAtMs,
        });
      }
    });

    const deliveryPass = lock.withPermits(1)(
      deliverDue().pipe(Effect.andThen(earliestDue)),
    ).pipe(
      Effect.flatMap((next) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) =>
            next === null ? DELIVERY_MAX_SLEEP_MS : Math.min(Math.max(0, next - now), DELIVERY_MAX_SLEEP_MS),
          ),
        ),
      ),
      // Any failure but an interrupt, a defect included, retries later: the loop must not end.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("orchestration-v2.claude-wake.delivery-failed", { cause }).pipe(
              Effect.as(DELIVERY_RETRY_MS),
            ),
      ),
    );

    if (tableReady) {
      // Rows outlive a restart: the first pass sends what came due while the server was down.
      yield* deliveryPass.pipe(
        Effect.flatMap((sleepMs) =>
          Effect.race(Effect.sleep(Duration.millis(sleepMs)), Queue.take(scheduleChanged)),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
    }

    const pin = (reason: string): ClaudeWakeParkOutcome => ({ type: "pin", reason });

    /**
     * A wakeup parked from an earlier process of these threads that a live
     * process replaced or stopped goes now, sent or not. Under the lock.
     */
    const deleteSupersededLocked = (
      threads: ReadonlyArray<ProviderAdapter.ProviderAdapterV2WakeThread>,
    ) =>
      rowsForThreads(threads.map((thread) => String(thread.threadId))).pipe(
        Effect.map((existing) =>
          threads.flatMap((thread) =>
            Parking.supersededWakeups(
              existing.filter((row) => row.threadId === String(thread.threadId)),
              thread.lastWakeupCallAtMs,
            ),
          ),
        ),
        Effect.flatMap((superseded) => deleteRows(superseded.map((row) => row.wakeId))),
      );

    const dropSuperseded = Effect.fn("ClaudeWakeParking.dropSuperseded")(
      function* (threads: ReadonlyArray<ProviderAdapter.ProviderAdapterV2WakeThread>) {
        if (!tableReady || threads.length === 0) return;
        yield* lock.withPermits(1)(deleteSupersededLocked(threads));
      },
      (effect) =>
        effect.pipe(
          Effect.catch((error) =>
            Effect.logWarning("orchestration-v2.claude-wake.drop-superseded-failed", {
              detail: error.detail,
              cause: error.cause,
            }),
          ),
        ),
    );

    const parkLocked = Effect.fn("ClaudeWakeParking.parkLocked")(function* (input: {
      readonly threads: ReadonlyArray<ProviderAdapter.ProviderAdapterV2WakeThread>;
      readonly idleTimeoutMs: number | null;
    }): Effect.fn.Return<ClaudeWakeParkOutcome, ClaudeWakeParkingError> {
      const now = yield* Clock.currentTimeMillis;
      const plan = Parking.planPark({ threads: input.threads, nowMs: now });
      if (plan.type === "unparkable") return pin(plan.reason);
      const rows = plan.type === "park" ? plan.rows : [];
      const earliest = Parking.earliestDueMs(rows);
      if (
        input.idleTimeoutMs !== null &&
        earliest !== null &&
        Parking.decideIdleRelease({
          earliestDueMs: earliest,
          nowMs: now,
          idleTimeoutMs: input.idleTimeoutMs,
        }) === "pin"
      ) {
        return pin("a wakeup is due soon");
      }
      yield* deleteSupersededLocked(input.threads);
      if (rows.length === 0) return { type: "none" };
      yield* insertRows(rows);
      return { type: "parked", rows };
    });

    const parkBeforeRelease = Effect.fn("ClaudeWakeParking.parkBeforeRelease")(
      function* (input: Parameters<ClaudeWakeParkingShape["parkBeforeRelease"]>[0]) {
        if (!tableReady) {
          // Without the table nothing can be parked: keep only a process that holds a wakeup.
          const now = yield* Clock.currentTimeMillis;
          const plan = Parking.planPark({ threads: input.threads, nowMs: now });
          return plan.type === "none" ? { type: "none" as const } : pin("the parked-wakeups table is missing");
        }
        const outcome = yield* lock.withPermits(1)(parkLocked(input));
        if (outcome.type === "parked") {
          yield* Effect.logInfo("orchestration-v2.claude-wake.parked", {
            threadIds: [...new Set(outcome.rows.map((row) => row.threadId))],
            count: outcome.rows.length,
          });
          yield* signal;
        }
        return outcome;
      },
      (effect) =>
        effect.pipe(
          Effect.catch((error) =>
            Effect.logWarning("orchestration-v2.claude-wake.park-failed", {
              detail: error.detail,
              cause: error.cause,
            }).pipe(Effect.as(pin(`parking failed: ${error.detail}`))),
          ),
        ),
    );

    const undoPark = Effect.fn("ClaudeWakeParking.undoPark")(
      function* (rows: ReadonlyArray<Parking.ParkedWake>) {
        yield* lock.withPermits(1)(deleteRows(rows.map((row) => row.wakeId)));
        yield* signal;
      },
      (effect) =>
        effect.pipe(
          Effect.catch((error) =>
            Effect.logWarning("orchestration-v2.claude-wake.undo-failed", {
              detail: error.detail,
              cause: error.cause,
            }),
          ),
        ),
    );

    const threadOpened = Effect.fn("ClaudeWakeParking.threadOpened")(
      function* (threadId: string) {
        if (!tableReady) return [] as ReadonlyArray<Parking.ParkedWake>;
        const adopted = yield* lock.withPermits(1)(
          rowsForThreads([threadId]).pipe(
            Effect.map((rows) => rows.filter((row) => row.kind === "cron")),
            Effect.tap((jobs) => deleteRows(jobs.map((row) => row.wakeId))),
          ),
        );
        if (adopted.length > 0) {
          yield* Effect.logInfo("orchestration-v2.claude-wake.adopted", {
            threadId,
            count: adopted.length,
          });
          yield* signal;
        }
        return adopted;
      },
      (effect, threadId) =>
        effect.pipe(
          Effect.catch((error) =>
            Effect.logWarning("orchestration-v2.claude-wake.adopt-failed", {
              threadId,
              detail: error.detail,
              cause: error.cause,
            }).pipe(Effect.as([] as ReadonlyArray<Parking.ParkedWake>)),
          ),
        ),
    );

    const setLiveWakeProbe = (probe: LiveWakeProbe) => Ref.set(liveProbe, probe);

    return ClaudeWakeParking.of({
      parkBeforeRelease,
      undoPark,
      dropSuperseded,
      threadOpened,
      setLiveWakeProbe,
    });
  }),
);
