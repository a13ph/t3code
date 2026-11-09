// @effect-diagnostics globalDate:off - local calendar times for cron.
import { assert, it } from "@effect/vitest";
import { ProviderThreadId, ThreadId } from "@t3tools/contracts";
import type { ProviderAdapterV2WakeThread } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { LATE_DELIVERY_LIMIT_MS } from "./ClaudeWakeParking.ts";
import * as ClaudeWakeParkingService from "./ClaudeWakeParkingService.ts";

const MINUTE = 60_000;
const NOW = new Date(2026, 5, 15, 10, 0).getTime();
const IDLE = 5 * MINUTE;

type Offer = ProviderContinuationRequests.ProviderContinuationRequest;

// The delivery loop is a forked fiber: give it turns after each clock move.
const settle = Effect.gen(function* () {
  for (let i = 0; i < 50; i += 1) yield* Effect.yieldNow;
});

const advance = (ms: number) => TestClock.adjust(ms).pipe(Effect.andThen(settle));

const parkedRowCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM claude_parked_wakes`;
  return Number(rows[0]?.n ?? 0);
}).pipe(Effect.orDie);

const thread = (
  wakes: ProviderAdapterV2WakeThread["wakes"],
  lastWakeupCallAtMs: number | null = null,
): ProviderAdapterV2WakeThread => ({
  threadId: ThreadId.make("thread-wake-service"),
  providerThreadId: ProviderThreadId.make("provider-thread-wake-service"),
  nativeSessionId: "session-a",
  wakes,
  lastWakeupCallAtMs,
});

const loopWakeup = (dueAtMs: number, toolUseId = "toolu_1") => ({
  kind: "wakeup" as const,
  toolUseId,
  dueAtMs,
  prompt: "<<autonomous-loop-dynamic>>",
});

/** Runs `body` with the service built over the in-memory database. */
const withService = <A, E>(
  body: (input: {
    readonly service: ClaudeWakeParkingService.ClaudeWakeParkingShape;
    readonly offers: Ref.Ref<ReadonlyArray<Offer>>;
  }) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const offers = yield* Ref.make<ReadonlyArray<Offer>>([]);
    const continuationLayer = Layer.succeed(
      ProviderContinuationRequests.ProviderContinuationRequests,
      {
        offer: (request) => Ref.update(offers, (seen) => [...seen, request]),
        take: Effect.never,
      },
    );
    return yield* Effect.gen(function* () {
      const service = yield* ClaudeWakeParkingService.ClaudeWakeParking;
      yield* settle;
      return yield* body({ service, offers });
    }).pipe(Effect.provide(ClaudeWakeParkingService.layer.pipe(Layer.provide(continuationLayer))));
  });

it.effect("sends a parked wakeup once, as one Scheduled wakeup message, when it is due", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* withService(({ service, offers }) =>
      Effect.gen(function* () {
        const outcome = yield* service.parkBeforeRelease({
          threads: [thread([loopWakeup(NOW + 30 * MINUTE)])],
          idleTimeoutMs: IDLE,
        });
        assert.equal(outcome.type, "parked");
        assert.equal(yield* parkedRowCount, 1);
        yield* advance(30 * MINUTE - 1_000);
        assert.deepEqual(yield* Ref.get(offers), []);
        yield* advance(1_000);
        const sent = yield* Ref.get(offers);
        assert.equal(sent.length, 1);
        assert.equal(sent[0]?.threadId, "thread-wake-service");
        assert.equal(sent[0]?.providerThreadId, "provider-thread-wake-service");
        assert.equal(sent[0]?.detail, "/loop");
        assert.equal(sent[0]?.delivery, "message_text");
        assert.equal(sent[0]?.notification?.summary, "Scheduled wakeup");
        assert.equal(yield* parkedRowCount, 0);
        yield* advance(60 * MINUTE);
        assert.equal((yield* Ref.get(offers)).length, 1);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps the process for a wakeup due before the next idle check, parking nothing", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* withService(({ service, offers }) =>
      Effect.gen(function* () {
        const outcome = yield* service.parkBeforeRelease({
          threads: [thread([loopWakeup(NOW + 6 * MINUTE)])],
          idleTimeoutMs: IDLE,
        });
        assert.equal(outcome.type, "pin");
        assert.equal(yield* parkedRowCount, 0);
        // Spent pin budget or shutdown: the process ends, so it is parked after
        // all, even one due within the lead time.
        const forced = yield* service.parkBeforeRelease({
          threads: [thread([loopWakeup(NOW + MINUTE)])],
          idleTimeoutMs: null,
        });
        assert.equal(forced.type, "parked");
        yield* advance(MINUTE);
        assert.equal((yield* Ref.get(offers)).length, 1);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps the process for a job it cannot read, and parks the rest when forced", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* withService(({ service }) =>
      Effect.gen(function* () {
        const wakes = [
          {
            kind: "cron" as const,
            jobId: "x",
            cron: "@hourly",
            prompt: "p",
            recurring: true,
            createdAtMs: NOW,
            dueAtMs: null,
          },
          loopWakeup(NOW + 60 * MINUTE),
        ];
        const outcome = yield* service.parkBeforeRelease({
          threads: [thread(wakes)],
          idleTimeoutMs: IDLE,
        });
        assert.equal(outcome.type, "pin");
        assert.equal(yield* parkedRowCount, 0);
        const forced = yield* service.parkBeforeRelease({
          threads: [thread(wakes)],
          idleTimeoutMs: null,
        });
        assert.equal(forced.type, "parked");
        assert.equal(yield* parkedRowCount, 1);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("hands a resumed session its scheduled jobs and still sends its ScheduleWakeup", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* withService(({ service, offers }) =>
      Effect.gen(function* () {
        yield* service.parkBeforeRelease({
          threads: [
            thread([
              loopWakeup(NOW + 40 * MINUTE),
              {
                kind: "cron",
                jobId: "f851d733",
                cron: "30 10 15 6 *",
                prompt: "say PING",
                recurring: false,
                createdAtMs: NOW - MINUTE,
                dueAtMs: NOW + 30 * MINUTE,
              },
            ]),
          ],
          idleTimeoutMs: IDLE,
        });
        assert.equal(yield* parkedRowCount, 2);
        const adopted = yield* service.threadOpened("thread-wake-service");
        assert.deepEqual(
          adopted.map((row) => row.jobId),
          ["f851d733"],
        );
        assert.equal(yield* parkedRowCount, 1);
        // The resumed process fires the job itself: T3 stays silent at its due time.
        yield* advance(30 * MINUTE);
        assert.deepEqual(yield* Ref.get(offers), []);
        // A resume does not restore a ScheduleWakeup, so T3 sends it.
        yield* advance(10 * MINUTE);
        assert.deepEqual(
          (yield* Ref.get(offers)).map((offer) => offer.detail),
          ["/loop"],
        );
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("skips a parked wakeup that the thread's live process replaced", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* withService(({ service, offers }) =>
      Effect.gen(function* () {
        yield* service.parkBeforeRelease({
          threads: [thread([loopWakeup(NOW + 30 * MINUTE)])],
          idleTimeoutMs: IDLE,
        });
        yield* service.setLiveWakeProbe((threadId) =>
          Effect.succeed(
            threadId === "thread-wake-service"
              ? thread([loopWakeup(NOW + 50 * MINUTE, "toolu_2")], NOW + MINUTE)
              : null,
          ),
        );
        yield* advance(30 * MINUTE);
        assert.deepEqual(yield* Ref.get(offers), []);
        assert.equal(yield* parkedRowCount, 0);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("sends a parked wakeup when the live process scheduled nothing since", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* withService(({ service, offers }) =>
      Effect.gen(function* () {
        yield* service.parkBeforeRelease({
          threads: [thread([loopWakeup(NOW + 30 * MINUTE)])],
          idleTimeoutMs: IDLE,
        });
        // The live process last called ScheduleWakeup before this one was parked.
        yield* service.setLiveWakeProbe(() => Effect.succeed(thread([], NOW - MINUTE)));
        yield* advance(30 * MINUTE);
        assert.equal((yield* Ref.get(offers)).length, 1);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("drops a parked wakeup a later process replaced when that process is parked", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* withService(({ service, offers }) =>
      Effect.gen(function* () {
        yield* service.parkBeforeRelease({
          threads: [thread([loopWakeup(NOW + 30 * MINUTE)])],
          idleTimeoutMs: IDLE,
        });
        yield* advance(MINUTE);
        yield* service.parkBeforeRelease({
          threads: [thread([loopWakeup(NOW + 60 * MINUTE, "toolu_2")], NOW + MINUTE)],
          idleTimeoutMs: IDLE,
        });
        assert.equal(yield* parkedRowCount, 1);
        yield* advance(60 * MINUTE);
        assert.equal((yield* Ref.get(offers)).length, 1);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("drops a parked wakeup that a process kept across a restart replaced", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* withService(({ service, offers }) =>
      Effect.gen(function* () {
        yield* service.parkBeforeRelease({
          threads: [thread([loopWakeup(NOW + 30 * MINUTE)])],
          idleTimeoutMs: IDLE,
        });
        yield* advance(MINUTE);
        // Shutdown with the new process mid-turn: it keeps its own wakeup, nothing is parked.
        yield* service.dropSuperseded([
          thread([loopWakeup(NOW + 50 * MINUTE, "toolu_2")], NOW + MINUTE),
        ]);
        assert.equal(yield* parkedRowCount, 0);
        yield* advance(60 * MINUTE);
        assert.deepEqual(yield* Ref.get(offers), []);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("removes a due row this build cannot read and goes on delivering", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* withService(({ service, offers }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO claude_parked_wakes (
            wake_id, thread_id, provider_thread_id, native_session_id, kind,
            job_id, cron, prompt, recurring, created_at_ms, due_at_ms, parked_at_ms
          ) VALUES (
            'future-row', 'thread-wake-service', 'provider-thread-wake-service', 'session-a',
            'future', NULL, NULL, 'p', 0, ${NOW}, ${NOW + MINUTE}, ${NOW}
          )
        `.pipe(Effect.orDie);
        yield* service.parkBeforeRelease({
          threads: [thread([loopWakeup(NOW + 30 * MINUTE)])],
          idleTimeoutMs: IDLE,
        });
        yield* advance(MINUTE);
        assert.equal(yield* parkedRowCount, 1);
        yield* advance(29 * MINUTE);
        assert.equal((yield* Ref.get(offers)).length, 1);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("sends a recurring job at each due time", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* withService(({ service, offers }) =>
      Effect.gen(function* () {
        yield* service.parkBeforeRelease({
          threads: [
            thread([
              {
                kind: "cron",
                jobId: "0a1b2c3d",
                cron: "*/15 * * * *",
                prompt: "check the queue",
                recurring: true,
                createdAtMs: NOW - MINUTE,
                dueAtMs: null,
              },
            ]),
          ],
          idleTimeoutMs: IDLE,
        });
        yield* advance(15 * MINUTE);
        yield* advance(15 * MINUTE);
        assert.deepEqual(
          (yield* Ref.get(offers)).map((offer) => offer.detail),
          ["check the queue", "check the queue"],
        );
        assert.equal(yield* parkedRowCount, 1);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("gives nothing back when the release did not happen", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* withService(({ service, offers }) =>
      Effect.gen(function* () {
        const outcome = yield* service.parkBeforeRelease({
          threads: [thread([loopWakeup(NOW + 30 * MINUTE)])],
          idleTimeoutMs: IDLE,
        });
        yield* service.undoPark(outcome.type === "parked" ? outcome.rows : []);
        assert.equal(yield* parkedRowCount, 0);
        yield* advance(30 * MINUTE);
        assert.deepEqual(yield* Ref.get(offers), []);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps parked wakeups across a restart, and drops one found long overdue", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* withService(({ service }) =>
      service.parkBeforeRelease({
        threads: [
          thread([loopWakeup(NOW + 30 * MINUTE)]),
          {
            ...thread([loopWakeup(NOW + 120 * MINUTE, "toolu_y")]),
            threadId: ThreadId.make("thread-later"),
          },
        ],
        idleTimeoutMs: IDLE,
      }),
    );
    // The server is down past the first wakeup's due time by more than the late limit.
    yield* TestClock.setTime(NOW + 30 * MINUTE + LATE_DELIVERY_LIMIT_MS + MINUTE);
    yield* withService(({ offers }) =>
      Effect.gen(function* () {
        assert.deepEqual(yield* Ref.get(offers), []);
        assert.equal(yield* parkedRowCount, 1);
        yield* advance(120 * MINUTE);
        assert.deepEqual(
          (yield* Ref.get(offers)).map((offer) => offer.threadId),
          ["thread-later"],
        );
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);
