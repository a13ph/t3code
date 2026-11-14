import { describe, expect, it } from "vite-plus/test";

import { maskMarkdownFrontmatter, readFrontmatterProperties } from "./markdownFrontmatter.ts";

describe("readFrontmatterProperties", () => {
  it("reads scalars, lists and bare wikilinks as written", () => {
    const markdown = [
      "---",
      'title: "A note #3"',
      "kind: draft",
      "related:",
      '  - "[[child one]]"',
      "  - [[child two]]",
      "- '[[child it''s]]'",
      "see: [[up there]]",
      "tags: [a, 'b, c', [[d]]]",
      "empty:",
      "# a comment",
      "plain: first",
      "  folded",
      "---",
      "# Body",
    ].join("\n");
    expect(readFrontmatterProperties(markdown)).toEqual([
      { key: "title", values: ["A note #3"], list: false },
      { key: "kind", values: ["draft"], list: false },
      {
        key: "related",
        values: ["[[child one]]", "[[child two]]", "[[child it's]]"],
        list: true,
      },
      { key: "see", values: ["[[up there]]"], list: false },
      { key: "tags", values: ["a", "b, c", "[[d]]"], list: true },
      { key: "empty", values: [], list: false },
      { key: "plain", values: ["first folded"], list: false },
    ]);
  });

  it("keeps block scalars and nested maps as text", () => {
    const markdown =
      "---\r\nnote: |\r\n  line one\r\n\r\n  line two\r\nmeta:\r\n  a: 1\r\n  b: [[x]]\r\n---\r\n";
    expect(readFrontmatterProperties(markdown)).toEqual([
      { key: "note", values: ["line one\n\nline two"], list: false },
      { key: "meta", values: ["a: 1", "b: [[x]]"], list: true },
    ]);
  });

  it("is null without leading frontmatter", () => {
    expect(readFrontmatterProperties("# A\n---\nb: 1\n---\n")).toBeNull();
    expect(readFrontmatterProperties("---\na: 1\n")).toBeNull();
    expect(readFrontmatterProperties("---\n---\n")).toEqual([]);
  });
});

describe("maskMarkdownFrontmatter", () => {
  it("blanks leading frontmatter without moving later offsets", () => {
    const markdown = "---\r\nname: skill\r\n---\r\n# Skill\n- [ ] item\n";
    const masked = maskMarkdownFrontmatter(markdown);

    expect(masked).toBe("   \r\n           \r\n   \r\n# Skill\n- [ ] item\n");
    expect(masked.indexOf("[ ]")).toBe(markdown.indexOf("[ ]"));
  });

  it("handles a byte order mark, CR line endings, and a ... closing fence", () => {
    expect(maskMarkdownFrontmatter("\uFEFF---\na: 1\n---\n# Body")).toBe("    \n    \n   \n# Body");
    expect(maskMarkdownFrontmatter("---\ra: 1\r...\r# Body")).toBe("   \r    \r   \r# Body");
    expect(maskMarkdownFrontmatter("---\n---\n# Body")).toBe("   \n   \n# Body");
  });

  it("leaves unterminated or non-leading fences alone", () => {
    expect(maskMarkdownFrontmatter("---\na: 1\n")).toBe("---\na: 1\n");
    expect(maskMarkdownFrontmatter("# A\n---\nb\n---\n")).toBe("# A\n---\nb\n---\n");
    expect(maskMarkdownFrontmatter("---\na: 1\n----\n")).toBe("---\na: 1\n----\n");
  });
});

describe("readFrontmatterProperties on long lines", () => {
  // Lazy patterns ending in `(.*?)[ \t]*$` backtrack quadratically on long blank runs.
  it("reads values beside long blank runs", () => {
    const blanks = " ".repeat(40_000);
    const markdown = `---\nk: x${blanks}y\n-${blanks}z\nm: v${blanks}\n---\n`;
    const properties = readFrontmatterProperties(markdown);
    expect(properties?.map((property) => property.key)).toEqual(["k", "m"]);
    expect(properties?.[0]?.values).toEqual([`x${blanks}y`]);
    expect(properties?.[1]?.values).toEqual(["v"]);
  });
});
