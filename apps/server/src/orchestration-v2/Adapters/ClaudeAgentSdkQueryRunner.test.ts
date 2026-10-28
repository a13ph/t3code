// @effect-diagnostics nodeBuiltinImport:off -- the fake CLI and its leftover child are real processes.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
  ClaudeAgentSdkQueryRunner,
  layerQueryRunner,
} from "./ClaudeAdapterV2.ts";
import { keeperSpawnProcess } from "./ClaudeKeeperSpawn.ts";
// @ts-ignore - plain ESM without types
import { startKeeper } from "../../t3Keeper/keeper.mjs";
// @ts-ignore - plain ESM without types
import { request as keeperRequest } from "../../t3Keeper/shim.mjs";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

it.effect("logs successful task stops for replay and omits failed stops", () =>
  Effect.gen(function* () {
    const writes: unknown[] = [];
    const stopTask = vi.fn(async (_taskId: string) => {});
    const query = vi.spyOn(ClaudeSdk, "query").mockReturnValue({
      stopTask,
    } as unknown as ClaudeSdk.Query);
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const threadId = ThreadId.make("thread-stop");
    const providerSessionId = ProviderSessionId.make("session-stop");
    yield* Effect.gen(function* () {
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const session = yield* runner.open({
        threadId,
        providerSessionId,
        options: {
          sessionId: "native-session-stop",
          model: "claude-sonnet-4-6",
          tools: [],
          permissionMode: "default",
        },
      });
      writes.length = 0;
      yield* session.stopTask("workflow-task");
      assert.deepEqual(stopTask.mock.calls, [["workflow-task"]]);
      assert.deepEqual(writes, [
        {
          provider: "claudeAgent",
          protocol: CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
          kind: "protocol",
          providerSessionId,
          event: {
            direction: "outgoing",
            stage: "decoded",
            payload: { type: "query.stop_task", taskId: "workflow-task" },
          },
        },
      ]);
      stopTask.mockRejectedValueOnce(new Error("Stop failed"));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(session.stopTask("failed-task"))));
      assert.equal(writes.length, 1);
    }).pipe(
      Effect.provide(
        layerQueryRunner.pipe(
          Layer.provide(
            Layer.succeed(ProviderEventLoggers, {
              native: {
                filePath: "/tmp/events.log",
                write: (event) =>
                  Effect.sync(() => {
                    writes.push(event);
                  }),
                close: () => Effect.void,
              },
              canonical: undefined,
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

const realQueryRunner = layerQueryRunner.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers, {
      native: undefined,
      canonical: undefined,
    }),
  ),
  Layer.provide(NodeServices.layer),
);

/** Writes an executable stand-in for the Claude CLI into a fresh directory. */
function fakeClaudeCli(script: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-cli-"));
  const cli = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(cli, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return cli;
}

const openFakeCli = (cli: string) =>
  Effect.gen(function* () {
    const runner = yield* ClaudeAgentSdkQueryRunner;
    return yield* runner.open({
      threadId: ThreadId.make("thread-fake-cli"),
      providerSessionId: ProviderSessionId.make("session-fake-cli"),
      options: {
        sessionId: "native-session-fake-cli",
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        pathToClaudeCodeExecutable: cli,
      },
    });
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("Claude CLI process", () => {
  // The CLI stops the MCP servers it started, but not their children: a
  // plugin's `bun server.ts` outlives its `bun run` wrapper (#3089). The fake
  // CLI leaves a child running the same way. The child holds a FIFO open, so
  // its death reads as end-of-file here, with no polling.
  it.effect("stops what the CLI left running when the session closes", () =>
    Effect.gen(function* () {
      yield* keeperSocketEnv(undefined);
      const cli = fakeClaudeCli(
        [
          'dir=$(dirname "$0")',
          'sleep 600 > "$dir/alive" &',
          'echo $! > "$dir/leftover.pid"',
          "cat > /dev/null",
        ].join("\n"),
      );
      const dir = NodePath.dirname(cli);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "alive")]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          // Only does anything when the test fails: do not leak its child.
          try {
            process.kill(Number(NodeFS.readFileSync(NodePath.join(dir, "leftover.pid"), "utf8")));
          } catch {}
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      );
      const alive = NodeFS.createReadStream(NodePath.join(dir, "alive"));
      const leftoverStarted = new Promise<void>((resolve) => alive.once("open", () => resolve()));
      const leftoverStopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
      alive.resume();

      const session = yield* openFakeCli(cli);
      yield* Effect.promise(() => leftoverStarted);
      yield* session.close;
      yield* Effect.promise(() => leftoverStopped);
    }).pipe(Effect.provide(realQueryRunner)),
  );
});

/** Sets T3_KEEPER_SOCKET, or unsets it, while the test runs. */
function keeperSocketEnv(value: string | undefined) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.T3_KEEPER_SOCKET;
      if (value === undefined) delete process.env.T3_KEEPER_SOCKET;
      else process.env.T3_KEEPER_SOCKET = value;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.T3_KEEPER_SOCKET;
        else process.env.T3_KEEPER_SOCKET = previous;
      }),
  );
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
  yield* keeperSocketEnv(keeper.socketPath);
  return { keeper };
});

/** Resolves once the fake CLI opened the FIFO `name` in its directory for writing. */
function fifoOpened(cli: string, name: string) {
  const fifo = NodePath.join(NodePath.dirname(cli), name);
  NodeChildProcess.execFileSync("mkfifo", [fifo]);
  const stream = NodeFS.createReadStream(fifo);
  stream.resume();
  return {
    opened: new Promise<void>((resolve) => stream.once("open", () => resolve())),
    closed: new Promise<void>((resolve) => stream.once("close", () => resolve())),
  };
}

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("Claude CLI in t3-keeper", () => {
  // The CLI does not get T3_KEEPER_SOCKET: a nested T3 server or test run
  // would otherwise spawn its own CLIs into the outer keeper.
  it.effect("runs the CLI as a child of the keeper, named after the thread", () =>
    Effect.gen(function* () {
      const { keeper } = yield* keeperSocket;
      const cli = fakeClaudeCli(
        [
          'echo "${T3_KEEPER_SOCKET-unset}" > "$(dirname "$0")/socket-env"',
          'exec 3> "$(dirname "$0")/started"',
          "cat > /dev/null",
        ].join("\n"),
      );
      const started = fifoOpened(cli, "started");
      const session = yield* openFakeCli(cli);
      yield* Effect.promise(() => started.opened);
      const list = yield* Effect.promise(() => keeperRequest(keeper.socketPath, { op: "list" }));
      assert.deepEqual(
        list.handles.map((h: { name: string; alive: boolean }) => [h.name, h.alive]),
        [["thread-fake-cli", true]],
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(NodePath.dirname(cli), "socket-env"), "utf8").trim(),
        "unset",
      );
      yield* session.close;
      yield* Effect.promise(() => started.closed);
    }).pipe(Effect.provide(realQueryRunner)),
  );

  it.effect("stops what the CLI left running when the session closes", () =>
    Effect.gen(function* () {
      yield* keeperSocket;
      const cli = fakeClaudeCli(
        [
          'dir=$(dirname "$0")',
          'sleep 600 > "$dir/alive" &',
          'echo $! > "$dir/leftover.pid"',
          "cat > /dev/null",
        ].join("\n"),
      );
      const dir = NodePath.dirname(cli);
      const leftover = fifoOpened(cli, "alive");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(Number(NodeFS.readFileSync(NodePath.join(dir, "leftover.pid"), "utf8")));
          } catch {}
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      );
      const session = yield* openFakeCli(cli);
      yield* Effect.promise(() => leftover.opened);
      yield* session.close;
      yield* Effect.promise(() => leftover.closed);
    }).pipe(Effect.provide(realQueryRunner)),
  );

  it.effect("spawns the CLI itself when the keeper socket is gone", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-keeper-gone-"));
      const spawn = keeperSpawnProcess(ThreadId.make("thread-no-keeper"), {
        env: { T3_KEEPER_SOCKET: NodePath.join(dir, "keeper.sock") },
        connectRetryMs: 0,
      });
      assert.isDefined(spawn);
      const cli = fakeClaudeCli('exec 3> "$(dirname "$0")/started"; cat > /dev/null');
      const started = fifoOpened(cli, "started");
      const child = spawn!({
        command: cli,
        args: [],
        cwd: dir,
        env: { ...process.env },
        signal: new AbortController().signal,
      });
      yield* Effect.promise(() => started.opened);
      child.stdin.end();
      yield* Effect.promise(() => started.closed);
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }),
  );

  it("leaves the SDK's own spawn in place without T3_KEEPER_SOCKET", () => {
    assert.isUndefined(keeperSpawnProcess(ThreadId.make("thread-plain"), { env: {} }));
  });
});
