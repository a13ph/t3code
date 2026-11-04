import { describe, expect, it } from "vite-plus/test";

import {
  linkSchemesOf,
  parseResolvedLinkHref,
  resolvedLinkHref,
  resolvedLinkPlaceholder,
  resolvedLinkTooltipLines,
} from "./resolvedLinks";

const SCHEMES = new Set(["notes"]);
const UUID = "3f2b9c1e-7d4a-4e6b-9a8c-2d5f1b0e7c43";

describe("parseResolvedLinkHref", () => {
  it("reads a link of an announced scheme, bare or in angle brackets", () => {
    for (const href of [
      `notes://${UUID}`,
      `<notes://${UUID}>`,
      `NOTES://${UUID}/`,
      `  notes://${UUID}  `,
    ]) {
      expect(parseResolvedLinkHref(href, SCHEMES)).toEqual({ scheme: "notes", id: UUID });
    }
  });

  it("keeps the id as written, and reads a percent-encoded one as the same id", () => {
    expect(parseResolvedLinkHref("notes://Some.Id-1", SCHEMES)?.id).toBe("Some.Id-1");
    const word = String.fromCodePoint(0x436, 0x443, 0x43a);
    expect(parseResolvedLinkHref(`notes://${encodeURIComponent(word)}`, SCHEMES)?.id).toBe(word);
    expect(parseResolvedLinkHref(`notes://${word}`, SCHEMES)?.id).toBe(word);
    expect(parseResolvedLinkHref("notes://50%", SCHEMES)?.id).toBe("50%");
  });

  it("refuses schemes no server announced, and links that are not links", () => {
    expect(parseResolvedLinkHref(`other://${UUID}`, SCHEMES)).toBeNull();
    expect(parseResolvedLinkHref(`notes://${UUID}`, new Set())).toBeNull();
    for (const href of [
      "notes://",
      "notes:///x",
      "notes:x",
      "notes://a b",
      "notes://%20",
      "",
      null,
      undefined,
    ]) {
      expect(parseResolvedLinkHref(href, SCHEMES)).toBeNull();
    }
  });

  it("reads the t3-resolved form the chat sanitizer hands on", () => {
    expect(parseResolvedLinkHref(`t3-resolved:notes://${UUID}`, SCHEMES)).toEqual({
      scheme: "notes",
      id: UUID,
    });
    expect(parseResolvedLinkHref(`t3-resolved:other://${UUID}`, SCHEMES)).toBeNull();
  });

  it("refuses ids that would climb out of a path or carry control characters", () => {
    for (const href of [
      "notes://..%2F..%2Fsecret",
      "notes://a%2F..%2Fb",
      "notes://..",
      "notes://a%5Cb",
      "notes://a%0Ab",
    ]) {
      expect(parseResolvedLinkHref(href, SCHEMES)).toBeNull();
    }
    expect(parseResolvedLinkHref("notes://a%2Fb", SCHEMES)?.id).toBe("a/b");
  });
});

describe("resolvedLinkHref and resolvedLinkPlaceholder", () => {
  it("write the link back and a short stand-in", () => {
    const link = { scheme: "notes", id: UUID };
    expect(resolvedLinkHref(link)).toBe(`notes://${UUID}`);
    expect(resolvedLinkPlaceholder(link)).toBe("notes:3f2b9c1e");
  });
});

describe("resolvedLinkTooltipLines", () => {
  it("shows the program's lines, then the server", () => {
    expect(
      resolvedLinkTooltipLines(
        { tooltip: "Title\r\n\no in-progress\nnotes/t.md\n", path: "/n/t.md" },
        "Title",
        "graph-host",
      ),
    ).toEqual(["Title", "o in-progress", "notes/t.md", "on graph-host"]);
  });

  it("falls back to the label and the path when the program gave no tooltip", () => {
    expect(resolvedLinkTooltipLines({ tooltip: " \n", path: "/n/t.md" }, "T", "h")).toEqual([
      "T",
      "/n/t.md",
      "on h",
    ]);
  });
});

describe("linkSchemesOf", () => {
  it("joins every server's schemes, lower case and sorted", () => {
    expect(
      linkSchemesOf([
        { linkSchemes: ["notes", " Wiki "] },
        undefined,
        {},
        { linkSchemes: ["notes", "a.b+c-d"] },
      ]),
    ).toEqual(["a.b+c-d", "notes", "wiki"]);
  });

  it("drops unsafe, web and built-in schemes and malformed names", () => {
    expect(
      linkSchemesOf([
        {
          linkSchemes: [
            "javascript",
            "data",
            "https",
            "file",
            "t3-thread",
            "remote-file",
            "1abc",
            "a b",
            "",
          ],
        },
      ]),
    ).toEqual([]);
  });
});
