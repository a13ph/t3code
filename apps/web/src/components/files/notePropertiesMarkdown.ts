import type { FrontmatterProperty } from "@t3tools/shared/markdownFrontmatter";
import { findWikilinks } from "@t3tools/shared/wikilinks";

// A web address, left as written so the renderer links it.
const URL_PATTERN = /https?:\/\/[^\s<>]+/g;

/** A property's values as markdown: a list for a list, its wikilinks and URLs kept as written. */
export function propertyMarkdown(property: FrontmatterProperty): string {
  const values = property.values.map(valueMarkdown);
  return property.list ? values.map((value) => `- ${value}`).join("\n") : (values[0] ?? "");
}

function valueMarkdown(value: string): string {
  const kept: Array<readonly [number, number]> = [
    ...findWikilinks(value).map((match) => [match.start, match.end] as const),
    ...[...value.matchAll(URL_PATTERN)].map(
      (match) => [match.index, match.index + match[0].length] as const,
    ),
  ].sort((left, right) => left[0] - right[0]);
  let text = "";
  let at = 0;
  for (const [start, end] of kept) {
    if (start < at) continue;
    text += escapeMarkdown(value.slice(at, start)) + value.slice(start, end);
    at = end;
  }
  return (text + escapeMarkdown(value.slice(at))).replace(/\n/g, "  \n");
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~&]/g, "\\$&");
}
