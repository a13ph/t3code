import { describe, expect, it } from "vite-plus/test";

import { propertyMarkdown } from "./notePropertiesMarkdown";

describe("propertyMarkdown", () => {
  it("keeps wikilinks and URLs and escapes the rest", () => {
    expect(
      propertyMarkdown({
        key: "title",
        values: ["*not* [x] see https://example.com/a_b and [[some_note|n]]"],
        list: false,
      }),
    ).toBe(String.raw`\*not\* \[x\] see https://example.com/a_b and [[some_note|n]]`);
  });

  it("writes a list as a markdown list, one value per item", () => {
    expect(propertyMarkdown({ key: "related", values: ["[[a]]", "1. b"], list: true })).toBe(
      "- [[a]]\n- 1\\. b",
    );
    expect(propertyMarkdown({ key: "empty", values: [], list: true })).toBe("");
  });

  it("keeps line breaks of a block value", () => {
    expect(propertyMarkdown({ key: "note", values: ["one\ntwo"], list: false })).toBe("one  \ntwo");
  });
});
