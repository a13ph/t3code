// @effect-diagnostics nodeBuiltinImport:off -- the fake CLI and the keeper are real processes and sockets.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { detachKeeperChildren, keeperDetachedThreads } from "./ClaudeKeeperSpawn.ts";
// @ts-ignore - plain ESM without types
import { startKeeper } from "../../t3Keeper/keeper.mjs";
// @ts-ignore - plain ESM without types
import { KeeperProcess, request as keeperRequest } from "../../t3Keeper/shim.mjs";

const settings = Schema.decodeSync(ClaudeSettings)({});
const modelSelection = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
};

// A stand-in for the Claude CLI on the stream-json protocol: it answers every
// control request, and on the first prompt starts a Bash call, then holds
// until the test creates `release`, then reports the call's result, a reply
// and the turn's result.
const FAKE_CLI = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
const dir = path.dirname(process.argv[1]);
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const assistant = (id, content) => ({
  type: "assistant", uuid: "a-" + id, session_id: "s", parent_tool_use_id: null,
  message: { id, type: "message", role: "assistant", model: "claude-sonnet-4-6", content,
    stop_reason: null, stop_sequence: null, usage },
});
let prompted = false;
const turn = async () => {
  out(assistant("msg_tool", [{ type: "tool_use", id: "toolu_1", name: "Bash",
    input: { command: "sleep 60; echo done-4857" } }]));
  while (!fs.existsSync(path.join(dir, "release"))) await new Promise((r) => setTimeout(r, 20));
  out({ type: "user", uuid: "u-result", session_id: "s", parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1",
      is_error: false, content: "done-4857" }] } });
  out(assistant("msg_reply", [{ type: "text", text: "The command printed done-4857." }]));
  out({ type: "result", subtype: "success", uuid: "r-1", session_id: "s", is_error: false,
    num_turns: 1, result: "The command printed done-4857.", stop_reason: "end_turn",
    duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage, modelUsage: {},
    permission_denials: [], terminal_reason: "completed" });
};
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.type === "control_request") {
    const response = m.request.subtype === "initialize"
      ? { commands: [], models: [], account: {}, output_style: "default", available_output_styles: [] }
      : m.request.subtype === "mcp_set_servers" ? { added: [], removed: [], errors: {} } : {};
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
  } else if (m.type === "user" && !prompted) {
    prompted = true;
    void turn();
  }
});
lines.on("close", () => process.exit(0));
`;

function fakeClaudeCli(): { readonly cli: string; readonly dir: string } {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-reattach-"));
  NodeFS.writeFileSync(NodePath.join(dir, "cli.mjs"), FAKE_CLI);
  const cli = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(
    cli,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$(dirname "$0")/cli.mjs"\n`,
    { mode: 0o755 },
  );
  return { cli, dir };
}

/** A keeper serving a fresh socket, named in T3_KEEPER_SOCKET while the test runs. */
const keeperSocket = Effect.gen(function* () {
  const { keeper } = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-keeper-"));
      const keeper = await startKeeper({
        socketPath: NodePath.join(dir, "keeper.sock"),
        log: () => {},
      });
      return { keeper, dir };
    }),
    ({ keeper, dir }) =>
      Effect.promise(async () => {
        await keeper.close();
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.T3_KEEPER_SOCKET;
      process.env.T3_KEEPER_SOCKET = keeper.socketPath;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.T3_KEEPER_SOCKET;
        else process.env.T3_KEEPER_SOCKET = previous;
      }),
  );
  return keeper;
});

const realQueryRunner = ClaudeAdapterV2.layerQueryRunner.pipe(
  Layer.provide(Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined })),
  Layer.provide(NodeServices.layer),
);

const makeAdapter = (binaryPath: string, attachmentsDir: string) =>
  Effect.gen(function* () {
    return yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: modelSelection.instanceId,
      settings: { ...settings, binaryPath },
      environment: { ...process.env },
      attachmentsDir,
      fileSystem: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
    });
  });

function turnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly cwd: string;
  readonly reattach?: ProviderAdapter.ProviderAdapterV2Reattach;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  const attemptId = RunAttemptId.make("attempt-keeper-reattach");
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
    attemptId,
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
    runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: input.cwd,
    }),
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
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd,
        }),
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
        const { cli, dir } = fakeClaudeCli();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
        );
        const threadId = ThreadId.make("thread-keeper-reattach");
        const acked = yield* Deferred.make<number>();
        const ack = vi.spyOn(KeeperProcess.prototype, "ack").mockImplementation(function (
          this: { _request: (msg: unknown) => Promise<unknown> },
          after: number,
        ) {
          const sent = this._request({ op: "ack", after });
          void sent.then(() => Deferred.doneUnsafe(acked, Exit.succeed(after)));
          return sent;
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => ack.mockRestore()));

        // The server before the restart.
        const before = yield* openSession(yield* makeAdapter(cli, dir), threadId, dir);
        const providerThread = yield* before.runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: dir,
          }),
        });
        const now = yield* DateTime.now;
        yield* before.runtime.startTurn(turnInput({ threadId, providerThread, now, cwd: dir }));
        yield* before.awaitEvent((event) => toolItem(event)?.status === "running");
        const ackedLine = yield* Deferred.await(acked);
        assert.equal(detachKeeperChildren(), 1);
        const detached = keeperDetachedThreads().get(threadId);
        assert.isDefined(detached);
        yield* before.close;
        assert.isFalse(before.events.some((event) => event.type === "turn.terminal"));
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
        const after = yield* openSession(yield* makeAdapter(cli, dir), threadId, dir);
        yield* after.runtime.startTurn(
          turnInput({
            threadId,
            providerThread: { ...providerThread, status: "active" },
            now,
            cwd: dir,
            reattach: {
              handle: detached!.handle,
              after: list.handles[0].acked,
              turnItems: [runningItem as OrchestrationV2TurnItem],
              adapterState: detached!.adapterState,
            },
          }),
        );
        NodeFS.writeFileSync(NodePath.join(dir, "release"), "");
        yield* after.awaitEvent((event) => event.type === "turn.terminal");

        const terminal = after.events.find((event) => event.type === "turn.terminal");
        assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "completed");
        const completed = after.events.map(toolItem).findLast((item) => item !== undefined);
        assert.equal(completed?.id, runningItem.id);
        assert.equal(completed?.ordinal, runningItem.ordinal);
        assert.equal(completed?.status, "completed");
        assert.equal(
          completed?.type === "command_execution" ? completed.input : undefined,
          "sleep 60; echo done-4857",
        );
        assert.include(
          after.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
              ? [event.turnItem.text]
              : [],
          ),
          "The command printed done-4857.",
        );
        const reply = after.events.find(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
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
  },
);
