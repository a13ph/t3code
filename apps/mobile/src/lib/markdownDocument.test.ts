import { describe, expect, it } from "vite-plus/test";

import { markdownWithEmptyLinkLabels } from "./markdownDocument";

const labelFor = (url: string) => (url.endsWith(".md") ? `<${url.split("/").pop()}>` : null);

describe("markdownWithEmptyLinkLabels", () => {
  it("fills a file link written with no text, escaping the label", () => {
    expect(markdownWithEmptyLinkLabels("See [](</home/user/a b.md>) now.", labelFor)).toBe(
      "See [\\<a b.md\\>](</home/user/a b.md>) now.",
    );
    expect(markdownWithEmptyLinkLabels("- [](/home/user/x.md)", labelFor)).toBe(
      "- [\\<x.md\\>](/home/user/x.md)",
    );
  });

  it("leaves labelled links, other links, images and code as written", () => {
    for (const markdown of [
      "[title](</home/user/x.md>)",
      "[](https://example.com)",
      "![](</home/user/x.md>)",
      "`[](</home/user/x.md>)`",
      "```\n[](</home/user/x.md>)\n```",
    ]) {
      expect(markdownWithEmptyLinkLabels(markdown, labelFor), markdown).toBe(markdown);
    }
  });

  it("fills every empty link in one message", () => {
    expect(markdownWithEmptyLinkLabels("[](/a.md) and [](</b c.md>)", labelFor)).toBe(
      "[\\<a.md\\>](/a.md) and [\\<b c.md\\>](</b c.md>)",
    );
  });
});
