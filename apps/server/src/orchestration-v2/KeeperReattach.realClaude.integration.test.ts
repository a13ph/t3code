// @effect-diagnostics nodeBuiltinImport:off -- the real CLI, the keeper and an MCP stub are real processes and sockets.
// @effect-diagnostics globalRandom:off globalDate:off -- prompt markers and the wall-clock progress log are plain helpers outside Effect.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  firstKeeperAck,
  keeperSocketWith,
  keeperTestModelSelection,
  makeKeeperTestAdapter,
  realQueryRunner,
} from "./Adapters/ClaudeKeeper.testkit.ts";
import { detachKeeperChildren } from "./Adapters/ClaudeKeeperSpawn.ts";
// @ts-ignore - plain ESM without types
import { request as keeperRequest } from "../t3Keeper/shim.mjs";
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

// Opt-in: the real `claude` on the user's login, small haiku turns.
// T3K_REAL_CLAUDE=1 runs it; T3K_CLAUDE names another binary.
const enabled = process.env.T3K_REAL_CLAUDE === "1";
const realClaudeBinary = () => {
  const named = process.env.T3K_CLAUDE ?? `${process.env.HOME}/.local/bin/claude`;
  return NodeFS.realpathSync(named);
};

const threadId = ThreadId.make("thread:keeper-reattach-real");
const modelSelection = { ...keeperTestModelSelection, model: process.env.T3K_MODEL ?? "haiku" };
const tag = () => Math.random().toString(36).slice(2, 8);

// The turn the restart lands in, and the runs the thread ends with.
interface Scenario {
  readonly marker: string;
  readonly prompt: string;
  readonly runs: number;
  /** The Bash call runs in a foreground subagent's own thread. */
  readonly subagent?: boolean;
}

// The prompt's own turn is in its Bash call.
const promptTurn = (): Scenario => {
  const marker = `done-${tag()}`;
  return {
    marker,
    prompt:
      `Run exactly this Bash command once, in the foreground, and nothing else: sleep 20; echo ${marker}\n` +
      "Then reply with only the text the command printed.",
    runs: 1,
  };
};

// A turn the CLI starts itself, with no user line on its stdin, is in its
// Bash call: the wake of a background command.
const wakeTurn = (): Scenario => {
  const marker = `done-${tag()}`;
  return {
    marker,
    prompt:
      `Start this Bash command in the background (run_in_background true): sleep 15; echo bg-${tag()}\n` +
      "Then end your turn at once, replying only: started.\n" +
      "When you are told that background command finished, run exactly this Bash command once, " +
      `in the foreground, and nothing else: sleep 20; echo ${marker}\n` +
      "Then reply with only the text that command printed.",
    runs: 2,
  };
};

// The prompt's turn is in a foreground subagent, which is in its Bash call.
// Claude's shell tool refuses a bare `sleep 40`, so the wait is a tail.
const subagentTurn = (): Scenario => {
  const marker = `done-${tag()}`;
  return {
    marker,
    prompt:
      "Use the Agent tool exactly once, in the foreground (not in the background), " +
      "with subagent_type general-purpose. Tell the subagent to run exactly this Bash command " +
      `once, in the foreground, and nothing else: timeout 40 tail -f /dev/null; echo ${marker}\n` +
      "and to reply with only the text the command printed. Run no command yourself.\n" +
      "Then reply with only the text the subagent reported.",
    runs: 1,
    subagent: true,
  };
};

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

const started = Date.now();
const log = (line: string) =>
  process.stdout.write(`# [${((Date.now() - started) / 1000).toFixed(1)}s] ${line}\n`);

// A stand-in for T3's MCP endpoint on the streamable HTTP transport: one
// tool, JSON responses, every request method logged.
const mcpStub = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly url: string; readonly methods: string[]; server: NodeHttp.Server }>(
        (resolve) => {
          const methods: string[] = [];
          const server = NodeHttp.createServer((req, res) => {
            log(`mcp stub ${req.method} ${req.url}`);
            if (req.method !== "POST") {
              res.writeHead(req.method === "DELETE" ? 200 : 405).end();
              return;
            }
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => {
              const parsed = JSON.parse(body) as unknown;
              const messages = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
                id?: number | string;
                method?: string;
                params?: { protocolVersion?: string };
              }>;
              const replies = messages.flatMap((message) => {
                methods.push(message.method ?? "?");
                if (message.id === undefined) return [];
                const result =
                  message.method === "initialize"
                    ? {
                        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
                        capabilities: { tools: {} },
                        serverInfo: { name: "t3-code-stub", version: "0" },
                      }
                    : message.method === "tools/list"
                      ? {
                          tools: [
                            {
                              name: "orchestrator_capabilities",
                              description: "Stub.",
                              inputSchema: { type: "object", properties: {} },
                            },
                          ],
                        }
                      : {};
                return [{ jsonrpc: "2.0", id: message.id, result }];
              });
              if (replies.length === 0) {
                res.writeHead(202).end();
                return;
              }
              res
                .writeHead(200, { "content-type": "application/json" })
                .end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
            });
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${address.port}/mcp`, methods, server });
          });
        },
      ),
  ),
  ({ server }) => Effect.promise(() => new Promise<void>((done) => server.close(() => done()))),
);

// The adapter's MCP credential slot. The harness's session manager runs with
// MCP configuration off and clears the slot when a session starts, so the
// adapter gets a slot of its own that always holds the stub's credential.
let mcpCredential: McpProviderSessionConfig | undefined;
const layerFixedMcpSession = Layer.succeed(
  McpProviderSessions.McpProviderSessions,
  McpProviderSessions.McpProviderSessions.of({
    set: () => Effect.void,
    read: (id) => Effect.sync(() => (id === threadId ? mcpCredential : undefined)),
    clear: () => Effect.void,
    recordHtmlRender: () => Effect.void,
    takeHtmlRender: () => Effect.undefined,
  }),
);

type KeeperHandle = {
  readonly handle: string;
  readonly pid: number;
  readonly alive: boolean;
  readonly attached: boolean;
};
const keeperList = (socketPath: string) =>
  Effect.promise(
    () => keeperRequest(socketPath, { op: "list" }) as Promise<{ handles: KeeperHandle[] }>,
  ).pipe(Effect.map((list) => list.handles));
const keeperStderr = (socketPath: string, handle: string) =>
  Effect.promise(
    () => keeperRequest(socketPath, { op: "stderr", handle }) as Promise<{ data: string }>,
  ).pipe(Effect.map((reply) => reply.data));

const restartDuringTurn = ({ marker, prompt, runs, subagent = false }: Scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      // Drain: an orphan it takes for idle is
      // closed at once.
      const keeper = yield* keeperSocketWith({ orphans: "drain" });
      const binary = realClaudeBinary();
      const acked = yield* firstKeeperAck;
      const mcp = yield* mcpStub;
      const cwd = yield* checkpointWorkspace("keeper-reattach-real");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-keeper-reattach-real-",
      });
      const attachmentsDir = path.join(stateDir, "attachments");
      yield* fs.makeDirectory(attachmentsDir);
      const databaseLayer = sqliteAt(path.join(stateDir, "state.sqlite"));
      const mcpOn = process.env.T3K_MCP !== "0";
      if (mcpOn) {
        mcpCredential = {
          environmentId: EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
          threadId,
          providerSessionId: "provider-session-stub",
          providerInstanceId: modelSelection.instanceId,
          endpoint: mcp.url,
          authorizationHeader: "Bearer stub",
          browserToolsAvailable: false,
        };
      }
      log(`binary ${binary} model ${modelSelection.model} marker ${marker} mcp ${mcpOn}`);
      // The adapter is built outside the harness, so the queue its wake
      // turns go to is made here and handed to both.
      const continuationRequests = Context.get(
        yield* Layer.build(ProviderContinuationRequests.layer),
        ProviderContinuationRequests.ProviderContinuationRequests,
      );
      const adapterFor = makeKeeperTestAdapter(binary, attachmentsDir, continuationRequests);
      const harness = (adapter: Parameters<typeof ProviderAdapterRegistry.layerSingle>[0]) =>
        ProviderReplayHarness.layerWithRegistry(
          { name: "keeper-reattach-real", runtimePolicyOverride: { cwd } },
          ProviderAdapterRegistry.layerSingle(adapter),
          // The continuation worker runs a wake turn, as the server does.
          {
            databaseLayer,
            recoverOnStartup: true,
            runContinuationWorker: true,
            continuationRequests,
          },
        );
      const dumpStderr = Effect.gen(function* () {
        for (const handle of yield* keeperList(keeper.socketPath)) {
          const data = yield* keeperStderr(keeper.socketPath, handle.handle);
          log(`stderr of ${handle.handle} pid ${handle.pid}:\n${data.slice(-4000)}`);
        }
      });
      yield* Effect.addFinalizer((exit) =>
        exit._tag === "Failure" ? dumpStderr.pipe(Effect.ignore) : Effect.void,
      );

      // The server before the restart: the turn is in its Bash call.
      const { runId, pidBefore } = yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("project:keeper-reattach-real"),
            title: "Keeper reattach real CLI",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          // What the turn does, for reading a failed run.
          yield* orchestrator.streamDomainEvents.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.type === "run.updated") {
                  log(`run ${event.payload.id} ${event.payload.status}`);
                } else if (
                  event.type === "turn-item.updated" &&
                  event.payload.type === "command_execution"
                ) {
                  log(`command ${event.payload.status} ${event.payload.input.slice(0, 40)}`);
                }
              }),
            ),
            Effect.forkScoped,
          );
          let toolRunId: string | null | undefined;
          const toolRunning = yield* watch((event) => {
            const hit =
              event.type === "turn-item.updated" &&
              event.payload.type === "command_execution" &&
              event.payload.status === "running" &&
              event.payload.input.includes(marker);
            if (hit) toolRunId = event.payload.runId;
            return hit;
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("first"),
            threadId,
            messageId: MessageId.make("first"),
            text: prompt,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* Fiber.join(toolRunning);
          log("tool running");
          yield* acked;
          // Past the acknowledgement lag: the next server gets no replay of
          // the subagent's start, only the frames after its Bash call began.
          if (subagent) yield* Effect.promise(() => sleep(2_500));
          const handles = yield* keeperList(keeper.socketPath);
          assert.equal(handles.length, 1);
          // SIGTERM: the keeper children are detached before anything closes.
          assert.equal(detachKeeperChildren(), 1);
          log(`detached; mcp methods so far ${mcp.methods.join(",")}`);
          // The CLI connected to T3's MCP server: the path under test carries it.
          if (mcpOn) assert.include(mcp.methods, "tools/list");
          const before = yield* orchestrator.getThreadProjection(threadId);
          // A subagent's Bash call is runless, in the subagent's own thread.
          const run = before.runs.find((candidate) =>
            subagent ? candidate.status === "running" : candidate.id === toolRunId,
          );
          if (subagent) {
            log(`subagents ${JSON.stringify(before.subagents.map((s) => [s.runId, s.status]))}`);
            assert.deepEqual(
              before.subagents.map((s) => s.status),
              ["running"],
            );
          }
          assert.isDefined(run);
          log(`tool run ${run!.id}`);
          return { runId: run!.id, pidBefore: handles[0]!.pid };
        }).pipe(Effect.provide(harness(yield* adapterFor))),
      );
      const mcpBefore = mcp.methods.length;

      yield* Effect.gen(function* () {
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
        yield* recovery.prepareForShutdown;
        yield* recovery.reconcile("shutdown");
        const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
          threadId,
        );
        assert.equal(projection.runs.find((run) => run.id === runId)?.status, "running");
        const reattaches = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
          ProviderRuntimeRecoveryService.keeperReattachCommandId(runId),
        );
        assert.deepEqual(
          reattaches.map((effect) => [effect.request.type, effect.status]),
          [["provider-turn.reattach", "pending"]],
        );
      }).pipe(Effect.provide(layerShutdownRecovery(databaseLayer)), Effect.scoped);
      log("shutdown done");

      // The server after it: the worker attaches while the Bash call runs.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const settled = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === runId &&
              event.payload.status !== "running",
          );
          yield* worker.drain();
          const afterAttach = yield* orchestrator.getThreadProjection(threadId);
          const toolAtAttach = afterAttach.turnItems.find(
            (item) => item.type === "command_execution" && item.runId === runId,
          );
          log(
            `reattached; runs ${JSON.stringify(afterAttach.runs.map((run) => run.status))} tool ${toolAtAttach?.status}`,
          );
          yield* Fiber.join(settled);
          yield* worker.drain();
          log(`mcp methods after restart ${mcp.methods.slice(mcpBefore).join(",") || "none"}`);
          const projection = yield* orchestrator.getThreadProjection(threadId);
          log(`runs ${JSON.stringify(projection.runs.map((run) => [run.id, run.status]))}`);
          const subagentRow = subagent ? projection.subagents[0] : undefined;
          const toolThreadId = subagentRow?.childThreadId ?? threadId;
          const toolThread =
            toolThreadId === threadId
              ? projection
              : yield* orchestrator.getThreadProjection(toolThreadId);
          const tool = toolThread.turnItems.find(
            (item) =>
              item.type === "command_execution" &&
              item.runId === (subagent ? null : runId) &&
              item.input.includes(marker),
          );
          const toolFull =
            tool === undefined
              ? null
              : yield* orchestrator.getTurnItem({ threadId: toolThreadId, itemId: tool.id });
          const output = toolFull?.type === "command_execution" ? toolFull.output : undefined;
          log(`tool ${tool?.status} output ${JSON.stringify(output)}`);
          const replies = projection.turnItems
            .filter((item) => item.type === "assistant_message" && item.runId === runId)
            .map((item) => (item.type === "assistant_message" ? item.text : ""));
          log(`replies ${JSON.stringify(replies)}`);
          const handles = yield* keeperList(keeper.socketPath);
          log(`keeper handles ${JSON.stringify(handles.map((h) => [h.pid, h.alive, h.attached]))}`);

          assert.equal(projection.runs.length, runs);
          assert.deepEqual(
            projection.runs.filter((run) => run.status !== "completed").map((run) => run.id),
            [],
          );
          assert.equal(tool?.status, "completed");
          assert.include(output ?? "", marker);
          assert.include(replies.join("\n"), marker);
          assert.isFalse(
            projection.turnItems.some(
              (item) =>
                item.type === "user_message" && item.text.includes("Continue where you left off"),
            ),
          );
          assert.deepEqual(
            handles.map((h) => h.pid),
            [pidBefore],
          );
          assert.isTrue(projection.checkpoints.some((checkpoint) => checkpoint.runId === runId));
          if (subagent) {
            log(
              `subagents ${JSON.stringify(projection.subagents.map((s) => [s.runId, s.status, s.result?.slice(0, 60)]))}`,
            );
            assert.deepEqual(
              projection.subagents.map((s) => [s.runId, s.status]),
              [[runId, "completed"]],
            );
            assert.include(subagentRow?.result ?? "", marker);
            const card = projection.turnItems.filter((item) => item.type === "subagent");
            assert.deepEqual(
              card.map((item) => [item.runId, item.status]),
              [[runId, "completed"]],
            );
          }
        }).pipe(Effect.provide(harness(yield* adapterFor))),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          realQueryRunner,
          IdAllocator.layer,
          layerFixedMcpSession,
          NodeServices.layer,
        ),
      ),
    ),
  );

describe.skipIf(!enabled)("T3 restart during a real Claude CLI turn", () => {
  it.effect(
    "lands the real CLI's later output in the same run after the restart",
    () => restartDuringTurn(promptTurn()),
    240_000,
  );

  it.effect(
    "keeps a turn the CLI started itself running across the restart",
    () => restartDuringTurn(wakeTurn()),
    240_000,
  );

  it.effect(
    "keeps a foreground subagent running across the restart",
    () => restartDuringTurn(subagentTurn()),
    240_000,
  );
});
