const LEADING_FRONTMATTER =
  /^\uFEFF?---[ \t]*(?:\r\n|\r|\n)(?:[\s\S]*?(?:\r\n|\r|\n))?(?:---|\.\.\.)[ \t]*(?=\r\n|\r|\n|$)/;

/**
 * Blanks a leading YAML frontmatter block so rendered previews skip it instead
 * of showing a rule and a setext heading. Masked characters become spaces and
 * line breaks stay, so source offsets (task checkbox edits) stay valid.
 */
export function maskMarkdownFrontmatter(markdown: string): string {
  return markdown.replace(LEADING_FRONTMATTER, (block) => block.replace(/[^\r\n]/g, " "));
}

/** One top-level key of a frontmatter block, as written. */
export interface FrontmatterProperty {
  readonly key: string;
  /** One value for a scalar, one per item for a list; quotes removed. */
  readonly values: ReadonlyArray<string>;
  /** Written as a list (`- item` lines or `[a, b]`), even with one item or none. */
  readonly list: boolean;
}

// Matched against lines with their trailing blanks cut, so no pattern scans a long blank run
// once per character.
const TOP_LEVEL_KEY = /^([^\s#-][^:]*?|"[^"]*"|'[^']*'):(?:[ \t]+(.*))?$/;
const LIST_ITEM = /^[ \t]*-(?:[ \t]+(.*))?$/;
const BLOCK_SCALAR = /^[|>][+-]?\d*$/;

interface PropertyDraft {
  readonly key: string;
  readonly values: string[];
  list: boolean;
  readonly block: boolean;
}

/**
 * The leading frontmatter's top-level keys, read line by line rather than as YAML, so a value
 * YAML would read as something else still shows as written: a bare `[[note]]` is a nested list
 * to YAML and a wikilink here. Nested maps and other shapes show as their raw lines. Null when
 * the markdown has no leading frontmatter.
 */
export function readFrontmatterProperties(
  markdown: string,
): ReadonlyArray<FrontmatterProperty> | null {
  const block = LEADING_FRONTMATTER.exec(markdown)?.[0];
  if (block === undefined) return null;
  const lines = block.split(/\r\n|\r|\n/).slice(1, -1);
  const properties: PropertyDraft[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const current = properties.at(-1);
    if (line.trim() === "") {
      if (current?.block && current.values[0] !== "") current.values[0] += "\n";
      continue;
    }
    const indented = /^[ \t]/.test(line);
    if (current?.block && indented) {
      const text = line.trim();
      current.values[0] = current.values[0] === "" ? text : `${current.values[0]}\n${text}`;
      continue;
    }
    if (/^\s*#/.test(line)) continue;
    const item = LIST_ITEM.exec(line);
    if (item && current && !current.block && (current.list || current.values.length === 0)) {
      current.list = true;
      const value = item[1];
      if (value !== undefined && value !== "") current.values.push(unquoteYamlScalar(value));
      continue;
    }
    if (indented && current && !current.block) {
      const text = line.trim();
      if (current.list || current.values.length === 0) {
        // A nested map or a list item's own keys: shown as written.
        current.list = true;
        current.values.push(text);
      } else {
        // A plain scalar folded onto the next line.
        current.values[0] = `${current.values[0]} ${text}`;
      }
      continue;
    }
    const keyMatch = TOP_LEVEL_KEY.exec(line);
    if (!keyMatch) continue;
    const key = unquoteYamlScalar(keyMatch[1]!);
    const raw = keyMatch[2] ?? "";
    if (BLOCK_SCALAR.test(raw)) {
      properties.push({ key, values: [""], list: false, block: true });
    } else if (/^\[(?!\[)/.test(raw) && raw.endsWith("]")) {
      properties.push({
        key,
        values: splitFlowSequence(raw.slice(1, -1)),
        list: true,
        block: false,
      });
    } else {
      properties.push({
        key,
        values: raw === "" ? [] : [unquoteYamlScalar(raw)],
        list: false,
        block: false,
      });
    }
  }
  return properties.map(({ key, values, list, block }) => ({
    key,
    values: block ? values.map((value) => value.replace(/\n+$/, "")) : values,
    list,
  }));
}

function unquoteYamlScalar(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "string") return parsed;
    } catch {
      // YAML escapes JSON lacks, such as `\x41`: the text between the quotes.
    }
    return text.slice(1, -1);
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  // A plain value keeps a ` #...` tail, which YAML would drop as a comment: titles hold them.
  return text;
}

// `a, "b, c", [[d]]`: commas inside quotes or brackets do not split.
function splitFlowSequence(inner: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i]!;
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[") depth += 1;
    else if (char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      items.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  items.push(inner.slice(start));
  return items.map(unquoteYamlScalar).filter((item) => item !== "");
}
