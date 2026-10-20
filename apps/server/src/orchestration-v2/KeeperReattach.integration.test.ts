import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  fakeClaudeCli,
  firstKeeperAck,
  keeperSocket,
  keeperTestModelSelection as modelSelection,
  makeKeeperTestAdapter,
  realQueryRunner,
  SLOW_COMMAND,
  SLOW_COMMAND_REPLY,
} from "./Adapters/ClaudeKeeper.testkit.ts";
import { detachKeeperChildren } from "./Adapters/ClaudeKeeperSpawn.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const threadId = ThreadId.make("thread:keeper-reattach");

/**
 * The server's shutdown steps that read and write the database, after its
 * sessions were released: what `serverRuntimeStartup`'s finalizer runs.
 */
const layerShutdownRecovery = (databaseLayer: ReturnType<typeof sqliteAt>) => {
  const layerStores = Layer.mergeAll(
    EventStore.layer,
    ProjectionStore.layer,
    ProjectStore.layer,
    CommandReceiptStore.layer,
    EffectOutbox.layer,
    TurnItemPositionStore.layer,
  ).pipe(Layer.provide(databaseLayer));
  const layerEventSink = EventSink.layerFromStores.pipe(
    Layer.provide(Layer.mergeAll(layerStores, databaseLayer)),
  );
  return ProviderRuntimeRecoveryService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerStores,
        layerEventSink,
        IdAllocator.layer,
        ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }).pipe(Layer.orDie),
      ),
    ),
  );
};

const sqliteAt = (dbPath: string) =>
  SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(predicate),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "T3 restart during a Claude turn",
  () => {
    // A detached CLI whose thread got no reattach record (an open subagent,
    // a pending approval) would otherwise work on unseen until its turn ends.
    it("closes the detached CLIs no reattach was recorded for", async () => {
      const closed: Array<string> = [];
      const result = await ProviderRuntimeRecoveryService.closeUnrecordedKeeperThreads(
        new Map([
          ["thread:recorded", { handle: "h-recorded" }],
          ["thread:subagent", { handle: "h-subagent" }],
          ["thread:approval", { handle: "h-approval" }],
        ]),
        new Set(["thread:recorded"]),
        async (handle) => {
          closed.push(handle);
          return true;
        },
      );
      assert.deepEqual([...result].sort(), ["h-approval", "h-subagent"]);
      assert.deepEqual(closed.sort(), ["h-approval", "h-subagent"]);
    });

    // The done condition of the keeper reattach: a restart during a running
    // Bash call leaves the turn running, and its later output lands in the
    // same run, which completes with its checkpoint.
    it.effect("lands the turn's later output in the same run after the restart", () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* keeperSocket;
          const fake = yield* fakeClaudeCli;
          const acked = yield* firstKeeperAck;
          const cwd = yield* checkpointWorkspace("keeper-reattach");
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-keeper-reattach-" });
          const databaseLayer = sqliteAt(path.join(stateDir, "state.sqlite"));
          const harness = (adapter: Parameters<typeof ProviderAdapterRegistry.layerSingle>[0]) =>
            ProviderReplayHarness.layerWithRegistry(
              { name: "keeper-reattach", runtimePolicyOverride: { cwd } },
              ProviderAdapterRegistry.layerSingle(adapter),
              { databaseLayer, recoverOnStartup: true },
            );

          // The server before the restart: the turn is in its Bash call.
          const runId = yield* Effect.scoped(
            Effect.gen(function* () {
              const orchestrator = yield* Orchestrator.OrchestratorV2;
              yield* orchestrator.dispatch({
                type: "thread.create",
                commandId: CommandId.make("create"),
                threadId,
                projectId: ProjectId.make("project:keeper-reattach"),
                title: "Keeper reattach",
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: cwd,
                createdBy: "user",
                creationSource: "web",
              });
              const toolRunning = yield* watch(
                (event) =>
                  event.type === "turn-item.updated" &&
                  event.payload.nativeItemRef?.nativeId === "toolu_1" &&
                  event.payload.status === "running",
              );
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make("first"),
                threadId,
                messageId: MessageId.make("first"),
                text: "Run the slow command.",
                attachments: [],
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              });
              yield* Fiber.join(toolRunning);
              yield* acked;
              // SIGTERM: the keeper children are detached before anything closes.
              assert.equal(detachKeeperChildren(), 1);
              return (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.id;
            }).pipe(Effect.provide(harness(yield* makeKeeperTestAdapter(fake.cli, fake.dir)))),
          );

          // The rest of the shutdown, then what it left behind.
          yield* Effect.gen(function* () {
            const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
            yield* recovery.prepareForShutdown;
            yield* recovery.reconcile("shutdown");
            const projection =
              yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(threadId);
            assert.equal(projection.runs[0]?.status, "running");
            assert.deepEqual(
              projection.providerSessions.map((session) => session.status),
              ["ready"],
            );
            const outbox = yield* EffectOutbox.EffectOutboxV2;
            const reattaches = yield* outbox.listByCommandId(
              ProviderRuntimeRecoveryService.keeperReattachCommandId(runId),
            );
            assert.deepEqual(
              reattaches.map((effect) => [effect.request.type, effect.status]),
              [["provider-turn.reattach", "pending"]],
            );
            assert.deepEqual(
              yield* outbox.listByCommandId(CommandId.make(`command:restart-prepare:${runId}`)),
              [],
            );
          }).pipe(Effect.provide(layerShutdownRecovery(databaseLayer)), Effect.scoped);

          // The server after it: recovery leaves the run to the reattach,
          // the worker attaches, and the Bash call finishes.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const orchestrator = yield* Orchestrator.OrchestratorV2;
              const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
              const settled = yield* watch(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.id === runId &&
                  event.payload.status === "waiting",
              );
              yield* worker.drain();
              assert.deepEqual(
                (yield* orchestrator.getThreadProjection(threadId)).runs.map((run) => run.status),
                ["running"],
              );
              fake.release();
              yield* Fiber.join(settled);
              yield* worker.drain();
              const projection = yield* orchestrator.getThreadProjection(threadId);
              assert.deepEqual(
                projection.runs.map((run) => [run.id, run.status]),
                [[runId, "completed"]],
              );
              const tool = projection.turnItems.find(
                (item) => item.nativeItemRef?.nativeId === "toolu_1",
              );
              assert.equal(tool?.runId, runId);
              assert.equal(tool?.status, "completed");
              assert.equal(
                tool?.type === "command_execution" ? tool.input : undefined,
                SLOW_COMMAND,
              );
              const replies = projection.turnItems.filter(
                (item) => item.type === "assistant_message" && item.runId === runId,
              );
              assert.deepEqual(
                replies.map((item) => (item.type === "assistant_message" ? item.text : "")),
                [SLOW_COMMAND_REPLY],
              );
              assert.isTrue(
                projection.checkpoints.some((checkpoint) => checkpoint.runId === runId),
              );
            }).pipe(Effect.provide(harness(yield* makeKeeperTestAdapter(fake.cli, fake.dir)))),
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              realQueryRunner,
              IdAllocator.layer,
              McpProviderSessions.layer,
              NodeServices.layer,
            ),
          ),
        ),
      ),
    );
  },
);
