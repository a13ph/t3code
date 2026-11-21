/**
 * Resolves chat links of a configured scheme through an external program.
 *
 * The server starts the scheme's program once and keeps it running. Each lookup is one line of
 * JSON on its stdin, `{"id":"<what follows scheme://>"}`, and the program answers each with one
 * line on stdout, in order: `{"path","label","mark","tone","tooltip"}`, or `null` when it does not
 * know the link. A program that exits is started again on the next lookup. One that leaves a
 * lookup unanswered for `answerTimeoutMs` is stopped and every waiting lookup answers null, since
 * a late answer would be read as the answer to the next question.
 *
 * Process I/O is bytes with explicit UTF-8 both ways, never the host's code page: requests are
 * written as ASCII JSON (anything else escaped as `\uXXXX`), and an answer line that is not valid
 * UTF-8 is logged and answers null rather than being read with replacement characters.
 */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as Path from "node:path";

import type { ResolvedLink, ResolvedLinkTone } from "@t3tools/contracts";

export const LINK_RESOLVER_ANSWER_TIMEOUT_MS = 10_000;
// A program that keeps dying is started at most this often, so a broken setting cannot spin.
const MIN_RESTART_GAP_MS = 1_000;
const MAX_LABEL_LENGTH = 500;
const MAX_TOOLTIP_LENGTH = 4_000;
// An answer line longer than this is not an answer; the program is stopped.
const MAX_LINE_BYTES = 1024 * 1024;
const TONES: ReadonlySet<string> = new Set<ResolvedLinkTone>(["normal", "muted", "warning", "danger"]);

export type LinkResolverSpawn = (
  command: string,
  args: ReadonlyArray<string>,
) => ChildProcessWithoutNullStreams;

export interface LinkResolverOptions {
  readonly answerTimeoutMs?: number;
  readonly spawn?: LinkResolverSpawn;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
}

interface Pending {
  readonly settle: (answer: ResolvedLink | null) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const defaultSpawn: LinkResolverSpawn = (command, args) =>
  nodeSpawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

const utf8 = new TextDecoder("utf-8", { fatal: true });

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
  const segment = new Intl.Segmenter(undefined, { granularity: "grapheme" })
    .segment(trimmed)
    [Symbol.iterator]()
    .next();
  return segment.done ? "" : segment.value.segment;
}

function isAbsoluteHostPath(path: string): boolean {
  return Path.posix.isAbsolute(path) || Path.win32.isAbsolute(path);
}

/** A program's answer as the client may show it, or null for anything that is not one. */
export function normalizeResolvedLink(raw: unknown): ResolvedLink | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (path === "" || !isAbsoluteHostPath(path)) return null;
  const text = (value: unknown, max: number) =>
    typeof value === "string" ? value.slice(0, max) : "";
  const tone = typeof record.tone === "string" && TONES.has(record.tone) ? record.tone : "normal";
  return {
    path,
    label: text(record.label, MAX_LABEL_LENGTH).trim(),
    mark: typeof record.mark === "string" ? firstGrapheme(record.mark) : "",
    tone: tone as ResolvedLinkTone,
    tooltip: text(record.tooltip, MAX_TOOLTIP_LENGTH),
  };
}

export class LinkResolverProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending: Pending[] = [];
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private lastStartAt = Number.NEGATIVE_INFINITY;
  private closed = false;
  private readonly answerTimeoutMs: number;
  private readonly spawnChild: LinkResolverSpawn;
  private readonly log: (message: string) => void;
  private readonly now: () => number;

  constructor(
    readonly scheme: string,
    readonly argv: ReadonlyArray<string>,
    options: LinkResolverOptions = {},
  ) {
    this.answerTimeoutMs = options.answerTimeoutMs ?? LINK_RESOLVER_ANSWER_TIMEOUT_MS;
    this.spawnChild = options.spawn ?? defaultSpawn;
    this.log = options.log ?? ((message) => console.warn(message));
    this.now = options.now ?? Date.now;
  }

  resolve(id: string): Promise<ResolvedLink | null> {
    const child = this.ensureChild();
    if (child === null) return Promise.resolve(null);
    return new Promise((settle) => {
      const entry: Pending = { settle, timer: null };
      this.pending.push(entry);
      if (this.pending.length === 1) this.armHeadTimer();
      try {
        child.stdin.write(Buffer.from(`${asciiJson({ id })}\n`, "utf8"));
      } catch (cause) {
        this.fail(child, `write failed: ${String(cause)}`);
      }
    });
  }

  /** Stops the program; later lookups answer null. */
  close(): void {
    this.closed = true;
    if (this.child !== null) this.fail(this.child, null);
  }

  private ensureChild(): ChildProcessWithoutNullStreams | null {
    if (this.closed) return null;
    if (this.child !== null) return this.child;
    const [command, ...args] = this.argv;
    if (command === undefined || command.trim() === "") return null;
    const now = this.now();
    if (now - this.lastStartAt < MIN_RESTART_GAP_MS) return null;
    this.lastStartAt = now;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnChild(command, args);
    } catch (cause) {
      this.log(`link resolver ${this.scheme}: could not start ${command}: ${String(cause)}`);
      return null;
    }
    this.child = child;
    this.buffered = [];
    this.bufferedBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => this.onData(child, chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text !== "") this.log(`link resolver ${this.scheme}: ${text.slice(0, 2_000)}`);
    });
    child.stdin.on("error", (cause) => this.fail(child, `stdin: ${String(cause)}`));
    child.on("error", (cause) => this.fail(child, `process: ${String(cause)}`));
    child.on("exit", (code, signal) =>
      this.fail(child, `exited (${signal ?? `code ${String(code)}`})`),
    );
    return child;
  }

  private onData(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
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
    const head = this.pending.shift();
    if (head === undefined) {
      this.log(`link resolver ${this.scheme}: answer with no question, ignored`);
      return;
    }
    if (head.timer !== null) clearTimeout(head.timer);
    this.armHeadTimer();
    let answer: ResolvedLink | null = null;
    try {
      const text = utf8.decode(line).trim();
      answer = text === "" ? null : normalizeResolvedLink(JSON.parse(text));
    } catch (cause) {
      this.log(`link resolver ${this.scheme}: unreadable answer: ${String(cause)}`);
    }
    head.settle(answer);
  }

  // Only the oldest lookup is timed: the program answers in order, so it is the one owed next.
  private armHeadTimer(): void {
    const head = this.pending[0];
    if (head === undefined || head.timer !== null) return;
    const child = this.child;
    head.timer = setTimeout(() => {
      if (child !== null) this.fail(child, `no answer in ${this.answerTimeoutMs} ms`);
    }, this.answerTimeoutMs);
  }

  private fail(child: ChildProcessWithoutNullStreams, reason: string | null): void {
    if (child !== this.child) return;
    this.child = null;
    this.buffered = [];
    this.bufferedBytes = 0;
    if (reason !== null && !this.closed) this.log(`link resolver ${this.scheme}: ${reason}`);
    for (const entry of this.pending.splice(0)) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.settle(null);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

const processes = new Map<string, LinkResolverProcess>();

/** The one running program for a scheme and argv, shared by every connection. */
export function linkResolverFor(
  scheme: string,
  argv: ReadonlyArray<string>,
): LinkResolverProcess {
  const key = asciiJson([scheme, argv]);
  let resolver = processes.get(key);
  if (resolver === undefined) {
    resolver = new LinkResolverProcess(scheme, argv);
    processes.set(key, resolver);
    if (processes.size === 1) process.once("exit", closeAllLinkResolvers);
  }
  return resolver;
}

export function closeAllLinkResolvers(): void {
  for (const resolver of processes.values()) resolver.close();
  processes.clear();
}
