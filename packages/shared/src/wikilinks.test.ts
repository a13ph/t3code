import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import {
  findMarkdownWikilinks,
  findWikilinks,
  parseWikilinkInner,
  remarkWikilinks,
  wikilinkFilePath,
  wikilinkHref,
  wikilinkLabel,
} from "./wikilinks.ts";

describe("parseWikilinkInner", () => {
  it("splits target, heading and alias", () => {
    expect(parseWikilinkInner("Some note")).toEqual({
      target: "Some note",
      heading: null,
      alias: null,
      embed: false,
    });
    expect(parseWikilinkInner(" a/b note #Part two | shown ")).toEqual({
      target: "a/b note",
      heading: "Part two",
      alias: "shown",
      embed: false,
    });
    expect(parseWikilinkInner("note\\|cell", true)).toEqual({
      target: "note",
      heading: null,
      alias: "cell",
      embed: true,
    });
  });

  it("names nothing without a target", () => {
    expect(parseWikilinkInner("#only heading")).toBeNull();
    expect(parseWikilinkInner("  ")).toBeNull();
    expect(parseWikilinkInner("x".repeat(1_001))).toBeNull();
  });
});

describe("findWikilinks", () => {
  it("finds each link with its offsets", () => {
    const text = "see [[a]] and ![[b.png|pic]], not [[]] or [[c\nd]]";
    const found = findWikilinks(text);
    expect(found.map((match) => text.slice(match.start, match.end))).toEqual([
      "[[a]]",
      "![[b.png|pic]]",
    ]);
    expect(found[1]?.link.embed).toBe(true);
  });
});

describe("findMarkdownWikilinks", () => {
  it("skips fenced blocks and code spans", () => {
    const markdown = [
      "[[one]] `[[two]]` ``a ` [[three]]`` [[four]]",
      "```md",
      "[[five]]",
      "```",
      "~~~",
      "[[six]]",
      "```",
      "~~~",
      "[[seven]]",
    ].join("\n");
    const found = findMarkdownWikilinks(markdown);
    expect(found.map((match) => match.link.target)).toEqual(["one", "four", "seven"]);
    expect(found.map((match) => markdown.slice(match.start, match.end))).toEqual([
      "[[one]]",
      "[[four]]",
      "[[seven]]",
    ]);
  });

  it("reads an unclosed backtick as text", () => {
    expect(findMarkdownWikilinks("a ` [[b]]").map((match) => match.link.target)).toEqual(["b"]);
  });
});

describe("wikilink files and labels", () => {
  it("adds .md unless the target names a file kind", () => {
    expect(wikilinkFilePath("v1.5 plan")).toBe("v1.5 plan.md");
    expect(wikilinkFilePath("release-0.1.5")).toBe("release-0.1.5.md");
    expect(wikilinkFilePath("pic.PNG")).toBe("pic.PNG");
    expect(wikilinkFilePath("note.md")).toBe("note.md");
  });

  it("encodes each path segment", () => {
    expect(wikilinkHref(parseWikilinkInner("dir/a b?#c")!)).toBe("./dir/a%20b%3F.md");
    expect(wikilinkHref(parseWikilinkInner("../up")!)).toBe("../up.md");
    // A leading slash names no root and no host: `//evil.example/x` stays below the note.
    expect(wikilinkHref(parseWikilinkInner("//evil.example/x")!)).toBe("./evil.example/x.md");
    expect(wikilinkHref(parseWikilinkInner("/top")!)).toBe("./top.md");
  });

  it("shows the alias, else the target and heading", () => {
    expect(wikilinkLabel(parseWikilinkInner("a#b|c")!)).toBe("c");
    expect(wikilinkLabel(parseWikilinkInner("a#b")!)).toBe("a > b");
    expect(wikilinkLabel(parseWikilinkInner("a")!)).toBe("a");
  });
});

describe("remarkWikilinks", () => {
  function parse(markdown: string): Root {
    const processor = unified().use(remarkParse).use(remarkGfm).use(remarkWikilinks);
    return processor.runSync(processor.parse(markdown)) as Root;
  }

  it("turns wikilinks in text into relative links and leaves code alone", () => {
    const tree = parse("A [[b c|see]] and `[[d]]`\n\n```\n[[e]]\n```\n\n- [[f#h]]\n");
    const json = JSON.stringify(tree);
    const links: Array<{ url: string; data: unknown; children: unknown }> = [];
    const visit = (node: { type: string; children?: unknown[] }) => {
      if (node.type === "link") links.push(node as never);
      for (const child of node.children ?? []) visit(child as never);
    };
    visit(tree as never);
    expect(links.map((link) => link.url)).toEqual(["./b%20c.md", "./f.md"]);
    expect(links[0]?.data).toEqual({
      hProperties: { dataWikilink: "b c", dataWikilinkAlias: "" },
    });
    expect(links[1]?.children).toEqual([{ type: "text", value: "f > h" }]);
    expect(json).toContain('"value":"[[d]]"');
    expect(json).toContain('"value":"[[e]]"');
  });

  it("leaves a markdown link's own text alone", () => {
    const tree = parse("[x [[y]]](z.md)");
    expect(JSON.stringify(tree)).toContain('"value":"x [[y]]"');
  });
});
