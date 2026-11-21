// @effect-diagnostics nodeBuiltinImport:off -- the fake CLI and the keeper are real processes and sockets.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
// @ts-ignore - plain ESM without types
import { startKeeper } from "../../t3Keeper/keeper.mjs";
// @ts-ignore - plain ESM without types
import { KeeperProcess, request as keeperRequest } from "../../t3Keeper/shim.mjs";

export const keeperTestModelSelection = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
};

export const SLOW_COMMAND = "sleep 60; echo done-4857";
export const SLOW_COMMAND_REPLY = "The command printed done-4857.";

/** The subagent the fake CLI's subagent turn launches, and what it returns. */
export const SUBAGENT_TASK_ID = "a0fake0subagent1";
export const SUBAGENT_RESULT = "The subagent's command printed done-4857.";
export const SUBAGENT_PROMPT = "Run the slow command and report what it printed.";

// A stand-in for the Claude CLI on the stream-json protocol: it answers every
// control request, and on the first prompt runs `turn`, which holds until
// `release` exists next to it.
const fakeCliSource = (turn: string, everyPrompt: boolean) => String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
const dir = path.dirname(process.argv[1]);
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const assistant = (id, content, parent = null) => ({
  type: "assistant", uuid: "a-" + id, session_id: "s", parent_tool_use_id: parent,
  message: { id, type: "message", role: "assistant", model: "claude-sonnet-4-6", content,
    stop_reason: null, stop_sequence: null, usage },
});
const toolResult = (uuid, toolUseId, content, parent = null) => ({
  type: "user", uuid, session_id: "s", parent_tool_use_id: parent,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId,
    is_error: false, content }] },
});
const released = async () => {
  while (!fs.existsSync(path.join(dir, "release"))) await new Promise((r) => setTimeout(r, 20));
};
const result = (text, uuid = "r-1") => out({ type: "result", subtype: "success", uuid, session_id: "s",
  is_error: false, num_turns: 1, result: text, stop_reason: "end_turn",
  duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage, modelUsage: {},
  permission_denials: [], terminal_reason: "completed" });
let prompted = false;
const turn = async () => {
${turn}
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
  } else if (m.type === "user" && (${String(everyPrompt)} || !prompted)) {
    prompted = true;
    void turn();
  }
});
lines.on("close", () => process.exit(0));
`;

// Starts a Bash call (`toolu_1`), then on release reports its result, a
// reply and the turn's result.
const BASH_TURN = String.raw`
  out(assistant("msg_tool", [{ type: "tool_use", id: "toolu_1", name: "Bash",
    input: { command: ${JSON.stringify(SLOW_COMMAND)} } }]));
  await released();
  out(toolResult("u-result", "toolu_1", "done-4857"));
  out(assistant("msg_reply", [{ type: "text", text: ${JSON.stringify(SLOW_COMMAND_REPLY)} }]));
  result(${JSON.stringify(SLOW_COMMAND_REPLY)});
`;

// Launches a foreground subagent (Agent call `toolu_agent`) that starts a
// Bash call (`toolu_sub_bash`); on release the Bash call, the subagent and
// the turn finish, in the order the real CLI reports them.
const SUBAGENT_TURN = String.raw`
  const task = ${JSON.stringify(SUBAGENT_TASK_ID)};
  const prompt = ${JSON.stringify(SUBAGENT_PROMPT)};
  out(assistant("msg_agent", [{ type: "tool_use", id: "toolu_agent", name: "Agent",
    input: { description: "Run the slow command", prompt, subagent_type: "general-purpose" } }]));
  out({ type: "system", subtype: "task_started", task_id: task, tool_use_id: "toolu_agent",
    description: "Run the slow command", task_type: "local_agent", prompt,
    uuid: "ts-1", session_id: "s" });
  out({ type: "user", uuid: "u-sub-prompt", session_id: "s", parent_tool_use_id: "toolu_agent",
    message: { role: "user", content: [{ type: "text", text: prompt }] } });
  out(assistant("msg_sub_tool", [{ type: "tool_use", id: "toolu_sub_bash", name: "Bash",
    input: { command: ${JSON.stringify(SLOW_COMMAND)} } }], "toolu_agent"));
  out({ type: "system", subtype: "task_progress", task_id: task, tool_use_id: "toolu_agent",
    description: "Running the slow command", usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 },
    last_tool_name: "Bash", uuid: "tp-1", session_id: "s" });
  await released();
  out(toolResult("u-sub-result", "toolu_sub_bash", "done-4857", "toolu_agent"));
  out({ type: "system", subtype: "task_progress", task_id: task, tool_use_id: "toolu_agent",
    description: "Summarizing", usage: { total_tokens: 20, tool_uses: 1, duration_ms: 9 },
    last_tool_name: "Bash", uuid: "tp-2", session_id: "s" });
  out(assistant("msg_sub_reply", [{ type: "text", text: ${JSON.stringify(SUBAGENT_RESULT)} }], "toolu_agent"));
  out({ type: "system", subtype: "task_notification", task_id: task, tool_use_id: "toolu_agent",
    status: "completed", output_file: "", summary: "Run the slow command",
    usage: { total_tokens: 20, tool_uses: 1, duration_ms: 10 }, uuid: "tn-1", session_id: "s" });
  out(toolResult("u-agent-result", "toolu_agent", [{ type: "text", text: ${JSON.stringify(SUBAGENT_RESULT)} }]));
  out(assistant("msg_reply", [{ type: "text", text: ${JSON.stringify(SLOW_COMMAND_REPLY)} }]));
  result(${JSON.stringify(SLOW_COMMAND_REPLY)});
`;

/** Writes a fake CLI into a fresh directory, removed when the scope closes. */
const fakeClaudeCliWith = (turn: string, everyPrompt = false) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-reattach-"));
      NodeFS.writeFileSync(NodePath.join(dir, "cli.mjs"), fakeCliSource(turn, everyPrompt));
      const cli = NodePath.join(dir, "claude");
      NodeFS.writeFileSync(
        cli,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$(dirname "$0")/cli.mjs"\n`,
        { mode: 0o755 },
      );
      return {
        cli,
        dir,
        /** Lets the fake CLI's Bash call finish. */
        release: () => NodeFS.writeFileSync(NodePath.join(dir, "release"), ""),
      };
    }),
    ({ dir }) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

/** A fake CLI whose turn is in a Bash call (`toolu_1`) until released. */
export const fakeClaudeCli = fakeClaudeCliWith(BASH_TURN);

/**
 * A fake CLI whose turn is in a foreground subagent (`SUBAGENT_TASK_ID`, Agent
 * call `toolu_agent`) running a Bash call (`toolu_sub_bash`) until released.
 */
export const fakeSubagentClaudeCli = fakeClaudeCliWith(SUBAGENT_TURN);

/** The background subagent the first turn of `fakeBackgroundSubagentClaudeCli` leaves running. */
export const BACKGROUND_SUBAGENT_TASK_ID = "a0fake0background1";

// The first prompt launches a background subagent (Agent call
// `toolu_bg_agent`, run_in_background) that never ends, and ends its turn.
// Every later prompt runs BASH_TURN.
const BACKGROUND_SUBAGENT_TURNS = String.raw`
  if (!fs.existsSync(path.join(dir, "launched"))) {
    fs.writeFileSync(path.join(dir, "launched"), "");
    const task = ${JSON.stringify(BACKGROUND_SUBAGENT_TASK_ID)};
    const prompt = "Keep working in the background.";
    out(assistant("msg_bg_agent", [{ type: "tool_use", id: "toolu_bg_agent", name: "Agent",
      input: { description: "Background work", prompt, subagent_type: "general-purpose",
        run_in_background: true } }]));
    out({ type: "system", subtype: "task_started", task_id: task, tool_use_id: "toolu_bg_agent",
      description: "Background work", task_type: "local_agent", prompt,
      uuid: "ts-bg", session_id: "s" });
    out(toolResult("u-bg-launched", "toolu_bg_agent",
      [{ type: "text", text: "Async agent launched successfully. agentId: " + task }]));
    out(assistant("msg_bg_started", [{ type: "text", text: "Started." }]));
    result("Started.", "r-bg");
    return;
  }
${BASH_TURN}`;

/**
 * A fake CLI whose first turn leaves a background subagent
 * (`BACKGROUND_SUBAGENT_TASK_ID`) running and ends; its next turn is in a
 * Bash call (`toolu_1`) until released.
 */
export const fakeBackgroundSubagentClaudeCli = fakeClaudeCliWith(BACKGROUND_SUBAGENT_TURNS, true);

/**
 * A keeper serving a fresh socket, named in T3_KEEPER_SOCKET while the scope
 * is open. `orphans: "drain"` suits a keeper that outlives many servers.
 */
export const keeperSocketWith = (options: { readonly orphans?: "hold" | "drain" } = {}) =>
  Effect.gen(function* () {
    const { keeper } = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-keeper-"));
        const keeper = await startKeeper({
          socketPath: NodePath.join(dir, "keeper.sock"),
          log: () => {},
          ...options,
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
    return keeper as { readonly socketPath: string };
  });

/** A keeper serving a fresh socket, holding orphans. */
export const keeperSocket = keeperSocketWith();

/** Resolves with the first line number the keeper confirmed as acknowledged. */
export const firstKeeperAck = Effect.gen(function* () {
  const acked = yield* Deferred.make<number>();
  const ack = vi.spyOn(KeeperProcess.prototype, "ack").mockImplementation(function (
    this: { _request: (msg: unknown) => Promise<unknown> },
    after: number,
  ) {
    const sent = this._request({ op: "ack", after });
    void sent.then(
      () => Deferred.doneUnsafe(acked, Exit.succeed(after)),
      () => {},
    );
    return sent;
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => ack.mockRestore()));
  return Deferred.await(acked);
});

/**
 * Waits until the keeper holds no unacknowledged line of the thread's CLI,
 * so a restart replays nothing the previous server already handled.
 */
export const keeperAckedThrough = (threadId: string) =>
  Effect.promise(async () => {
    const socketPath = process.env.T3_KEEPER_SOCKET!;
    for (let tries = 0; tries < 200; tries += 1) {
      const reply = (await keeperRequest(socketPath, { op: "list" }, { timeoutMs: 5_000 })) as {
        readonly handles?: ReadonlyArray<{ name: string; last: number; acked: number }>;
      };
      const entry = reply.handles?.find((candidate) => candidate.name === threadId);
      if (entry !== undefined && entry.last > 0 && entry.acked >= entry.last) return entry.acked;
      await sleep(50);
    }
    throw new Error(`t3-keeper never acknowledged every line of ${threadId}`);
  });

export const realQueryRunner = ClaudeAdapterV2.layerQueryRunner.pipe(
  Layer.provide(Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined })),
  Layer.provide(NodeServices.layer),
);

const settings = Schema.decodeSync(ClaudeSettings)({});

/**
 * A Claude adapter on the real query runner, spawning `binaryPath`. It offers
 * its wake turns to `continuationRequests`, when given.
 */
export const makeKeeperTestAdapter = (
  binaryPath: string,
  attachmentsDir: string,
  continuationRequests?: Parameters<
    typeof ClaudeAdapterV2.makeClaudeAdapterV2
  >[0]["continuationRequests"],
) =>
  Effect.gen(function* () {
    return yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: keeperTestModelSelection.instanceId,
      settings: { ...settings, binaryPath },
      environment: { ...process.env },
      attachmentsDir,
      fileSystem: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
      ...(continuationRequests === undefined ? {} : { continuationRequests }),
    });
  });
