import { expect, it } from "vite-plus/test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  chatMarkdownRehypePlugins,
  unwrapResolvedLinkHref,
} from "./markdownPipeline.ts";

const hrefsAfterSanitizing = (markdown: string, plugins: typeof CHAT_MARKDOWN_REHYPE_PLUGINS) => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(plugins);
  const hrefs: unknown[] = [];
  const visit = (node: {
    tagName?: string;
    properties?: { href?: unknown };
    children?: unknown[];
  }) => {
    if (node.tagName === "a") hrefs.push(node.properties?.href);
    for (const child of node.children ?? []) visit(child as typeof node);
  };
  visit(processor.runSync(processor.parse(markdown)) as never);
  return hrefs;
};

it("keeps links of the resolved schemes a caller passes as t3-resolved links, and only those", () => {
  const markdown =
    '[a](notes://n1) <NOTES://n2> [b](wiki://w1) [c](javascript:alert(1)) <a href="notes://n3">d</a>';
  expect(hrefsAfterSanitizing(markdown, CHAT_MARKDOWN_REHYPE_PLUGINS)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  expect(hrefsAfterSanitizing(markdown, chatMarkdownRehypePlugins(["notes"]))).toEqual([
    "t3-resolved:notes://n1",
    "t3-resolved:NOTES://n2",
    undefined,
    undefined,
    "t3-resolved:notes://n3",
  ]);
  expect(unwrapResolvedLinkHref("t3-resolved:notes://n1")).toBe("notes://n1");
  expect(unwrapResolvedLinkHref("notes://n1")).toBeNull();
});

it("never lets a resolved scheme's other link forms through the sanitizer", () => {
  // A server naming an OS handler as its scheme does not make chat keep links to that handler.
  const markdown = '[a](ms-msdt:/id) [b](ms-msdt://id) <a href="ms-msdt:id">c</a>';
  expect(hrefsAfterSanitizing(markdown, chatMarkdownRehypePlugins(["ms-msdt"]))).toEqual([
    undefined,
    "t3-resolved:ms-msdt://id",
    undefined,
  ]);
});

it("returns one plugin list per set of extra protocols", () => {
  expect(chatMarkdownRehypePlugins([])).toBe(CHAT_MARKDOWN_REHYPE_PLUGINS);
  expect(chatMarkdownRehypePlugins(["Bad Name"])).toBe(CHAT_MARKDOWN_REHYPE_PLUGINS);
  expect(chatMarkdownRehypePlugins(["b", "a"])).toBe(chatMarkdownRehypePlugins(["a", "b", "a"]));
  expect(chatMarkdownRehypePlugins(["a"])).not.toBe(chatMarkdownRehypePlugins(["b"]));
});

it("preserves in-app thread links through the shared Markdown sanitizer", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const tree = processor.runSync(
    processor.parse(
      '[Open thread](t3-thread://v1/thread)\n\n<t3-thread://v2/environment/thread:a%3A1>\n\n<a href="javascript:alert(1)">Unsafe</a>',
    ),
  );
  expect(tree.children[0]).toMatchObject({
    tagName: "p",
    children: [
      {
        tagName: "a",
        properties: { href: "t3-thread://v1/thread" },
        children: [{ type: "text", value: "Open thread" }],
      },
    ],
  });
  expect(tree.children[2]).toMatchObject({
    tagName: "p",
    children: [
      {
        tagName: "a",
        properties: { href: "t3-thread://v2/environment/thread:a%3A1" },
        children: [{ type: "text", value: "t3-thread://v2/environment/thread:a%3A1" }],
      },
    ],
  });
  expect(JSON.stringify(tree)).not.toContain("javascript:");
});

it("preserves remote-file links through the shared Markdown sanitizer", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const tree = processor.runSync(
    processor.parse(
      "[x.md](<remote-file://v1/env-1/home/user/a b/x.md>)\n\n[](<remote-file://v1/env-1/C:/user/y.md>)",
    ),
  );
  expect(tree.children[0]).toMatchObject({
    tagName: "p",
    children: [
      {
        tagName: "a",
        properties: { href: "remote-file://v1/env-1/home/user/a%20b/x.md" },
        children: [{ type: "text", value: "x.md" }],
      },
    ],
  });
  expect(tree.children[2]).toMatchObject({
    tagName: "p",
    children: [{ tagName: "a", properties: { href: "remote-file://v1/env-1/C:/user/y.md" } }],
  });
});

it("keeps backslashes that CommonMark would read as escapes in prose Windows paths", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  type Node = { type: string; value?: string; tagName?: string; children?: Node[] };
  const text = (node: Node): string =>
    node.type === "text"
      ? (node.value ?? "")
      : node.tagName === "code"
        ? `<code>${(node.children ?? []).map(text).join("")}</code>`
        : (node.children ?? []).map(text).join("");
  const render = (markdown: string) => text(processor.runSync(processor.parse(markdown)) as Node);

  expect(
    render(String.raw`Saved to C:\Users\me\.t3\_build and (C:\.scratch) and C:/work\.config.`),
  ).toBe(String.raw`Saved to C:\Users\me\.t3\_build and (C:\.scratch) and C:/work\.config.`);
  expect(render(String.raw`Escaped C:\\Users\\me`)).toBe(String.raw`Escaped C:\\Users\\me`);
  expect(render(String.raw`See C:\x and \*this\* and Note:\*that\*.`)).toBe(
    String.raw`See C:\x and *this* and Note:*that*.`,
  );
  expect(render(String.raw`${"`"}C:\me\.t3${"`"} and C:\me\.t3`)).toBe(
    String.raw`<code>C:\me\.t3</code> and C:\me\.t3`,
  );
});

it("keeps an image on its own line under a label but leaves inline images inline", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  type Node = { type: string; value?: string; tagName?: string; children?: Node[] };
  const shape = (node: Node): string =>
    node.type === "text"
      ? (node.value ?? "")
      : node.tagName === "br" || node.tagName === "img"
        ? `<${node.tagName}>`
        : (node.children ?? []).map(shape).join("");
  const render = (markdown: string) => shape(processor.runSync(processor.parse(markdown)) as Node);

  expect(
    render("**Palette**\n![Palette](/tmp/palette.png)\n**Hero** (dark)\n![Hero](/tmp/hero.png)"),
  ).toBe("Palette<br>\n<img><br>\nHero (dark)<br>\n<img>");
  expect(render("Built [![CI](/ci.svg)](/ci)\nand wrapped")).toBe("Built <img>\nand wrapped");
  expect(render("Hard-wrapped\nprose")).toBe("Hard-wrapped\nprose");
});
