import { spawn } from "node:child_process";

import { describe, expect, it } from "@effect/vitest";

import { asciiJson, LinkResolverProcess, normalizeResolvedLink } from "./LinkResolver.ts";

// A resolver program: answers each lookup line by its id. ASCII only, so argv encoding on any
// host cannot change it; non-ASCII text is built from code points.
const PROGRAM = String.raw`
const rl = require("node:readline").createInterface({ input: process.stdin });
const mark = String.fromCodePoint(0x25e7);
rl.on("line", (raw) => {
  const { id } = JSON.parse(raw);
  const out = (value) => process.stdout.write(Buffer.from(JSON.stringify(value) + "\n", "utf8"));
  if (id === "missing") return out(null);
  // Stops reading, as a stuck program does, and stays alive.
  if (id === "hang") return rl.close(), setInterval(() => {}, 60000);
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
  if (id.startsWith("echo:")) return out({ path: "/n/e.md", label: id.slice(5), tooltip: raw });
  out({ path: "/n/" + id + ".md", label: id, mark: mark + "x", tone: "warning", tooltip: "line1\nline2" });
});
`;

function makeResolver(options: { answerTimeoutMs?: number } = {}) {
  const logs: string[] = [];
  let clock = 0;
  const resolver = new LinkResolverProcess("notes", [process.execPath, "-e", PROGRAM], {
    ...options,
    log: (message) => logs.push(message),
    // Each start is far from the last, so a restart is never held back in tests.
    now: () => (clock += 60_000),
  });
  return { resolver, logs };
}

describe("LinkResolverProcess", () => {
  it("answers lookups in order, one program for all of them", async () => {
    const { resolver } = makeResolver();
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
      expect(second?.label).toBe("a2");
    } finally {
      resolver.close();
    }
  });

  it("writes ASCII JSON and gets non-ASCII ids back intact", async () => {
    const { resolver } = makeResolver();
    try {
      const id = `echo:${String.fromCodePoint(0x436, 0x1f600)}`;
      const answer = await resolver.resolve(id);
      expect(answer?.label).toBe(id.slice(5));
      // The line the program read had no byte outside ASCII.
      expect(answer?.tooltip).toMatch(/^[\x20-\x7e]+$/);
      expect(answer?.tooltip).not.toContain(id.slice(5));
    } finally {
      resolver.close();
    }
  });

  it("reads UTF-8 answers as UTF-8", async () => {
    const { resolver } = makeResolver();
    try {
      const answer = await resolver.resolve("utf8");
      expect(answer?.label).toBe(String.fromCodePoint(0x437, 0x430, 0x43c, 0x20, 0x2713));
    } finally {
      resolver.close();
    }
  });

  it("answers null for a line that is not UTF-8 or not JSON, and keeps going", async () => {
    const { resolver, logs } = makeResolver();
    try {
      expect(await resolver.resolve("badutf8")).toBeNull();
      expect(await resolver.resolve("garbage")).toBeNull();
      expect((await resolver.resolve("a1"))?.label).toBe("a1");
      expect(logs.filter((line) => line.includes("unreadable answer"))).toHaveLength(2);
    } finally {
      resolver.close();
    }
  });

  it("joins an answer split across chunks and reads CRLF lines", async () => {
    const { resolver } = makeResolver();
    try {
      expect((await resolver.resolve("split"))?.label).toBe("split");
      expect((await resolver.resolve("crlf"))?.label).toBe("crlf");
      expect((await resolver.resolve("a1"))?.label).toBe("a1");
    } finally {
      resolver.close();
    }
  });

  it("gives up on a silent program, answers every waiting lookup null, then restarts", async () => {
    const { resolver, logs } = makeResolver({ answerTimeoutMs: 300 });
    try {
      const [hung, queued] = await Promise.all([resolver.resolve("hang"), resolver.resolve("a1")]);
      expect(hung).toBeNull();
      // Queued behind the stuck lookup on the same program, so it is dropped with it.
      expect(queued).toBeNull();
      expect(logs.some((line) => line.includes("no answer in 300 ms"))).toBe(true);
      expect((await resolver.resolve("a2"))?.label).toBe("a2");
    } finally {
      resolver.close();
    }
  });

  it("restarts a program that exited", async () => {
    const { resolver, logs } = makeResolver();
    try {
      expect(await resolver.resolve("die")).toBeNull();
      expect(logs.some((line) => line.includes("exited (code 3)"))).toBe(true);
      expect((await resolver.resolve("a1"))?.label).toBe("a1");
    } finally {
      resolver.close();
    }
  });

  it("does not start again sooner than a second after the last start", async () => {
    let clock = 0;
    let starts = 0;
    const resolver = new LinkResolverProcess("notes", [process.execPath, "-e", PROGRAM], {
      log: () => {},
      now: () => clock,
      spawn: (command, args) => {
        starts += 1;
        return spawn(command, [...args]);
      },
    });
    try {
      expect(await resolver.resolve("die")).toBeNull();
      clock += 500;
      expect(await resolver.resolve("a1")).toBeNull();
      clock += 600;
      expect((await resolver.resolve("a1"))?.label).toBe("a1");
      expect(starts).toBe(2);
    } finally {
      resolver.close();
    }
  });

  it("answers null without starting anything for an empty argv or a missing program", async () => {
    const empty = new LinkResolverProcess("notes", [], { log: () => {} });
    expect(await empty.resolve("a1")).toBeNull();
    const logs: string[] = [];
    const missing = new LinkResolverProcess("notes", ["t3-no-such-program-for-tests"], {
      log: (message) => logs.push(message),
    });
    expect(await missing.resolve("a1")).toBeNull();
    expect(logs.length).toBeGreaterThan(0);
    missing.close();
  });

  it("answers null after close", async () => {
    const { resolver } = makeResolver();
    expect((await resolver.resolve("a1"))?.label).toBe("a1");
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
