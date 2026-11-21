// @effect-diagnostics nodeBuiltinImport:off -- runs real resolver programs as child processes.
import * as NodeChildProcess from "node:child_process";

import type { LinkResolveResult } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  asciiJson,
  LINK_RESOLVER_UNAVAILABLE,
  LinkResolverProcess,
  linkResolverEnv,
  normalizeResolvedLink,
  resolveLink,
  startLinkResolvers,
} from "./LinkResolver.ts";

// A resolver program: says it is ready as its start mode (last argv) says, then answers each
// lookup line by its id. ASCII only, so argv encoding on any host cannot change it; non-ASCII
// text is built from code points.
const PROGRAM = String.raw`
const mode = process.argv.at(-1);
const out = (value) => process.stdout.write(Buffer.from(JSON.stringify(value) + "\n", "utf8"));
if (mode === "ready") out({ ready: true });
if (mode.startsWith("late:")) setTimeout(() => out({ ready: true }), Number(mode.slice(5)));
if (mode === "other") out({ path: "/n/early.md", label: "early" });
if (mode === "exit") process.exit(4);
if (mode.startsWith("silent:")) setTimeout(() => process.exit(5), Number(mode.slice(7)));
const rl = require("node:readline").createInterface({ input: process.stdin });
const mark = String.fromCodePoint(0x25e7);
let seen = 0;
let hung = false;
rl.on("line", (raw) => {
  seen += 1;
  const { id } = JSON.parse(raw);
  if (id === "missing") return out(null);
  // Stops answering, as a stuck program does, and stays alive.
  if (hung) return;
  if (id === "hang") return (hung = true), setInterval(() => {}, 60000);
  if (id === "die") process.exit(3);
  if (id === "badutf8") return process.stdout.write(Buffer.from([0xff, 0xfe, 0x0a]));
  if (id === "garbage") return process.stdout.write("not json\n");
  if (id === "crlf") return process.stdout.write(JSON.stringify({ path: "/n/crlf.md", label: "crlf" }) + "\r\n");
  if (id === "utf8") return out({ path: "/n/u.md", label: String.fromCodePoint(0x437, 0x430, 0x43c, 0x20, 0x2713) });
  if (id === "split") {
    const line = JSON.stringify({ path: "/n/split.md", label: "split" }) + "\n";
    process.stdout.write(line.slice(0, 5));
    return setTimeout(() => process.stdout.write(line.slice(5)), 50);
  }
  if (id.startsWith("count")) return out({ path: "/n/c.md", label: String(seen) });
  if (id.startsWith("slow")) return setTimeout(() => out({ path: "/n/s.md", label: id }), 200);
  if (id.startsWith("echo:")) return out({ path: "/n/e.md", label: id.slice(5), tooltip: raw });
  out({ path: "/n/" + id + ".md", label: id, mark: mark + "x", tone: "warning", tooltip: "line1\nline2" });
});
`;

interface MakeOptions {
  readonly answerTimeoutMs?: number;
  readonly answerCacheMs?: number;
  readonly maxPending?: number;
  /** Start modes of the program, one per start in order; "ready" after the list runs out. */
  readonly modes?: ReadonlyArray<string>;
  readonly now?: () => number;
}

/** A started program: settles on its first stdout chunk or its exit, and on its exit. */
interface Started {
  readonly spoke: Promise<void>;
  readonly exited: Promise<void>;
}

const startsOf = new WeakMap<LinkResolverProcess, Started[]>();

function makeResolver({ modes = [], now, ...options }: MakeOptions = {}) {
  const logs: string[] = [];
  const starts: Started[] = [];
  let clock = 0;
  const resolver = new LinkResolverProcess("notes", [process.execPath, "-e", PROGRAM], {
    ...options,
    log: (message) => logs.push(message),
    // Each start is far from the last, so a restart is never held back in tests.
    now: now ?? (() => (clock += 60_000)),
    spawn: (command, args) => {
      const child = NodeChildProcess.spawn(command, [...args, modes[starts.length] ?? "ready"]);
      // Attached before the resolver's own listeners, which run in the same emit, so an awaiter
      // of these sees the resolver's state after it read the line or saw the exit.
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const spoke = new Promise<void>((resolve) => {
        child.stdout.once("data", () => resolve());
        void exited.then(resolve);
      });
      starts.push({ spoke, exited });
      return child;
    },
  });
  startsOf.set(resolver, starts);
  return { resolver, logs, starts };
}

/** The label of an answer, or the answer itself when it is null or unavailable. */
function labelOf(answer: LinkResolveResult) {
  return answer !== null && "label" in answer ? answer.label : answer;
}

/** Asks for `id`, and once more after the program's ready line if it was not ready yet. */
async function resolveWhenReady(resolver: LinkResolverProcess, id: string) {
  const answer = await resolver.resolve(id);
  if (answer === null || !("unavailable" in answer)) return answer;
  await startsOf.get(resolver)?.at(-1)?.spoke;
  return resolver.resolve(id);
}

/** A resolver whose program has started and said it is ready. */
async function readyResolver(options: MakeOptions = {}) {
  const made = makeResolver(options);
  expect(labelOf(await resolveWhenReady(made.resolver, "warmup"))).toBe("warmup");
  return made;
}

describe("LinkResolverProcess", () => {
  it("starts on start(), so the first lookup after ready is answered, not unavailable", async () => {
    const { resolver, starts } = makeResolver();
    try {
      resolver.start();
      expect(starts).toHaveLength(1);
      await starts[0]?.spoke;
      expect(labelOf(await resolver.resolve("a1"))).toBe("a1");
      resolver.start();
      expect(starts).toHaveLength(1);
    } finally {
      resolver.close();
    }
  });

  it("answers lookups in order, one program for all of them", async () => {
    const { resolver } = await readyResolver();
    try {
      const [first, missing, second] = await Promise.all([
        resolver.resolve("a1"),
        resolver.resolve("missing"),
        resolver.resolve("a2"),
      ]);
      expect(first).toEqual({
        path: "/n/a1.md",
        label: "a1",
        mark: String.fromCodePoint(0x25e7),
        tone: "warning",
        tooltip: "line1\nline2",
      });
      expect(missing).toBeNull();
      expect(labelOf(second)).toBe("a2");
    } finally {
      resolver.close();
    }
  });

  it("writes ASCII JSON and gets non-ASCII ids back intact", async () => {
    const { resolver } = await readyResolver();
    try {
      const id = `echo:${String.fromCodePoint(0x436, 0x1f600)}`;
      const answer = await resolver.resolve(id);
      expect(labelOf(answer)).toBe(id.slice(5));
      // The line the program read had no byte outside ASCII.
      expect(answer !== null && "tooltip" in answer ? answer.tooltip : "").toMatch(
        /^[\x20-\x7e]+$/,
      );
      expect(answer !== null && "tooltip" in answer ? answer.tooltip : "").not.toContain(
        id.slice(5),
      );
    } finally {
      resolver.close();
    }
  });

  it("reads UTF-8 answers as UTF-8", async () => {
    const { resolver } = await readyResolver();
    try {
      const answer = await resolver.resolve("utf8");
      expect(labelOf(answer)).toBe(String.fromCodePoint(0x437, 0x430, 0x43c, 0x20, 0x2713));
    } finally {
      resolver.close();
    }
  });

  it("answers unavailable for a line that is not UTF-8 or not JSON, and keeps going", async () => {
    const { resolver, logs } = await readyResolver();
    try {
      expect(await resolver.resolve("badutf8")).toEqual(LINK_RESOLVER_UNAVAILABLE);
      expect(await resolver.resolve("garbage")).toEqual(LINK_RESOLVER_UNAVAILABLE);
      expect(labelOf(await resolver.resolve("a1"))).toBe("a1");
      expect(logs.filter((line) => line.includes("unreadable answer"))).toHaveLength(2);
    } finally {
      resolver.close();
    }
  });

  it("joins an answer split across chunks and reads CRLF lines", async () => {
    const { resolver } = await readyResolver();
    try {
      expect(labelOf(await resolver.resolve("split"))).toBe("split");
      expect(labelOf(await resolver.resolve("crlf"))).toBe("crlf");
      expect(labelOf(await resolver.resolve("a1"))).toBe("a1");
    } finally {
      resolver.close();
    }
  });

  it("gives up on a silent program, answers every waiting lookup unavailable, then restarts", async () => {
    const { resolver, logs } = await readyResolver({ answerTimeoutMs: 300 });
    try {
      const [hung, queued] = await Promise.all([resolver.resolve("hang"), resolver.resolve("a1")]);
      expect(hung).toEqual(LINK_RESOLVER_UNAVAILABLE);
      // Queued behind the stuck lookup on the same program, so it is dropped with it.
      expect(queued).toEqual(LINK_RESOLVER_UNAVAILABLE);
      expect(logs.some((line) => line.includes("no answer in 300 ms"))).toBe(true);
      expect(labelOf(await resolveWhenReady(resolver, "a2"))).toBe("a2");
    } finally {
      resolver.close();
    }
  });

  it("restarts a program that exited", async () => {
    const { resolver, logs } = await readyResolver();
    try {
      expect(await resolver.resolve("die")).toEqual(LINK_RESOLVER_UNAVAILABLE);
      expect(logs.some((line) => line.includes("exited (code 3)"))).toBe(true);
      expect(labelOf(await resolveWhenReady(resolver, "a1"))).toBe("a1");
    } finally {
      resolver.close();
    }
  });

  it("waits longer before each restart while the program dies before it is ready", async () => {
    let clock = 0;
    const { resolver, starts } = makeResolver({ modes: ["exit", "exit"], now: () => clock });
    try {
      expect(await resolver.resolve("a1")).toEqual(LINK_RESOLVER_UNAVAILABLE);
      await starts[0]?.exited;
      clock += 500;
      expect(await resolver.resolve("a1")).toEqual(LINK_RESOLVER_UNAVAILABLE);
      expect(starts).toHaveLength(1);
      clock += 600;
      // Second start, a second after the first; it dies too, so the next waits two seconds.
      expect(await resolver.resolve("a1")).toEqual(LINK_RESOLVER_UNAVAILABLE);
      expect(starts).toHaveLength(2);
      await starts[1]?.exited;
      clock += 1_500;
      expect(await resolver.resolve("a1")).toEqual(LINK_RESOLVER_UNAVAILABLE);
      expect(starts).toHaveLength(2);
      clock += 600;
      expect(labelOf(await resolveWhenReady(resolver, "a1"))).toBe("a1");
      expect(starts).toHaveLength(3);
      // That run answered, so a death now is followed by the one-second pause again.
      expect(await resolver.resolve("die")).toEqual(LINK_RESOLVER_UNAVAILABLE);
      clock += 1_100;
      expect(labelOf(await resolveWhenReady(resolver, "a2"))).toBe("a2");
      expect(starts).toHaveLength(4);
    } finally {
      resolver.close();
    }
  });

  it("sends nothing and answers unavailable at once until the program is ready, untimed", async () => {
    // Ready only after 3 answer timeouts: a lookup sent or timed before that would stop it.
    const { resolver, logs, starts } = makeResolver({ modes: ["late:300"], answerTimeoutMs: 100 });
    try {
      expect(await resolver.resolve("count1")).toEqual(LINK_RESOLVER_UNAVAILABLE);
      expect(await resolver.resolve("count2")).toEqual(LINK_RESOLVER_UNAVAILABLE);
      await starts[0]?.spoke;
      // `count` answers with how many lookups the program has read: this is its first.
      expect(labelOf(await resolver.resolve("count3"))).toBe("1");
      expect(starts).toHaveLength(1);
      expect(logs).toEqual([]);
    } finally {
      resolver.close();
    }
  });

  it("never times a program that has not said it is ready, until it exits", async () => {
    const { resolver, logs, starts } = makeResolver({
      modes: ["silent:300"],
      answerTimeoutMs: 100,
    });
    try {
      expect(await resolver.resolve("a1")).toEqual(LINK_RESOLVER_UNAVAILABLE);
      expect(await resolver.resolve("a2")).toEqual(LINK_RESOLVER_UNAVAILABLE);
      await starts[0]?.exited;
      // It ran its 300 ms and exited itself; the server never stopped it.
      expect(logs).toEqual(["link resolver notes: exited (code 5)"]);
      expect(starts).toHaveLength(1);
    } finally {
      resolver.close();
    }
  });

  it("stops a program whose first line is not the ready line, as a failed run", async () => {
    let clock = 0;
    const { resolver, logs, starts } = makeResolver({
      modes: ["other", "other"],
      now: () => clock,
    });
    try {
      expect(await resolver.resolve("a1")).toEqual(LINK_RESOLVER_UNAVAILABLE);
      await starts[0]?.spoke;
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('first line is not {"ready": true}');
      expect(logs[0]).toContain("/n/early.md");
      clock += 1_100;
      expect(await resolver.resolve("a1")).toEqual(LINK_RESOLVER_UNAVAILABLE);
      expect(starts).toHaveLength(2);
      await starts[1]?.spoke;
      // Two failed runs in a row, so the next start waits two seconds.
      clock += 1_100;
      expect(await resolver.resolve("a1")).toEqual(LINK_RESOLVER_UNAVAILABLE);
      expect(starts).toHaveLength(2);
      clock += 1_000;
      expect(labelOf(await resolveWhenReady(resolver, "a1"))).toBe("a1");
      expect(starts).toHaveLength(3);
    } finally {
      resolver.close();
    }
  });

  it("answers unavailable for an empty argv, starting nothing, and for a missing program", async () => {
    let starts = 0;
    const empty = new LinkResolverProcess("notes", [], {
      log: () => {},
      spawn: (command, args) => {
        starts += 1;
        return NodeChildProcess.spawn(command, [...args]);
      },
    });
    expect(await empty.resolve("a1")).toEqual(LINK_RESOLVER_UNAVAILABLE);
    expect(starts).toBe(0);
    let logged: (message: string) => void = () => {};
    const firstLog = new Promise<string>((resolve) => (logged = resolve));
    const missing = new LinkResolverProcess("notes", ["t3-no-such-program-for-tests"], {
      log: (message) => logged(message),
    });
    expect(await missing.resolve("a1")).toEqual(LINK_RESOLVER_UNAVAILABLE);
    expect(await firstLog).toContain("t3-no-such-program-for-tests");
    missing.close();
  });

  it("keeps an answer for a few seconds and asks once for an id asked twice at once", async () => {
    let clock = 0;
    const { resolver } = await readyResolver({ now: () => clock, answerCacheMs: 5_000 });
    const label = async (id: string) => labelOf(await resolver.resolve(id));
    try {
      // `count` answers with how many lookups the program has read, the warm-up one included.
      expect(await Promise.all([label("count"), label("count")])).toEqual(["2", "2"]);
      clock += 4_000;
      expect(await label("count")).toBe("2");
      clock += 1_000;
      expect(await label("count")).toBe("3");
    } finally {
      resolver.close();
    }
  });

  it("answers unavailable past the queue cap instead of queueing more", async () => {
    const { resolver: capped } = await readyResolver({ maxPending: 2 });
    try {
      const answers = await Promise.all([
        capped.resolve("slow1"),
        capped.resolve("slow2"),
        capped.resolve("slow3"),
      ]);
      expect(answers.map(labelOf)).toEqual(["slow1", "slow2", LINK_RESOLVER_UNAVAILABLE]);
    } finally {
      capped.close();
    }
  });

  it("answers null after close", async () => {
    const { resolver } = await readyResolver();
    expect(labelOf(await resolver.resolve("a1"))).toBe("a1");
    resolver.close();
    expect(await resolver.resolve("a2")).toBeNull();
  });
});

describe("normalizeResolvedLink", () => {
  it("keeps a full answer", () => {
    expect(
      normalizeResolvedLink({ path: "C:\\notes\\x.md", label: " X ", mark: "ab", tone: "danger" }),
    ).toEqual({ path: "C:\\notes\\x.md", label: "X", mark: "a", tone: "danger", tooltip: "" });
  });

  it("takes one grapheme as the mark, and normal for an unknown tone", () => {
    const flag = String.fromCodePoint(0x1f1fa, 0x1f1e6);
    const answer = normalizeResolvedLink({ path: "/x", mark: `${flag}z`, tone: "purple" });
    expect(answer?.mark).toBe(flag);
    expect(answer?.tone).toBe("normal");
  });

  it("refuses what is not an answer", () => {
    expect(normalizeResolvedLink(null)).toBeNull();
    expect(normalizeResolvedLink([])).toBeNull();
    expect(normalizeResolvedLink("x")).toBeNull();
    expect(normalizeResolvedLink({ label: "no path" })).toBeNull();
    expect(normalizeResolvedLink({ path: "notes/relative.md" })).toBeNull();
    expect(normalizeResolvedLink({ path: "   " })).toBeNull();
    expect(normalizeResolvedLink({ path: "C:relative.md" })).toBeNull();
  });

  it("refuses network and device paths, which would make the server connect out", () => {
    for (const path of [
      "\\\\203.0.113.5\\share\\a.md",
      "//203.0.113.5/share/a.md",
      "\\\\?\\C:\\notes\\a.md",
      "\\\\.\\pipe\\x",
      "/\\host\\share",
    ]) {
      expect(normalizeResolvedLink({ path })).toBeNull();
    }
    expect(normalizeResolvedLink({ path: "/home/u/a.md" })?.path).toBe("/home/u/a.md");
    expect(normalizeResolvedLink({ path: "c:/notes/a.md" })?.path).toBe("c:/notes/a.md");
  });
});

describe("linkResolverEnv", () => {
  it("drops the server's own settings and keeps the rest", () => {
    expect(
      linkResolverEnv({ PATH: "/bin", T3CODE_AUTH_TOKEN: "x", t3code_home: "y", HOME: "/h" }),
    ).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("resolveLink", () => {
  it("answers null for a scheme with no program, starting nothing", async () => {
    const asked: string[] = [];
    const resolverFor = ((scheme: string) => {
      asked.push(scheme);
      return { resolve: async () => null };
    }) as unknown as Parameters<typeof resolveLink>[2];
    const resolvers = { notes: ["prog"] };
    expect(await resolveLink(undefined, { scheme: "notes", id: "a" }, resolverFor)).toBeNull();
    expect(await resolveLink(resolvers, { scheme: "wiki", id: "a" }, resolverFor)).toBeNull();
    expect(
      await resolveLink(resolvers, { scheme: "constructor", id: "a" }, resolverFor),
    ).toBeNull();
    expect(asked).toEqual([]);
    expect(await resolveLink(resolvers, { scheme: "notes", id: "a" }, resolverFor)).toBeNull();
    expect(asked).toEqual(["notes"]);
  });
});

describe("startLinkResolvers", () => {
  it("starts each configured scheme's program, and nothing when unset", () => {
    const started: string[] = [];
    const resolverFor = ((scheme: string, argv: ReadonlyArray<string>) => ({
      start: () => started.push(`${scheme}:${argv.join(" ")}`),
    })) as unknown as Parameters<typeof startLinkResolvers>[1];
    startLinkResolvers(undefined, resolverFor);
    expect(started).toEqual([]);
    startLinkResolvers({ notes: ["prog", "a"], wiki: ["w"] }, resolverFor);
    expect(started).toEqual(["notes:prog a", "wiki:w"]);
  });
});

describe("asciiJson", () => {
  it("escapes every non-ASCII code unit and stays valid JSON", () => {
    const value = { id: `a${String.fromCodePoint(0x436, 0x1f600, 0x7f)}` };
    const text = asciiJson(value);
    expect(text).toMatch(/^[\x20-\x7e]+$/);
    expect(JSON.parse(text)).toEqual(value);
  });
});
