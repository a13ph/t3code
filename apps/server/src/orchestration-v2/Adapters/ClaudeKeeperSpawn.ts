// @effect-diagnostics globalConsole:off - The SDK calls the spawner outside the Effect runtime.
/**
 * Spawns the Claude CLI through t3-keeper (`../../t3Keeper/`) when
 * `T3_KEEPER_SOCKET` names its socket. A relative path is taken under
 * `$XDG_RUNTIME_DIR`.
 *
 * The CLI and every command it starts are children of the keeper, not of the
 * server. The CLI leads its own process group there, and what it leaves in
 * the group is killed when it exits, as with `spawnClaudeProcessGroup`.
 *
 * A server shutdown detaches every keeper child first
 * (`detachKeeperChildren`, on SIGTERM and SIGINT), so the SDK's own close,
 * which ends stdin and then signals, no longer reaches them, and a turn in
 * flight keeps running in the keeper. A stop of one session still ends its
 * CLI. The next server lists the keeper (`listKeeperThreads`) and attaches
 * to a thread's CLI again (`keeperAttachProcess`), from the last line it
 * acknowledged.
 *
 * The keeper holds every stdout line until it is acknowledged. A line is
 * acknowledged only once the adapter has handled the message it carried, and
 * a second or two later still, so the events it produced have reached the
 * database before the keeper may drop it. A restart replays the lines after
 * that point; the few handled just before the restart arrive twice.
 *
 * When the keeper cannot be reached for 10 s, the shim spawns the CLI
 * itself, as the SDK would have; that CLI still dies with the server.
 */
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
// @effect-diagnostics nodeBuiltinImport:off -- the socket path is a host path.
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";

// @ts-ignore - plain ESM without types
import { attachExisting, request, spawnNew } from "../../t3Keeper/shim.mjs";

/** How long a handled line waits before the keeper is told it may drop it. */
export const KEEPER_ACK_LAG_MS = 1_000;

function keeperSocketPath(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.T3_KEEPER_SOCKET;
  if (!raw) return undefined;
  if (NodePath.isAbsolute(raw)) return raw;
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (!runtimeDir) {
    console.warn(
      `t3-keeper: T3_KEEPER_SOCKET=${raw} is relative and XDG_RUNTIME_DIR is unset, spawning claude without the keeper`,
    );
    return undefined;
  }
  return NodePath.join(runtimeDir, raw);
}

interface KeeperChild extends SpawnedProcess {
  readonly local: boolean;
  readonly detached: boolean;
  readonly cursor: number;
  ack(after: number): Promise<unknown>;
  detach(): unknown;
}

/** One CLI in the keeper, as the SDK's spawner plus the hooks that acknowledge its lines. */
export interface KeeperSpawner {
  /** The SDK's `spawnClaudeCodeProcess`. */
  readonly spawn: (options: SpawnOptions) => SpawnedProcess;
  /** Called for each message the SDK yields, in order: ties it to its stdout line. */
  readonly yielded: (message: { readonly type?: unknown }) => void;
  /** Called once a yielded message is handled: its line may be acknowledged. */
  readonly handled: (message: object) => void;
}

// Lines the SDK consumes itself and never yields as a message
// (Query.readMessages in @anthropic-ai/claude-agent-sdk).
const UNYIELDED_LINE_TYPES = new Set([
  "control_request",
  "control_response",
  "control_cancel_request",
  "keep_alive",
  "transcript_mirror",
]);
const LINE_TYPE_PREFIX = /^\s*\{\s*"type"\s*:\s*"([^"\\]*)"/;

/** The `type` of the message the SDK yields for a stdout line, or undefined when it yields none. */
function yieldedLineType(line: string): string | undefined {
  let type = LINE_TYPE_PREFIX.exec(line)?.[1];
  if (type === undefined) {
    if (line.trim() === "") return undefined;
    try {
      const parsed: unknown = JSON.parse(line);
      const parsedType: unknown =
        typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "type") : undefined;
      type = typeof parsedType === "string" ? parsedType : "";
    } catch {
      return undefined;
    }
  }
  return UNYIELDED_LINE_TYPES.has(type) ? undefined : type;
}

type ControlLineType = "control_request" | "control_response" | "control_cancel_request";

/** The `request_id` of a control request, response or cancel line, or undefined. */
function controlRequestId(line: string, type: ControlLineType): string | undefined {
  if (!line.includes(type)) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Reflect.get(parsed, "type") !== type) {
      return undefined;
    }
    const holder: unknown = type === "control_response" ? Reflect.get(parsed, "response") : parsed;
    const id: unknown =
      typeof holder === "object" && holder !== null ? Reflect.get(holder, "request_id") : undefined;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tracks the stdout lines T3 must act on and acknowledges them to the keeper,
 * `KEEPER_ACK_LAG_MS` to twice that after they were handled. A yielded
 * message's line is handled once the adapter handled the message. A control
 * request's line (a permission prompt, a hook callback) is handled once the
 * SDK wrote its control_response to stdin, or the CLI cancelled it, so a
 * restart does not ask an answered prompt again and still replays an open
 * one. The acknowledged point is the highest line below every open line.
 * Stops acknowledging for good once the child is detached, and when a
 * yielded message does not match the next line it expected.
 */
function makeLineCursor(threadId: string, start: number) {
  let child: KeeperChild | undefined;
  const lines: Array<{ readonly n: number; readonly type: string }> = [];
  const lineOf = new WeakMap<object, number>();
  const open = new Set<number>();
  const requestLines = new Map<string, number>();
  let broken = false;
  let lastHandled = start;
  let handledThrough = start;
  let snapshot = start;
  let acked = start;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = () => {
    timer = undefined;
    if (child === undefined || child.detached || child.local) return;
    if (snapshot > acked) {
      acked = snapshot;
      child.ack(acked).catch(() => {});
    }
    snapshot = handledThrough;
    if (handledThrough > acked) schedule();
  };
  const schedule = () => {
    timer = setTimeout(tick, KEEPER_ACK_LAG_MS);
    timer.unref?.();
  };
  const stopTracking = (reason: string) => {
    if (broken) return;
    broken = true;
    lines.length = 0;
    open.clear();
    requestLines.clear();
    console.warn(`t3-keeper: thread ${threadId} stops acknowledging lines: ${reason}`);
  };
  const markHandled = (n: number, yielded: boolean) => {
    if (broken || !open.delete(n)) return;
    // Messages are handled in the order they were yielded, so one handled
    // message settles the yielded lines before it; a control request waits
    // for its own answer.
    if (yielded) {
      const requests = new Set(requestLines.values());
      for (const pending of open) if (pending < n && !requests.has(pending)) open.delete(pending);
    }
    if (n > lastHandled) lastHandled = n;
    let through = lastHandled;
    for (const pending of open) if (pending - 1 < through) through = pending - 1;
    if (through > handledThrough) handledThrough = through;
    if (timer === undefined && handledThrough > acked) {
      snapshot = handledThrough;
      schedule();
    }
  };
  const settleRequest = (requestId: string | undefined) => {
    if (requestId === undefined) return;
    const n = requestLines.get(requestId);
    if (n === undefined) return;
    requestLines.delete(requestId);
    markHandled(n, false);
  };

  return {
    bind(spawned: KeeperChild) {
      child = spawned;
      const stdout = spawned.stdout as NodeStream.PassThrough;
      const write = stdout.write;
      // The shim moves its cursor to a line's number, then writes the line.
      stdout.write = function (
        this: NodeStream.PassThrough,
        chunk: unknown,
        ...rest: Array<unknown>
      ) {
        if (!broken && !spawned.local && typeof chunk === "string") {
          const line = chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk;
          const type = yieldedLineType(line);
          if (type !== undefined) {
            lines.push({ n: spawned.cursor, type });
            open.add(spawned.cursor);
          } else {
            const requestId = controlRequestId(line, "control_request");
            if (requestId !== undefined) {
              requestLines.set(requestId, spawned.cursor);
              open.add(spawned.cursor);
            } else {
              settleRequest(controlRequestId(line, "control_cancel_request"));
            }
          }
        }
        return Reflect.apply(write, this, [chunk, ...rest]);
      } as NodeStream.PassThrough["write"];
      // The SDK answers a control request with one write of one line.
      const stdin = spawned.stdin as NodeStream.Writable;
      const writeIn = stdin.write;
      stdin.write = function (this: NodeStream.Writable, chunk: unknown, ...rest: Array<unknown>) {
        if (!broken && !spawned.local && typeof chunk === "string" && requestLines.size > 0) {
          for (const line of chunk.split("\n")) {
            settleRequest(controlRequestId(line, "control_response"));
          }
        }
        return Reflect.apply(writeIn, this, [chunk, ...rest]);
      } as NodeStream.Writable["write"];
    },
    yielded(message: { readonly type?: unknown }) {
      if (broken || child === undefined || child.local) return;
      const line = lines.shift();
      const type = typeof message.type === "string" ? message.type : "";
      if (line === undefined || line.type !== type) {
        stopTracking(`message ${type} does not match line ${line?.n ?? "none"} (${line?.type})`);
        return;
      }
      lineOf.set(message, line.n);
    },
    handled(message: object) {
      const n = lineOf.get(message);
      if (n !== undefined) markHandled(n, true);
    },
  };
}

function makeSpawner(
  threadId: string,
  start: number,
  spawner: (options: SpawnOptions) => SpawnedProcess,
): KeeperSpawner {
  const cursor = makeLineCursor(threadId, start);
  return {
    // The CLI and its commands do not get the socket, so a T3 server or
    // test run started by the CLI never spawns into this keeper.
    spawn: (spawnOptions) => {
      const { T3_KEEPER_SOCKET: _, ...env } = spawnOptions.env;
      const child = spawner({ ...spawnOptions, env }) as KeeperChild;
      cursor.bind(child);
      liveChildren.set(child, threadId);
      child.once("exit", () => liveChildren.delete(child));
      child.once("error", () => liveChildren.delete(child));
      return child;
    },
    yielded: cursor.yielded,
    handled: cursor.handled,
  };
}

/** A new CLI in the keeper for one thread, or undefined without a keeper socket. */
export function keeperSpawnProcess(
  threadId: string,
  options: { readonly env?: NodeJS.ProcessEnv; readonly connectRetryMs?: number } = {},
): KeeperSpawner | undefined {
  const socketPath = keeperSocketPath(options.env ?? process.env);
  if (socketPath === undefined) return undefined;
  return makeSpawner(
    threadId,
    0,
    spawnNew({
      socketPath,
      name: threadId,
      group: true,
      // a keeper that is restarting still gets the CLI
      connectRetryMs: options.connectRetryMs ?? 10_000,
      fallbackLocal: true,
      onFallback: (error: NodeJS.ErrnoException) => {
        console.warn(
          `t3-keeper: ${socketPath} unreachable (${error.code ?? error.message}), spawning claude locally for thread ${threadId}`,
        );
      },
    }),
  );
}

/**
 * Attaches to a thread's CLI that outlived the previous server, from the
 * line after `after`; undefined without a keeper socket. The SDK's argv is
 * ignored: the CLI already runs.
 */
export function keeperAttachProcess(
  threadId: string,
  attach: { readonly handle: string; readonly after: number },
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): KeeperSpawner | undefined {
  const socketPath = keeperSocketPath(options.env ?? process.env);
  if (socketPath === undefined) return undefined;
  return makeSpawner(
    threadId,
    attach.after,
    attachExisting({ socketPath, handle: attach.handle, after: attach.after }),
  );
}

/** A CLI in the keeper a restarted server can attach to. */
export interface KeeperThread {
  readonly handle: string;
  /** The last line the previous server acknowledged. */
  readonly after: number;
}

/**
 * The keeper's CLIs by thread id: those still running, or exited with lines
 * nobody acknowledged. Undefined without a keeper socket or when the keeper
 * does not answer.
 */
export async function listKeeperThreads(
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<ReadonlyMap<string, KeeperThread> | undefined> {
  const socketPath = keeperSocketPath(options.env ?? process.env);
  if (socketPath === undefined) return undefined;
  let reply: { readonly ok?: boolean; readonly handles?: ReadonlyArray<KeeperListEntry> };
  try {
    reply = await request(socketPath, { op: "list" }, { timeoutMs: 5_000 });
  } catch (error) {
    console.warn(`t3-keeper: ${socketPath} did not answer list (${String(error)})`);
    return undefined;
  }
  if (reply.ok !== true || reply.handles === undefined) return undefined;
  const newest = new Map<string, KeeperListEntry>();
  for (const entry of reply.handles) {
    if (typeof entry.name !== "string" || typeof entry.handle !== "string") continue;
    if (!entry.alive && entry.last <= entry.acked) continue;
    const seen = newest.get(entry.name);
    if (seen === undefined || seen.created < entry.created) newest.set(entry.name, entry);
  }
  return new Map(
    [...newest].map(([threadId, entry]) => [
      threadId,
      { handle: entry.handle, after: entry.acked },
    ]),
  );
}

/**
 * Ends a thread's CLI in the keeper (stdin EOF, then signals) and drops its
 * held lines. Best effort: false without a keeper socket or an answer.
 */
export async function closeKeeperThread(
  handle: string,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const socketPath = keeperSocketPath(options.env ?? process.env);
  if (socketPath === undefined) return false;
  try {
    // The keeper answers once the CLI exited: EOF, then SIGTERM and SIGKILL.
    const reply = await request(socketPath, { op: "close", handle }, { timeoutMs: 15_000 });
    return reply?.ok === true;
  } catch (error) {
    console.warn(`t3-keeper: ${socketPath} did not close ${handle} (${String(error)})`);
    return false;
  }
}

interface KeeperListEntry {
  readonly handle: string;
  readonly name: string | null;
  readonly alive: boolean;
  readonly last: number;
  readonly acked: number;
  readonly created: string;
}

/** A CLI shutdown left running in the keeper, and what the adapter knew of its turn then. */
export interface KeeperDetachedThread {
  readonly handle: string;
  readonly adapterState: unknown;
}

const liveChildren = new Map<KeeperChild, string>();
const turnStateReaders = new Map<string, () => unknown>();
const detachedThreads = new Map<string, KeeperDetachedThread>();

/** How the adapter's live turn state of a thread is read when shutdown detaches its CLI. */
export function registerKeeperTurnState(threadId: string, read: () => unknown): void {
  turnStateReaders.set(threadId, read);
}

/** Drops a thread's turn state reader, unless a later query replaced it. */
export function unregisterKeeperTurnState(threadId: string, read: () => unknown): void {
  if (turnStateReaders.get(threadId) === read) turnStateReaders.delete(threadId);
}

/** The threads with a registered turn state reader. */
export function keeperTurnStateThreads(): ReadonlyArray<string> {
  return [...turnStateReaders.keys()];
}

/**
 * Leaves every live keeper child running: drops its connection without an
 * EOF. A local fallback child is left alone and dies with the server.
 */
export function detachKeeperChildren(): number {
  let detached = 0;
  for (const [child, threadId] of liveChildren) {
    if (child.local) continue;
    child.detach();
    const handle: unknown = Reflect.get(child, "handle");
    if (typeof handle === "string") {
      detachedThreads.set(threadId, {
        handle,
        adapterState: turnStateReaders.get(threadId)?.() ?? null,
      });
    }
    detached += 1;
  }
  liveChildren.clear();
  if (detached > 0) {
    console.warn(`t3-keeper: shutdown detached ${detached} claude process(es)`);
  }
  return detached;
}

/**
 * Threads whose CLI shutdown left running in the keeper, by thread id.
 * Shutdown records nothing as ended for them: the next server attaches to the
 * CLI again.
 */
export function keeperDetachedThreads(): ReadonlyMap<string, KeeperDetachedThread> {
  return detachedThreads;
}
