// @effect-diagnostics nodeBuiltinImport:off -- the fake CLI and the keeper are real processes and sockets.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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
import { KeeperProcess } from "../../t3Keeper/shim.mjs";

export const keeperTestModelSelection = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
};

export const SLOW_COMMAND = "sleep 60; echo done-4857";
export const SLOW_COMMAND_REPLY = "The command printed done-4857.";

// A stand-in for the Claude CLI on the stream-json protocol: it answers every
// control request, and on the first prompt starts a Bash call (`toolu_1`),
// then holds until `release` exists next to it, then reports the call's
// result, a reply and the turn's result.
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
    input: { command: ${JSON.stringify(SLOW_COMMAND)} } }]));
  while (!fs.existsSync(path.join(dir, "release"))) await new Promise((r) => setTimeout(r, 20));
  out({ type: "user", uuid: "u-result", session_id: "s", parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1",
      is_error: false, content: "done-4857" }] } });
  out(assistant("msg_reply", [{ type: "text", text: ${JSON.stringify(SLOW_COMMAND_REPLY)} }]));
  out({ type: "result", subtype: "success", uuid: "r-1", session_id: "s", is_error: false,
    num_turns: 1, result: ${JSON.stringify(SLOW_COMMAND_REPLY)}, stop_reason: "end_turn",
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

/** Writes the fake CLI into a fresh directory, removed when the scope closes. */
export const fakeClaudeCli = Effect.acquireRelease(
  Effect.sync(() => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-reattach-"));
    NodeFS.writeFileSync(NodePath.join(dir, "cli.mjs"), FAKE_CLI);
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
