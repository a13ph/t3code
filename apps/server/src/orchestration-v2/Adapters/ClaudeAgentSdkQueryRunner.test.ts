// @effect-diagnostics nodeBuiltinImport:off -- the fake CLI and its leftover child are real processes.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { AgentScope } from "@t3tools/shared/AgentScope";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import {
  ClaudeAgentSdkQueryRunner,
  type ClaudeAgentSdkQueryOpenInput,
  layerQueryRunner,
  spawnClaudeProcessGroup,
} from "./ClaudeAdapterV2.ts";
import { detachKeeperChildren, keeperSpawnProcess } from "./ClaudeKeeperSpawn.ts";
// @ts-ignore - plain ESM without types
import { startKeeper } from "../../t3Keeper/keeper.mjs";
// @ts-ignore - plain ESM without types
import { KeeperProcess, request as keeperRequest } from "../../t3Keeper/shim.mjs";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const FORK_SESSION_ID = "11111111-1111-4111-8111-111111111111";

const writeClaudeSession = Effect.fnUntraced(function* (configDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = path.join(configDir, "projects", "-repo");
  const entry = (uuid: string, parentUuid: string | null, message: unknown) => ({
    type: parentUuid === null ? "user" : "assistant",
    uuid,
    parentUuid,
    sessionId: FORK_SESSION_ID,
    cwd: "/repo",
    isSidechain: false,
    timestamp: "2026-10-01T00:00:00.000Z",
    message,
  });
  yield* fileSystem.makeDirectory(projectDir, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(projectDir, `${FORK_SESSION_ID}.jsonl`),
    [
      entry("aaaaaaaa-0000-4000-8000-000000000001", null, { role: "user", content: "hello" }),
      entry("aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000001", {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      }),
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
  return projectDir;
});

const forkRunnerLayer = layerQueryRunner.pipe(
  Layer.provide(Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined })),
);

it.effect("forks a session stored under the instance's own CLAUDE_CONFIG_DIR", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-claude-fork-config-",
      });
      const projectDir = yield* writeClaudeSession(configDir);
      const hostConfigDir = process.env.CLAUDE_CONFIG_DIR;
      const inProcessFork = vi.spyOn(ClaudeSdk, "forkSession");
      yield* Effect.addFinalizer(() => Effect.sync(() => inProcessFork.mockRestore()));

      const runner = yield* ClaudeAgentSdkQueryRunner;
      const forked = yield* runner.forkSession({
        sessionId: FORK_SESSION_ID,
        options: { dir: "/repo" },
        environment: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        threadId: ThreadId.make("thread-fork-config-dir"),
        providerSessionId: ProviderSessionId.make("session-fork-config-dir"),
      });

      assert.notEqual(forked.sessionId, FORK_SESSION_ID);
      const transcript = yield* fileSystem.readFileString(
        path.join(projectDir, `${forked.sessionId}.jsonl`),
      );
      assert.include(transcript, '"content":"hello"');
      assert.include(transcript, '"text":"hi"');
      const inheritedHead = transcript
        .trim()
        .split("\n")
        .findLast((line) => line.includes('"type":"assistant"'))
        ?.match(/"uuid"\s*:\s*"([^"]+)"/)?.[1];
      assert.isString(inheritedHead);
      assert.equal(forked.headMessageId, inheritedHead);
      assert.equal(process.env.CLAUDE_CONFIG_DIR, hostConfigDir);
      assert.equal(inProcessFork.mock.calls.length, 0);
    }).pipe(Effect.provide(forkRunnerLayer)),
  ).pipe(Effect.provide(NodeServices.layer)),
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

const resumedMcpQueryInput = {
  threadId: ThreadId.make("thread-restart-registration"),
  providerSessionId: ProviderSessionId.make("session-restart-registration"),
  options: {
    resume: FORK_SESSION_ID,
    model: "claude-sonnet-4-6",
    tools: [],
    permissionMode: "default",
    mcpServers: {
      "t3-code": {
        type: "http",
        url: "http://localhost:3773/mcp",
        headers: { Authorization: "Bearer test-mcp-credential" },
      },
    },
  },
} satisfies ClaudeAgentSdkQueryOpenInput;

it.effect("reopens a stalled MCP registration before delivering the resumed prompt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const disposalStarted = Promise.withResolvers<void>();
      const finishDisposal = Promise.withResolvers<void>();
      const prompts: AsyncIterable<ClaudeSdk.SDKUserMessage>[] = [];
      const firstClose = vi.fn();
      const secondClose = vi.fn();
      const firstRegistration = vi.fn(() => {
        registrationStarted.resolve();
        return new Promise<ClaudeSdk.McpSetServersResult>(() => {});
      });
      const secondRegistration = vi.fn(async () => ({
        added: ["t3-code"],
        removed: [],
        errors: {},
      }));
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ prompt }) => {
        assert.notTypeOf(prompt, "string");
        if (typeof prompt === "string") throw new Error("Expected streaming input");
        prompts.push(prompt);
        return {
          setMcpServers: prompts.length === 1 ? firstRegistration : secondRegistration,
          close: prompts.length === 1 ? firstClose : secondClose,
          [Symbol.asyncDispose]: async () => {
            firstClose();
            disposalStarted.resolve();
            await finishDisposal.promise;
          },
        } as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner.open(resumedMcpQueryInput).pipe(Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* TestClock.adjust("90 seconds");
      yield* Effect.promise(() => disposalStarted.promise);
      assert.equal(querySpy.mock.calls.length, 1);
      finishDisposal.resolve();
      const session = yield* Fiber.join(opening);
      yield* Effect.addFinalizer(() => session.close.pipe(Effect.orDie));

      assert.equal(firstClose.mock.calls.length, 1);
      assert.equal(secondClose.mock.calls.length, 0);
      assert.equal(querySpy.mock.calls.length, 2);
      for (const [call] of querySpy.mock.calls) {
        assert.equal(call.options?.resume, FORK_SESSION_ID);
        assert.isUndefined(call.options?.mcpServers);
      }
      assert.deepEqual(secondRegistration.mock.calls, [[resumedMcpQueryInput.options.mcpServers]]);
      const message = {
        type: "user",
        message: { role: "user", content: "Continue where you left off." },
        parent_tool_use_id: null,
        session_id: FORK_SESSION_ID,
      } satisfies ClaudeSdk.SDKUserMessage;
      yield* session.offer(message);
      assert.isTrue((yield* Effect.promise(() => prompts[0]![Symbol.asyncIterator]().next())).done);
      const delivered = yield* Effect.promise(() => prompts[1]![Symbol.asyncIterator]().next());
      assert.deepEqual(delivered.value, message);
      assert.isFalse(delivered.done);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect.each([true, false])("only retries after confirmed process exit: %s", (exits) =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const cleanupProgress = Promise.withResolvers<"kill" | "retry">();
      const events = new NodeEvents.EventEmitter();
      const stdin = new NodeStream.PassThrough();
      const stdout = new NodeStream.PassThrough();
      const child = {
        stdin,
        stdout,
        killed: false,
        exitCode: null,
        kill: vi.fn(() => {
          cleanupProgress.resolve("kill");
          return true;
        }),
        on: events.on.bind(events),
        once: events.once.bind(events),
        off: events.off.bind(events),
      } satisfies ClaudeSdk.SpawnedProcess;
      const signal = yield* Effect.abortSignal;
      const disposed = vi.fn(async () => {});
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
        const first = querySpy.mock.calls.length === 1;
        if (first) {
          options?.spawnClaudeCodeProcess?.({ command: "claude", args: [], env: {}, signal });
        } else {
          cleanupProgress.resolve("retry");
        }
        return {
          setMcpServers: () => {
            registrationStarted.resolve();
            return first
              ? new Promise<ClaudeSdk.McpSetServersResult>(() => {})
              : Promise.resolve({ added: ["t3-code"], removed: [], errors: {} });
          },
          close: vi.fn(),
          [Symbol.asyncDispose]: disposed,
        } as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          querySpy.mockRestore();
          stdin.destroy();
          stdout.destroy();
        }),
      );
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner
        .open({
          ...resumedMcpQueryInput,
          options: { ...resumedMcpQueryInput.options, spawnClaudeCodeProcess: () => child },
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* TestClock.adjust("90 seconds");

      assert.equal(yield* Effect.promise(() => cleanupProgress.promise), "kill");
      assert.equal(querySpy.mock.calls.length, 1);
      assert.deepEqual(child.kill.mock.calls, [["SIGKILL"]]);
      if (exits) events.emit("exit", null, "SIGKILL");
      else yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(opening);
      assert.equal(Exit.isSuccess(result), exits);
      if (Exit.isSuccess(result)) yield* result.value.close;
      assert.equal(querySpy.mock.calls.length, exits ? 2 : 1);
      assert.equal(disposed.mock.calls.length, 1);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect("stops retrying MCP registration after two timeouts and reports the cause", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const firstRegistration = Promise.withResolvers<void>();
      const secondRegistration = Promise.withResolvers<void>();
      const disposed = vi.fn(async () => {});
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(() => {
        const started = querySpy.mock.calls.length === 1 ? firstRegistration : secondRegistration;
        return {
          setMcpServers: () => {
            started.resolve();
            return new Promise<ClaudeSdk.McpSetServersResult>(() => {});
          },
          [Symbol.asyncDispose]: disposed,
        } as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner
        .open(resumedMcpQueryInput)
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => firstRegistration.promise);
      yield* TestClock.adjust("90 seconds");
      yield* Effect.promise(() => secondRegistration.promise);
      yield* TestClock.adjust("90 seconds");
      const result = yield* Fiber.join(opening);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.equal(querySpy.mock.calls.length, 2);
      assert.equal(disposed.mock.calls.length, 2);
      assert.equal(
        makeProviderFailure({
          cause: { _tag: "ProviderAdapterTurnStartError", cause: result.failure },
        }).message,
        "Claude timed out while registering its MCP tools. Retry the turn; if it keeps failing, check Claude and the server logs.",
      );
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect("cancels a stalled registration without retrying or retaining its prompt queue", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const disposed = vi.fn(async () => {});
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(
        () =>
          ({
            setMcpServers: () => {
              registrationStarted.resolve();
              return new Promise<ClaudeSdk.McpSetServersResult>(() => {});
            },
            [Symbol.asyncDispose]: disposed,
          }) as unknown as ClaudeSdk.Query,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner.open(resumedMcpQueryInput).pipe(Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* Fiber.interrupt(opening);

      assert.equal(querySpy.mock.calls.length, 1);
      assert.equal(disposed.mock.calls.length, 1);
      const prompt = querySpy.mock.calls[0]![0].prompt;
      if (typeof prompt === "string") throw new Error("Expected streaming input");
      assert.isTrue((yield* Effect.promise(() => prompt[Symbol.asyncIterator]().next())).done);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect("does not reuse a fresh session ID after MCP registration times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const disposed = vi.fn(async () => {});
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(
        () =>
          ({
            setMcpServers: () => {
              registrationStarted.resolve();
              return new Promise<ClaudeSdk.McpSetServersResult>(() => {});
            },
            [Symbol.asyncDispose]: disposed,
          }) as unknown as ClaudeSdk.Query,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const { resume, ...options } = resumedMcpQueryInput.options;
      const opening = yield* runner
        .open({
          ...resumedMcpQueryInput,
          options: { ...options, sessionId: resume },
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* TestClock.adjust("90 seconds");
      const result = yield* Fiber.join(opening);

      assert.equal(result._tag, "Failure");
      assert.equal(querySpy.mock.calls.length, 1);
      assert.equal(disposed.mock.calls.length, 1);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

function fakeClaudeCli(script: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-cli-"));
  const cli = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(cli, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return cli;
}

const openFakeCli = (cli: string, extra: Pick<ClaudeSdk.Options, "canUseTool"> = {}) =>
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
        ...extra,
      },
    });
  });

/** A status line the SDK yields as a message, quoted for a shell `printf`. */
const statusLine = (uuid: string) =>
  `'{"type":"system","subtype":"status","status":null,"session_id":"s","uuid":"${uuid}"}'`;

/** A can_use_tool control request, quoted for a shell `printf`. */
const permissionLine = (requestId: string) =>
  `'{"type":"control_request","request_id":"${requestId}","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"true"},"tool_use_id":"toolu_${requestId}"}}'`;

/** Resolves with the first line number acknowledged to the keeper. */
const spyFirstKeeperAck = Effect.gen(function* () {
  const first = Promise.withResolvers<number>();
  const ack = vi.spyOn(KeeperProcess.prototype, "ack").mockImplementation(function (
    this: { _request: (msg: unknown) => Promise<unknown> },
    after: number,
  ) {
    first.resolve(after);
    return this._request({ op: "ack", after });
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => ack.mockRestore()));
  return first.promise;
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("Claude CLI process", () => {
  // The leftover child holds a FIFO open; its death produces EOF without polling.
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

      const stopped = yield* Deferred.make<string>();
      const session = yield* openFakeCli(cli).pipe(
        Effect.provide(
          realQueryRunner.pipe(
            Layer.provide(
              Layer.succeed(AgentScope, {
                ...AgentScope.defaultValue(),
                wrap: ({ command, args }) =>
                  Effect.succeed({ command, args, unit: "t3code-claude-test.scope" }),
                stop: (unit) => Deferred.succeed(stopped, unit).pipe(Effect.asVoid),
              }),
            ),
          ),
        ),
      );
      yield* Effect.promise(() => leftoverStarted);
      yield* session.close;
      yield* Effect.promise(() => leftoverStopped);
      assert.strictEqual(yield* Deferred.await(stopped), "t3code-claude-test.scope");
    }),
  );

  // The CLI keeps running its turn after its pipes close, so a server that
  // crashed would leave it working next to the session it resumes.
  it.effect("stops the CLI when the server that started it goes away", () =>
    Effect.gen(function* () {
      const cli = fakeClaudeCli(['dir=$(dirname "$0")', 'sleep 600 > "$dir/alive"'].join("\n"));
      const dir = NodePath.dirname(cli);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "alive")]);
      const child = spawnClaudeProcessGroup({
        command: cli,
        args: [],
        cwd: dir,
        env: process.env,
        // @effect-diagnostics-next-line abortControllerInEffect:off - This crash fixture closes pipes itself; aborting on test teardown raises an unrelated process error.
        signal: new AbortController().signal,
      }) as NodeChildProcess.ChildProcess;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            signalProcessGroup(child.pid ?? 0, "SIGKILL");
          } catch {}
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      );
      const alive = NodeFS.createReadStream(NodePath.join(dir, "alive"));
      const turnStarted = new Promise<void>((resolve) => alive.once("open", () => resolve()));
      const turnStopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
      alive.resume();
      yield* Effect.promise(() => turnStarted);

      // A dying server's descriptors close; the kernel would do this for it.
      for (const pipe of child.stdio) pipe?.destroy();
      yield* Effect.promise(() => turnStopped);
    }),
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

/** One process in the keeper's reply to `list`. */
interface KeeperListEntry {
  readonly handle: string;
  readonly name: string;
  readonly alive: boolean;
  readonly attached: boolean;
  readonly acked: number;
}

/** The processes the keeper at `socketPath` holds. */
const listKeeper = (socketPath: string) =>
  Effect.promise(
    (): Promise<{ readonly handles: ReadonlyArray<KeeperListEntry> }> =>
      keeperRequest(socketPath, { op: "list" }),
  );

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
      const list = yield* listKeeper(keeper.socketPath);
      assert.deepEqual(
        list.handles.map((h) => [h.name, h.alive]),
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

  it.effect("leaves the CLI running in the keeper when shutdown detached it", () =>
    Effect.gen(function* () {
      const { keeper } = yield* keeperSocket;
      const cli = fakeClaudeCli('exec 3> "$(dirname "$0")/started"; cat > /dev/null');
      const started = fifoOpened(cli, "started");
      const session = yield* openFakeCli(cli);
      yield* Effect.promise(() => started.opened);
      assert.equal(detachKeeperChildren(), 1);
      yield* session.close;
      const list = yield* listKeeper(keeper.socketPath);
      assert.deepEqual(
        list.handles.map((h) => [h.name, h.alive, h.attached]),
        [["thread-fake-cli", true, false]],
      );
      yield* Effect.promise(() =>
        keeperRequest(keeper.socketPath, { op: "close", handle: list.handles[0]!.handle }),
      );
      yield* Effect.promise(() => started.closed);
    }).pipe(Effect.provide(realQueryRunner)),
  );

  // The keeper may drop a line only once T3 holds what it carried. Lines the
  // SDK consumes itself (keep_alive here) yield no message, so the n-th
  // message is not the n-th line, and handling one message acks through its
  // own line, not through the last line delivered.
  it.effect("acks the line of the handled message, not the lines after it", () =>
    Effect.gen(function* () {
      const { keeper } = yield* keeperSocket;
      const status = (uuid: string) =>
        `'{"type":"system","subtype":"status","status":null,"session_id":"s","uuid":"${uuid}"}'`;
      const cli = fakeClaudeCli(
        `printf '%s\\n' ${status("u1")} '{"type":"keep_alive"}' ${status("u2")} ${status("u3")}; cat > /dev/null`,
      );
      const acks: number[] = [];
      const firstAck = Promise.withResolvers<void>();
      const ack = vi.spyOn(KeeperProcess.prototype, "ack").mockImplementation(function (
        this: { _request: (msg: unknown) => Promise<unknown> },
        after: number,
      ) {
        acks.push(after);
        firstAck.resolve();
        return this._request({ op: "ack", after });
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => ack.mockRestore()));
      const session = yield* openFakeCli(cli);
      // Ending the stream would close the CLI, so it is read into a queue.
      const received = yield* Queue.unbounded<ClaudeSdk.SDKMessage>();
      yield* session.messages.pipe(
        Stream.runForEach((message) => Queue.offer(received, message)),
        Effect.forkScoped,
      );
      const messages = [
        yield* Queue.take(received),
        yield* Queue.take(received),
        yield* Queue.take(received),
      ];
      assert.deepEqual(
        messages.map((message): string | undefined => message.uuid),
        ["u1", "u2", "u3"],
      );
      session.handled?.(messages[1]!);
      assert.deepEqual(acks, []);
      yield* Effect.promise(() => firstAck.promise);
      assert.deepEqual(acks, [3]);
      const list = yield* listKeeper(keeper.socketPath);
      assert.equal(list.handles[0]?.acked, 3);
      yield* session.close;
    }).pipe(Effect.provide(realQueryRunner)),
  );

  // A permission prompt is a control request the SDK answers itself. Once
  // answered, its line must be acked even when no message follows it (a long
  // Bash call), or a restart replays it and asks for the tool a second time.
  it.effect("acks a permission prompt once the SDK answered it", () =>
    Effect.gen(function* () {
      yield* keeperSocket;
      const cli = fakeClaudeCli(
        [
          `printf '%s\\n' ${statusLine("u1")} ${permissionLine("perm-1")}`,
          'while read -r line; do case "$line" in *control_response*perm-1*) break;; esac; done',
          `printf '%s\\n' ${statusLine("u2")}`,
          "cat > /dev/null",
        ].join("\n"),
      );
      const firstAck = yield* spyFirstKeeperAck;
      const session = yield* openFakeCli(cli, {
        canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
      });
      const received = yield* Queue.unbounded<ClaudeSdk.SDKMessage>();
      yield* session.messages.pipe(
        Stream.runForEach((message) => Queue.offer(received, message)),
        Effect.forkScoped,
      );
      const u1 = yield* Queue.take(received);
      // The CLI prints u2 only after it read the answer.
      assert.equal((yield* Queue.take(received)).uuid, "u2");
      session.handled?.(u1);
      assert.equal(yield* Effect.promise(() => firstAck), 2);
      yield* session.close;
    }).pipe(Effect.provide(realQueryRunner)),
  );

  it.effect("holds the ack below a permission prompt nobody answered", () =>
    Effect.gen(function* () {
      yield* keeperSocket;
      const cli = fakeClaudeCli(
        `printf '%s\\n' ${statusLine("u1")} ${permissionLine("perm-2")} ${statusLine("u2")}; cat > /dev/null`,
      );
      const firstAck = yield* spyFirstKeeperAck;
      const session = yield* openFakeCli(cli, {
        canUseTool: () => new Promise<never>(() => {}),
      });
      const received = yield* Queue.unbounded<ClaudeSdk.SDKMessage>();
      yield* session.messages.pipe(
        Stream.runForEach((message) => Queue.offer(received, message)),
        Effect.forkScoped,
      );
      yield* Queue.take(received);
      // Handling u2 settles u1 before it, but not the open prompt between.
      session.handled?.(yield* Queue.take(received));
      assert.equal(yield* Effect.promise(() => firstAck), 1);
      yield* session.close;
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
      const child = spawn!.spawn({
        command: cli,
        args: [],
        cwd: dir,
        env: { ...process.env },
        // @effect-diagnostics-next-line abortControllerInEffect:off - The CLI exits when its stdin ends; aborting on test teardown would race that exit.
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
