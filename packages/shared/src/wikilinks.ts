import type { Link, PhrasingContent, Root, Text } from "mdast";

/**
 * Wikilinks, as note apps write them: `[[target]]`, `[[target#heading]]`, `[[target|shown]]`,
 * `[[target#heading|shown]]`, and the embed form `![[target]]`. The target names a note by its
 * file name without `.md`, or a file by its full name, relative to the note's own folder.
 */
export interface Wikilink {
  /** The target as written, trimmed; never empty. */
  readonly target: string;
  /** The text after `#`, trimmed, or null. */
  readonly heading: string | null;
  /** The text after `|`, trimmed, or null. */
  readonly alias: string | null;
  /** Written as `![[...]]`. */
  readonly embed: boolean;
}

export interface WikilinkMatch {
  /** Offset of the first `[` (or the `!` of an embed) in the scanned text. */
  readonly start: number;
  /** Offset just past the closing `]]`. */
  readonly end: number;
  readonly link: Wikilink;
}

// No brackets or line breaks inside, so `[[a]] and [[b]]` is two links and a stray `[[` never
// swallows the rest of a paragraph.
const WIKILINK = /(!?)\[\[([^[\]\r\n]+)\]\]/g;
// Longer than any title a note app makes, so a run of text in brackets is not taken for one.
const MAX_INNER_LENGTH = 1_000;

/** The parts of what sits between `[[` and `]]`, or null when it names nothing. */
export function parseWikilinkInner(inner: string, embed = false): Wikilink | null {
  if (inner.length > MAX_INNER_LENGTH) return null;
  // A table cell escapes the pipe as `\|`; it still splits the alias off.
  const pipe = inner.search(/\\?\|/);
  const head = pipe === -1 ? inner : inner.slice(0, pipe);
  const aliasText = pipe === -1 ? null : inner.slice(pipe + (inner[pipe] === "\\" ? 2 : 1)).trim();
  const hash = head.indexOf("#");
  const target = (hash === -1 ? head : head.slice(0, hash)).trim();
  const heading = hash === -1 ? null : head.slice(hash + 1).trim() || null;
  if (target === "") return null;
  return { target, heading, alias: aliasText || null, embed };
}

/** Every wikilink in plain text, in order. Markdown syntax around it is not looked at. */
export function findWikilinks(text: string): ReadonlyArray<WikilinkMatch> {
  const matches: WikilinkMatch[] = [];
  if (!text.includes("[[")) return matches;
  for (const match of text.matchAll(WIKILINK)) {
    const link = parseWikilinkInner(match[2]!, match[1] === "!");
    if (link === null) continue;
    matches.push({ start: match.index, end: match.index + match[0].length, link });
  }
  return matches;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Every wikilink in a markdown source outside fenced code blocks and inline code spans; indented
 * code blocks are not told apart. Offsets are into `markdown`, for string pre-passes that rewrite
 * links before a renderer that cannot run remark plugins.
 */
export function findMarkdownWikilinks(markdown: string): ReadonlyArray<WikilinkMatch> {
  const matches: WikilinkMatch[] = [];
  if (!markdown.includes("[[")) return matches;
  let fence: string | null = null;
  let offset = 0;
  for (const line of markdown.split(/(?<=\n)/)) {
    const lineStart = offset;
    offset += line.length;
    const open = FENCE_OPEN.exec(line);
    if (fence !== null) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/.exec(line)?.[1];
      if (closing !== undefined && closing[0] === fence[0] && closing.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (open) {
      // A backtick fence's info string holds no backtick; otherwise it is an inline span.
      if (open[1]![0] !== "`" || !line.slice(open[0].length).includes("`")) {
        fence = open[1]!;
        continue;
      }
    }
    for (const { start, end, link } of findWikilinksOutsideCodeSpans(line)) {
      matches.push({ start: lineStart + start, end: lineStart + end, link });
    }
  }
  return matches;
}

// Code spans within one line: a run of N backticks closes at the next run of exactly N.
function findWikilinksOutsideCodeSpans(line: string): ReadonlyArray<WikilinkMatch> {
  if (!line.includes("`")) return findWikilinks(line);
  const spans: Array<readonly [number, number]> = [];
  const runs = [...line.matchAll(/`+/g)];
  for (let i = 0; i < runs.length; i += 1) {
    const open = runs[i]!;
    const close = runs.slice(i + 1).find((run) => run[0].length === open[0].length);
    if (close === undefined) continue;
    spans.push([open.index, close.index + close[0].length]);
    i = runs.indexOf(close);
  }
  return findWikilinks(line).filter(
    (match) => !spans.some(([from, to]) => match.start < to && match.end > from),
  );
}

// File kinds a note links by full name; anything else is a note, so `v1.5 plan` means
// `v1.5 plan.md`.
const FILE_EXTENSION =
  /\.(?:md|markdown|txt|pdf|png|jpe?g|gif|webp|svg|avif|bmp|mp3|wav|ogg|m4a|mp4|webm|mov|csv|json|ya?ml|html?|canvas|base)$/i;

/** The file a wikilink target names, relative to the note's folder: `a b` is `a b.md`. */
export function wikilinkFilePath(target: string): string {
  return FILE_EXTENSION.test(target) ? target : `${target}.md`;
}

/**
 * A link destination for the target's file relative to the note, each path segment
 * percent-encoded. It starts with `./` or `../`, so a name with any punctuation (`a, b (c)`)
 * still reads as a file path, and a leading `/` never makes it a root or `//host` link.
 */
export function wikilinkHref(link: Wikilink): string {
  const path = wikilinkFilePath(link.target).replace(/^[\\/]+/, "");
  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return /^\.{1,2}\//.test(path) ? encoded : `./${encoded}`;
}

/** The text a wikilink shows: its alias, else its target, with the heading after `>`. */
export function wikilinkLabel(link: Wikilink): string {
  if (link.alias !== null) return link.alias;
  return link.heading === null ? link.target : `${link.target} > ${link.heading}`;
}

/**
 * Remark plugin: each wikilink in a text node becomes a link to the target's file, relative to the
 * note, which the renderer resolves like any relative file link. The link carries the target as
 * written in `data-wikilink`, so a renderer can ask a resolver about it. Code is never a text
 * node, so code spans and fences are left alone.
 */
export function remarkWikilinks() {
  return (tree: Root) => {
    visitTextParents(tree);
  };
}

type Parent = { children: Array<{ type: string }> };

function visitTextParents(node: { type: string; children?: unknown }): void {
  if (!Array.isArray(node.children)) return;
  const parent = node as unknown as Parent;
  // A link inside a link is not markdown; leave a link's own text alone.
  if (node.type === "link" || node.type === "linkReference") return;
  const next: Array<{ type: string }> = [];
  let changed = false;
  for (const child of parent.children) {
    if (child.type === "text") {
      const parts = splitTextNode(child as Text);
      if (parts !== null) {
        next.push(...parts);
        changed = true;
        continue;
      }
    } else {
      visitTextParents(child as { type: string; children?: unknown });
    }
    next.push(child);
  }
  if (changed) parent.children = next;
}

function splitTextNode(node: Text): PhrasingContent[] | null {
  const matches = findWikilinks(node.value);
  if (matches.length === 0) return null;
  const parts: PhrasingContent[] = [];
  let at = 0;
  for (const { start, end, link } of matches) {
    if (start > at) parts.push({ type: "text", value: node.value.slice(at, start) });
    const linkNode: Link = {
      type: "link",
      url: wikilinkHref(link),
      children: [{ type: "text", value: wikilinkLabel(link) }],
      data: {
        hProperties: {
          dataWikilink: link.target,
          ...(link.alias !== null ? { dataWikilinkAlias: "" } : {}),
        },
      },
    };
    parts.push(linkNode);
    at = end;
  }
  if (at < node.value.length) parts.push({ type: "text", value: node.value.slice(at) });
  return parts;
}
