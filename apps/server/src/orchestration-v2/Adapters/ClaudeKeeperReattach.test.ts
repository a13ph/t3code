import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  fakeClaudeCli,
  firstKeeperAck,
  keeperSocket,
  keeperTestModelSelection as modelSelection,
  makeKeeperTestAdapter,
  realQueryRunner,
  SLOW_COMMAND,
  SLOW_COMMAND_REPLY,
} from "./ClaudeKeeper.testkit.ts";
import {
  detachKeeperChildren,
  keeperDetachedThreads,
  keeperTurnStateThreads,
} from "./ClaudeKeeperSpawn.ts";
// @ts-ignore - plain ESM without types
import { request as keeperRequest } from "../../t3Keeper/shim.mjs";

const runtimePolicy = (cwd: string) =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd,
  });

function turnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly cwd: string;
  readonly reattach?: ProviderAdapter.ProviderAdapterV2Reattach;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make("project-keeper-reattach"),
      title: "Keeper reattach",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId: input.threadId,
    runId: RunId.make("run-keeper-reattach"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("attempt-keeper-reattach"),
    rootNodeId: NodeId.make("node-keeper-reattach"),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make("message-keeper-reattach"),
      text: "Run the slow command.",
      attachments: [],
    },
    modelSelection,
    runtimePolicy: runtimePolicy(input.cwd),
    ...(input.reattach === undefined ? {} : { reattach: input.reattach }),
  };
}

/** Opens a session in a scope of its own and collects its events. */
const openSession = (
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  threadId: ThreadId,
  cwd: string,
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const runtime = yield* adapter
      .openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-keeper-reattach"),
        modelSelection,
        runtimePolicy: runtimePolicy(cwd),
      })
      .pipe(Scope.provide(scope));
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    const watchers: Array<{
      readonly test: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean;
      readonly done: Deferred.Deferred<void>;
    }> = [];
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          for (const watcher of watchers) {
            if (watcher.test(event)) yield* Deferred.succeed(watcher.done, undefined);
          }
        }),
      ),
      Effect.forkIn(scope),
    );
    const awaitEvent = (test: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        watchers.push({ test, done });
        if (events.some(test)) yield* Deferred.succeed(done, undefined);
        yield* Deferred.await(done);
      });
    return { runtime, events, awaitEvent, close: Scope.close(scope, Exit.void) };
  });

const toolItem = (event: ProviderAdapter.ProviderAdapterV2Event) =>
  event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === "toolu_1"
    ? event.turnItem
    : undefined;

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "Claude turn across a restart",
  () => {
    // A restart in the middle of a Bash call: the old server detaches and
    // closes, the CLI keeps running in the keeper, and a new adapter attached
    // from the acknowledged line gets the call's result and the turn's end.
    it.effect("finishes the turn in the CLI the keeper held over the restart", () =>
      Effect.gen(function* () {
        const keeper = yield* keeperSocket;
        const fake = yield* fakeClaudeCli;
        const acked = yield* firstKeeperAck;
        const threadId = ThreadId.make("thread-keeper-reattach");

        // The server before the restart.
        const before = yield* openSession(
          yield* makeKeeperTestAdapter(fake.cli, fake.dir),
          threadId,
          fake.dir,
        );
        const providerThread = yield* before.runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: runtimePolicy(fake.dir),
        });
        const now = yield* DateTime.now;
        yield* before.runtime.startTurn(
          turnInput({ threadId, providerThread, now, cwd: fake.dir }),
        );
        yield* before.awaitEvent((event) => toolItem(event)?.status === "running");
        const ackedLine = yield* acked;
        assert.equal(detachKeeperChildren(), 1);
        const detached = keeperDetachedThreads().get(threadId);
        assert.isDefined(detached);
        yield* before.close;
        const runningItem = before.events.map(toolItem).findLast((item) => item !== undefined)!;
        const list = yield* Effect.promise(() => keeperRequest(keeper.socketPath, { op: "list" }));
        assert.deepEqual(
          list.handles.map((h: { name: string; alive: boolean; attached: boolean }) => [
            h.name,
            h.alive,
            h.attached,
          ]),
          [[threadId, true, false]],
        );
        assert.equal(list.handles[0].acked, ackedLine);

        // The server after it.
        const after = yield* openSession(
          yield* makeKeeperTestAdapter(fake.cli, fake.dir),
          threadId,
          fake.dir,
        );
        yield* after.runtime.startTurn(
          turnInput({
            threadId,
            providerThread: { ...providerThread, status: "active" },
            now,
            cwd: fake.dir,
            reattach: {
              handle: detached!.handle,
              after: list.handles[0].acked,
              turnItems: [runningItem as OrchestrationV2TurnItem],
              adapterState: detached!.adapterState,
            },
          }),
        );
        fake.release();
        yield* after.awaitEvent((event) => event.type === "turn.terminal");

        const terminal = after.events.find((event) => event.type === "turn.terminal");
        assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "completed");
        const completed = after.events.map(toolItem).findLast((item) => item !== undefined);
        assert.equal(completed?.id, runningItem.id);
        assert.equal(completed?.ordinal, runningItem.ordinal);
        assert.equal(completed?.status, "completed");
        assert.equal(
          completed?.type === "command_execution" ? completed.input : undefined,
          SLOW_COMMAND,
        );
        const reply = after.events.find(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
        );
        assert.equal(
          reply?.type === "turn_item.updated" && reply.turnItem.type === "assistant_message"
            ? reply.turnItem.text
            : undefined,
          SLOW_COMMAND_REPLY,
        );
        assert.isAbove(
          reply?.type === "turn_item.updated" ? reply.turnItem.ordinal : 0,
          runningItem.ordinal,
        );
        yield* after.close;
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
    );

    // The turn state a shutdown records is kept per thread only for a CLI
    // in the keeper, and only while its query runs.
    it.effect("keeps a thread's turn state only while its CLI runs in the keeper", () =>
      Effect.gen(function* () {
        const runTurn = (threadId: ThreadId) =>
          Effect.gen(function* () {
            const fake = yield* fakeClaudeCli;
            const session = yield* openSession(
              yield* makeKeeperTestAdapter(fake.cli, fake.dir),
              threadId,
              fake.dir,
            );
            const providerThread = yield* session.runtime.ensureThread({
              threadId,
              modelSelection,
              runtimePolicy: runtimePolicy(fake.dir),
            });
            const now = yield* DateTime.now;
            yield* session.runtime.startTurn(
              turnInput({ threadId, providerThread, now, cwd: fake.dir }),
            );
            yield* session.awaitEvent((event) => toolItem(event)?.status === "running");
            const whileRunning = keeperTurnStateThreads().includes(threadId);
            fake.release();
            yield* session.awaitEvent((event) => event.type === "turn.terminal");
            yield* session.close;
            return { whileRunning, afterClose: keeperTurnStateThreads().includes(threadId) };
          }).pipe(Effect.scoped);

        const plain = yield* runTurn(ThreadId.make("thread-turn-state-plain"));
        assert.deepEqual(plain, { whileRunning: false, afterClose: false });
        const kept = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* keeperSocket;
            return yield* runTurn(ThreadId.make("thread-turn-state-kept"));
          }),
        );
        assert.deepEqual(kept, { whileRunning: true, afterClose: false });
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
    );
  },
);
