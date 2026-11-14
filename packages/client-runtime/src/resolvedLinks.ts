import {
  isReservedLinkScheme,
  isResolvedLinkId,
  WIKILINK_RESOLVER_SCHEME,
} from "@t3tools/contracts";
import { unwrapResolvedLinkHref } from "@t3tools/shared/markdownPipeline";

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
const RESOLVED_LINK_SCHEME = /^[a-z][a-z0-9+.-]*$/;
// No whitespace, no angle brackets: the id ends where a markdown destination would.
const LINK = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^\s<>/][^\s<>]*?)\/?$/;

export function parseResolvedLinkHref(
  href: string | undefined | null,
  schemes: ReadonlySet<string>,
): ResolvedLinkRef | null {
  if (!href || schemes.size === 0) return null;
  const written = href.trim().replace(/^<(.*)>$/, "$1");
  // The chat sanitizer hands these links on as `t3-resolved:<scheme>://<id>`.
  const match = LINK.exec(unwrapResolvedLinkHref(written) ?? written);
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
  return isResolvedLinkId(id) ? { scheme, id } : null;
}

/**
 * Every link scheme the given servers resolve for chat links, sorted, deduplicated and lower
 * case. The wikilink scheme names a resolver for notes, not a kind of link, so it is left out.
 */
export function linkSchemesOf(
  configs: Iterable<{ readonly linkSchemes?: ReadonlyArray<string> | undefined } | undefined>,
): ReadonlyArray<string> {
  const schemes = new Set<string>();
  for (const config of configs) {
    for (const raw of config?.linkSchemes ?? []) {
      const scheme = raw.trim().toLowerCase();
      if (
        RESOLVED_LINK_SCHEME.test(scheme) &&
        !isReservedLinkScheme(scheme) &&
        scheme !== WIKILINK_RESOLVER_SCHEME
      ) {
        schemes.add(scheme);
      }
    }
  }
  return [...schemes].sort();
}

/** Whether a server resolves wikilinks in notes, and answers which notes link to a note. */
export function resolvesWikilinks(
  config: { readonly linkSchemes?: ReadonlyArray<string> | undefined } | null | undefined,
): boolean {
  return (config?.linkSchemes ?? []).some(
    (scheme) => scheme.trim().toLowerCase() === WIKILINK_RESOLVER_SCHEME,
  );
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
