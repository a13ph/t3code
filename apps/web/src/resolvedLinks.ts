/**
 * A chat link whose scheme a connected server resolves through an external program, such as
 * `notes://3f2b9c1e-7d4a-4e6b-9a8c-2d5f1b0e7c43`. The servers announce their schemes; the link is
 * `<scheme>://<id>`, as a markdown link's href (optionally wrapped in `<...>`) or as an inline
 * code span. The id is what follows `://`, without a trailing slash, as written.
 */
export interface ResolvedLinkRef {
  /** Lower case. */
  readonly scheme: string;
  readonly id: string;
}

// The scheme grammar of RFC 3986, kept to what a setting can name.
export const RESOLVED_LINK_SCHEME = /^[a-z][a-z0-9+.-]*$/;
// No whitespace, no angle brackets: the id ends where a markdown destination would.
const LINK = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^\s<>/][^\s<>]*?)\/?$/;

export function parseResolvedLinkHref(
  href: string | undefined | null,
  schemes: ReadonlySet<string>,
): ResolvedLinkRef | null {
  if (!href || schemes.size === 0) return null;
  const match = LINK.exec(href.trim().replace(/^<(.*)>$/, "$1"));
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  if (!schemes.has(scheme)) return null;
  // Markdown percent-encodes a link destination and leaves a code span alone; both mean one id.
  let id = match[2]!;
  try {
    id = decodeURIComponent(id);
  } catch {
    // A lone `%` is part of the id as written.
  }
  return id.trim() === "" ? null : { scheme, id };
}

// Schemes chat must never turn into resolved links, whatever a server announces: unsafe ones,
// web ones, and the ones the app already reads itself.
const NEVER_RESOLVED = new Set([
  "javascript",
  "vbscript",
  "data",
  "blob",
  "about",
  "file",
  "http",
  "https",
  "mailto",
  "remote-file",
  "t3-citation",
  "t3-context",
  "t3-thread",
]);

/** Every link scheme the given servers resolve, sorted, deduplicated and lower case. */
export function linkSchemesOf(
  configs: Iterable<{ readonly linkSchemes?: ReadonlyArray<string> | undefined } | undefined>,
): ReadonlyArray<string> {
  const schemes = new Set<string>();
  for (const config of configs) {
    for (const raw of config?.linkSchemes ?? []) {
      const scheme = raw.trim().toLowerCase();
      if (RESOLVED_LINK_SCHEME.test(scheme) && !NEVER_RESOLVED.has(scheme)) schemes.add(scheme);
    }
  }
  return [...schemes].sort();
}

export function resolvedLinkHref(link: ResolvedLinkRef): string {
  return `${link.scheme}://${link.id}`;
}

/** The tooltip, one string per line: the program's own lines, then the server that answered. */
export function resolvedLinkTooltipLines(
  target: { readonly tooltip: string; readonly path: string },
  label: string,
  serverLabel: string,
): ReadonlyArray<string> {
  const own = target.tooltip
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
  return [...(own.length > 0 ? own : [label, target.path]), `on ${serverLabel}`];
}

/** What the chip shows before an answer arrives, or when no server knows the link. */
export function resolvedLinkPlaceholder(link: ResolvedLinkRef): string {
  return `${link.scheme}:${link.id.slice(0, 8)}`;
}
