// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off -- one long-lived
// child shared by every connection, read as raw bytes and timed per answer; called from a plain
// Promise handler, outside any Effect runtime.
/**
 * One long-running program per scheme: it prints `{"ready": true}`, then answers each `{"id"}`
 * stdin line with a UTF-8 `{"id", "link"}` line, `link` the target or null, and exits when stdin
 * closes. Until ready, and after it fails or times out, lookups answer `LINK_RESOLVER_UNAVAILABLE`.
 */
import * as NodeChildProcess from "node:child_process";

import type { LinkResolveResult, ResolvedLink, ResolvedLinkTone } from "@t3tools/contracts";

const LINK_RESOLVER_ANSWER_TIMEOUT_MS = 10_000;
export const LINK_RESOLVER_UNAVAILABLE = { unavailable: true } as const;
// A program that keeps dying before it answers is started again after 1 s, then 2 s, 4 s ... up
// to a minute, so a broken setting cannot spin; a run that answers resets the pause.
const MIN_RESTART_GAP_MS = 1_000;
const MAX_RESTART_GAP_MS = 60_000;
const ANSWER_CACHE_MS = 5_000;
const MAX_PENDING = 64;
const MAX_LABEL_LENGTH = 500;
const MAX_TOOLTIP_LENGTH = 4_000;
// Code points enough for any one grapheme a mark is meant to be; a longer one is cut first.
const MAX_MARK_LENGTH = 32;
// An answer line longer than this is not an answer; the program is stopped.
const MAX_LINE_BYTES = 1024 * 1024;
// stderr lines logged per minute; the rest are counted and the count logged once.
const MAX_STDERR_LINES_PER_MINUTE = 20;
const TONES: ReadonlySet<string> = new Set<ResolvedLinkTone>([
  "normal",
  "muted",
  "warning",
  "danger",
]);

export type LinkResolverSpawn = (
  command: string,
  args: ReadonlyArray<string>,
) => NodeChildProcess.ChildProcessWithoutNullStreams;

export interface LinkResolverOptions {
  readonly answerTimeoutMs?: number;
  readonly answerCacheMs?: number;
  readonly maxPending?: number;
  readonly spawn?: LinkResolverSpawn;
  readonly stop?: (child: NodeChildProcess.ChildProcessWithoutNullStreams) => void;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
}

type Answer = ResolvedLink | null;

interface Pending {
  readonly id: string;
  readonly settle: (answer: LinkResolveResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** The server's environment without its own settings and tokens, which a program has no use for. */
export function linkResolverEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith("T3CODE_")),
  );
}

// oxlint-disable-next-line t3code/no-global-process-runtime -- called from a plain Promise handler, outside any Effect runtime.
const IS_WINDOWS = process.platform === "win32";

const defaultSpawn: LinkResolverSpawn = (command, args) =>
  NodeChildProcess.spawn(command, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // Its own process group on POSIX, so `stopProcessTree` reaches what it started too.
    detached: !IS_WINDOWS,
    env: linkResolverEnv(process.env),
  });

/**
 * Closes the program's stdin and kills it with everything it started: a launcher such as a venv
 * `python.exe` or `uv run` would otherwise leave the real interpreter running. Synchronous, so it
 * also works from a `process.on("exit")` handler.
 */
function stopProcessTree(child: NodeChildProcess.ChildProcessWithoutNullStreams): void {
  child.stdin.destroy();
  const pid = child.pid;
  if (pid === undefined) return;
  const running = child.exitCode === null && child.signalCode === null;
  if (!IS_WINDOWS) {
    // The group outlives its leader, so it is killed even after the program itself exited.
    if (!killProcessGroup(pid) && running) child.kill("SIGKILL");
    return;
  }
  if (!running) return;
  const result = NodeChildProcess.spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 5_000,
  });
  if (result.status !== 0) child.kill();
}

function killProcessGroup(pid: number): boolean {
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

// A program writing another code page still gets its ASCII through; the rest shows as U+FFFD.
const utf8 = new TextDecoder("utf-8");

/** `JSON.stringify` with every non-ASCII code unit escaped, so any reader decodes it the same. */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[^\x00-\x7e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function firstGrapheme(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed);
  const segment = segments[Symbol.iterator]().next();
  return segment.done ? "" : segment.value.segment;
}

// A local absolute path: `/x` or `C:\x`. Network and device paths (`\\host\share`, `//host`,
// `\\?\`) are refused, since reading one makes the server connect to the host it names.
function isLocalAbsolutePath(path: string): boolean {
  if (/^[\\/]{2}/.test(path)) return false;
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/** A program's answer as the client may show it, or null for anything that is not one. */
export function normalizeResolvedLink(raw: unknown): ResolvedLink | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (path === "" || !isLocalAbsolutePath(path)) return null;
  const text = (value: unknown, max: number) =>
    typeof value === "string" ? value.slice(0, max) : "";
  const tone = typeof record.tone === "string" && TONES.has(record.tone) ? record.tone : "normal";
  return {
    path,
    label: text(record.label, MAX_LABEL_LENGTH).trim(),
    mark:
      typeof record.mark === "string"
        ? firstGrapheme(
            Array.from(record.mark.slice(0, MAX_MARK_LENGTH * 2))
              .slice(0, MAX_MARK_LENGTH)
              .join(""),
          )
        : "",
    tone: tone as ResolvedLinkTone,
    tooltip: text(record.tooltip, MAX_TOOLTIP_LENGTH),
  };
}

export class LinkResolverProcess {
  private child: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  private readonly pending: Pending[] = [];
  private readonly inFlight = new Map<string, Promise<LinkResolveResult>>();
  private readonly cache = new Map<string, { readonly answer: Answer; readonly at: number }>();
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private lastStartAt = Number.NEGATIVE_INFINITY;
  // Runs in a row that ended before answering anything; sets the pause before the next start.
  private failuresInARow = 0;
  private answeredSinceStart = false;
  // Set by the program's ready line; until then it is sent nothing, so nothing is timed.
  private ready = false;
  private stderrWindowStart = Number.NEGATIVE_INFINITY;
  private stderrLines = 0;
  private closed = false;
  private warnedNoCommand = false;
  private warnedNotReady = false;
  private readonly answerTimeoutMs: number;
  private readonly answerCacheMs: number;
  private readonly maxPending: number;
  private readonly spawnChild: LinkResolverSpawn;
  private readonly stopChild: (child: NodeChildProcess.ChildProcessWithoutNullStreams) => void;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  readonly scheme: string;
  readonly argv: ReadonlyArray<string>;

  constructor(scheme: string, argv: ReadonlyArray<string>, options: LinkResolverOptions = {}) {
    this.scheme = scheme;
    this.argv = argv;
    this.answerTimeoutMs = options.answerTimeoutMs ?? LINK_RESOLVER_ANSWER_TIMEOUT_MS;
    this.answerCacheMs = options.answerCacheMs ?? ANSWER_CACHE_MS;
    this.maxPending = options.maxPending ?? MAX_PENDING;
    this.spawnChild = options.spawn ?? defaultSpawn;
    this.stopChild = options.stop ?? stopProcessTree;
    this.log = options.log ?? ((message) => console.warn(message));
    this.now = options.now ?? Date.now;
  }

  resolve(id: string): Promise<LinkResolveResult> {
    if (this.closed) return Promise.resolve(null);
    const cached = this.cache.get(id);
    if (cached !== undefined && this.now() - cached.at < this.answerCacheMs) {
      return Promise.resolve(cached.answer);
    }
    const asked = this.inFlight.get(id);
    if (asked !== undefined) return asked;
    const lookup = this.ask(id).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, lookup);
    return lookup;
  }

  /** Starts the program now rather than on the first lookup. */
  start(): void {
    if (!this.closed) this.ensureChild();
  }

  /** Stops the program; later lookups answer null. */
  close(): void {
    this.closed = true;
    this.cache.clear();
    if (this.child !== null) this.fail(this.child, null);
  }

  private ask(id: string): Promise<LinkResolveResult> {
    if (this.pending.length >= this.maxPending) return Promise.resolve(LINK_RESOLVER_UNAVAILABLE);
    const child = this.ensureChild();
    if (child === null) return Promise.resolve(LINK_RESOLVER_UNAVAILABLE);
    if (!this.ready) {
      // No deadline: an index build on a cold disk can take minutes. Said once per start, so a
      // program that never prints its ready line is visible in the log.
      if (!this.warnedNotReady) {
        const seconds = Math.round((this.now() - this.lastStartAt) / 1_000);
        this.log(
          `link resolver ${this.scheme}: started ${seconds} s ago, no {"ready": true} line yet; answering unavailable until then`,
        );
      }
      this.warnedNotReady = true;
      return Promise.resolve(LINK_RESOLVER_UNAVAILABLE);
    }
    return new Promise((settle) => {
      const entry: Pending = { id, settle, timer: null };
      this.pending.push(entry);
      if (this.pending.length === 1) this.armHeadTimer();
      try {
        child.stdin.write(Buffer.from(`${asciiJson({ id })}\n`, "utf8"));
      } catch (cause) {
        this.fail(child, `write failed: ${String(cause)}`);
      }
    });
  }

  private ensureChild(): NodeChildProcess.ChildProcessWithoutNullStreams | null {
    if (this.child !== null) return this.child;
    const [command, ...args] = this.argv;
    if (command === undefined || command.trim() === "") {
      if (!this.warnedNoCommand) this.log(`link resolver ${this.scheme}: no program configured`);
      this.warnedNoCommand = true;
      return null;
    }
    const now = this.now();
    const restartGapMs = Math.min(
      MIN_RESTART_GAP_MS * 2 ** Math.max(this.failuresInARow - 1, 0),
      MAX_RESTART_GAP_MS,
    );
    if (now - this.lastStartAt < restartGapMs) return null;
    this.lastStartAt = now;
    this.answeredSinceStart = false;
    this.ready = false;
    this.warnedNotReady = false;
    let child: NodeChildProcess.ChildProcessWithoutNullStreams;
    try {
      child = this.spawnChild(command, args);
    } catch (cause) {
      this.log(`link resolver ${this.scheme}: could not start ${command}: ${String(cause)}`);
      this.failuresInARow += 1;
      return null;
    }
    this.child = child;
    this.buffered = [];
    this.bufferedBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => this.onData(child, chunk));
    child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    child.stdin.on("error", (cause) => this.fail(child, `stdin: ${String(cause)}`));
    child.on("error", (cause) => this.fail(child, `process: ${String(cause)}`));
    // `close`, not `exit`: it comes after stdout is drained, so the last answers are read first.
    // It waits for every holder of the pipes, so on exit what the program started is killed too.
    child.on("exit", () => {
      if (!IS_WINDOWS && child.pid !== undefined) killProcessGroup(child.pid);
    });
    child.on("close", (code, signal) =>
      this.fail(child, `exited (${signal ?? `code ${String(code)}`})`),
    );
    return child;
  }

  private onStderr(chunk: Buffer): void {
    for (const raw of chunk.toString("utf8").split("\n")) this.logProgramLine(raw);
  }

  // The program's own lines, stderr and stray stdout, at most MAX_STDERR_LINES_PER_MINUTE.
  private logProgramLine(raw: string): void {
    const text = raw.trim();
    if (text === "") return;
    const now = this.now();
    if (now - this.stderrWindowStart >= 60_000) {
      const muted = this.stderrLines - MAX_STDERR_LINES_PER_MINUTE;
      if (muted > 0) this.log(`link resolver ${this.scheme}: ${muted} more lines not logged`);
      this.stderrWindowStart = now;
      this.stderrLines = 0;
    }
    this.stderrLines += 1;
    if (this.stderrLines <= MAX_STDERR_LINES_PER_MINUTE) {
      this.log(`link resolver ${this.scheme}: ${text.slice(0, 2_000)}`);
    }
  }

  private onData(child: NodeChildProcess.ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (child !== this.child) return;
    let rest = chunk;
    for (let at = rest.indexOf(0x0a); at !== -1; at = rest.indexOf(0x0a)) {
      const line = Buffer.concat([...this.buffered, rest.subarray(0, at)]);
      this.buffered = [];
      this.bufferedBytes = 0;
      rest = rest.subarray(at + 1);
      this.onLine(line);
      if (child !== this.child) return;
    }
    if (rest.length === 0) return;
    this.buffered.push(rest);
    this.bufferedBytes += rest.length;
    if (this.bufferedBytes > MAX_LINE_BYTES) this.fail(child, "answer line too long");
  }

  private onLine(bytes: Buffer): void {
    // A CRLF writer ends its lines with \r\n.
    const line = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
    if (!this.ready) {
      this.onFirstLine(line);
      return;
    }
    const text = utf8.decode(line);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const record =
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    const at =
      typeof record?.id === "string"
        ? this.pending.findIndex((entry) => entry.id === record.id)
        : -1;
    // A line that names no waiting lookup is not an answer, whatever it holds: matching by order
    // would hand every later answer to the wrong link.
    if (record === null || at === -1) {
      const hint =
        record !== null && !("id" in record) ? " (no id: a program on the old protocol?)" : "";
      this.logProgramLine(
        `not an answer to a waiting lookup${hint}, dropped: ${text.slice(0, 200)}`,
      );
      return;
    }
    const [entry] = this.pending.splice(at, 1);
    if (entry === undefined) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    if (at === 0) this.armHeadTimer();
    this.answeredSinceStart = true;
    const answer = normalizeResolvedLink(record.link);
    this.remember(entry.id, answer);
    entry.settle(answer);
  }

  private onFirstLine(line: Buffer): void {
    const text = utf8.decode(line).trim();
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "ready" in parsed &&
        parsed.ready === true
      ) {
        this.ready = true;
        return;
      }
    } catch {
      // Not JSON: a protocol error like any other first line.
    }
    if (this.child !== null) {
      this.fail(this.child, `first line is not {"ready": true}: ${text.slice(0, 200)}`);
    }
  }

  private remember(id: string, answer: Answer): void {
    const now = this.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.at >= this.answerCacheMs) this.cache.delete(key);
    }
    this.cache.set(id, { answer, at: now });
  }

  // Only the oldest lookup is timed: it has waited longest, and an answer to any later one resets
  // nothing, so a program that never answers it is stopped.
  private armHeadTimer(): void {
    const head = this.pending[0];
    if (head === undefined || head.timer !== null) return;
    const child = this.child;
    head.timer = setTimeout(() => {
      if (child !== null) this.fail(child, `no answer in ${this.answerTimeoutMs} ms`);
    }, this.answerTimeoutMs);
  }

  private fail(
    child: NodeChildProcess.ChildProcessWithoutNullStreams,
    reason: string | null,
  ): void {
    if (child !== this.child) return;
    this.child = null;
    this.ready = false;
    this.buffered = [];
    this.bufferedBytes = 0;
    this.failuresInARow = this.answeredSinceStart ? 0 : this.failuresInARow + 1;
    if (reason !== null && !this.closed) this.log(`link resolver ${this.scheme}: ${reason}`);
    for (const entry of this.pending.splice(0)) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.settle(this.closed ? null : LINK_RESOLVER_UNAVAILABLE);
    }
    this.stopChild(child);
  }
}

/**
 * The `links.resolve` answer: null for a scheme this server has no program for, else what the
 * scheme's program says.
 */
export function resolveLink(
  resolvers: Readonly<Record<string, ReadonlyArray<string>>> | undefined,
  input: { readonly scheme: string; readonly id: string },
  resolverFor: typeof linkResolverFor = linkResolverFor,
): Promise<LinkResolveResult> {
  if (resolvers === undefined || !Object.hasOwn(resolvers, input.scheme)) {
    return Promise.resolve(null);
  }
  return resolverFor(input.scheme, resolvers[input.scheme]!).resolve(input.id);
}

/** Starts every configured scheme's program. */
export function startLinkResolvers(
  resolvers: Readonly<Record<string, ReadonlyArray<string>>> | undefined,
  resolverFor: typeof linkResolverFor = linkResolverFor,
): void {
  for (const [scheme, argv] of Object.entries(resolvers ?? {})) resolverFor(scheme, argv).start();
}

const processes = new Map<string, LinkResolverProcess>();

/** The one running program for a scheme and argv, shared by every connection. */
export function linkResolverFor(scheme: string, argv: ReadonlyArray<string>): LinkResolverProcess {
  const key = asciiJson([scheme, argv]);
  let resolver = processes.get(key);
  if (resolver === undefined) {
    resolver = new LinkResolverProcess(scheme, argv);
    processes.set(key, resolver);
    if (processes.size === 1) process.once("exit", closeAllLinkResolvers);
  }
  return resolver;
}

function closeAllLinkResolvers(): void {
  for (const resolver of processes.values()) resolver.close();
  processes.clear();
}
