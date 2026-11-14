import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// A link scheme a server resolves through an external program: lower case, RFC 3986 grammar.
const LINK_RESOLVER_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;
export const LinkResolverScheme = Schema.String.check(
  Schema.isPattern(LINK_RESOLVER_SCHEME_PATTERN),
  Schema.isMaxLength(64),
);
export type LinkResolverScheme = typeof LinkResolverScheme.Type;

// Schemes chat must never turn into resolved links, whatever a server is set to resolve: unsafe
// ones, web ones, and the ones the app already reads itself.
const RESERVED_LINK_SCHEMES: ReadonlySet<string> = new Set([
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
  "t3-resolved",
  "t3-thread",
]);

/** Whether `scheme`, lower case, is one no link resolver may take. */
export function isReservedLinkScheme(scheme: string): boolean {
  return RESERVED_LINK_SCHEMES.has(scheme);
}

// No control characters or backslashes, no `.` or `..` segment, and no leading `/` or drive, so
// an id a program reads as a path cannot climb out of where the program looks or name a host.
const LINK_ID_FORBIDDEN = /[\u0000-\u001f\u007f\\]|(?:^|\/)\.{1,2}(?:\/|$)|^\/|^[A-Za-z]:/;
const LINK_RESOLVER_ID_MAX_LENGTH = 2_048;

/** Whether `id`, what follows `<scheme>://` in a link, may be sent to a link resolver. */
export function isResolvedLinkId(id: string): boolean {
  return (
    id.trim() === id &&
    id !== "" &&
    id.length <= LINK_RESOLVER_ID_MAX_LENGTH &&
    !LINK_ID_FORBIDDEN.test(id)
  );
}

/**
 * The scheme a server's setting names for `[[wikilinks]]` in notes. Its program is asked about a
 * wikilink's target with the path of the note holding it, and for the notes that link to a note.
 * Chat never shows `<this>://` links as chips.
 */
export const WIKILINK_RESOLVER_SCHEME = "wikilink";

const LINK_RESOLVER_PATH_MAX_LENGTH = 4_096;

/**
 * Whether `path` is one a resolver may be sent as a note's path: absolute and local, no control
 * chars. A network or device path (`//host/share`, `\\?\`) would make a program reading it
 * connect out.
 */
export function isResolverNotePath(path: string): boolean {
  return (
    path.length <= LINK_RESOLVER_PATH_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    !/^[\\/]{2}/.test(path) &&
    (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path))
  );
}

const NotePath = TrimmedNonEmptyString.check(
  Schema.makeFilter((path: string) => isResolverNotePath(path), { expected: "an absolute path" }),
);

export const LinkResolveInput = Schema.Struct({
  scheme: LinkResolverScheme,
  // What follows `<scheme>://` in the link, as written; for a wikilink, its target.
  id: TrimmedNonEmptyString.check(
    Schema.isMaxLength(LINK_RESOLVER_ID_MAX_LENGTH),
    Schema.makeFilter((id: string) => isResolvedLinkId(id), { expected: "a link id" }),
  ),
  // The absolute path, on the server asked, of the note holding the link. Absent for chat links.
  from: Schema.optionalKey(NotePath),
});
export type LinkResolveInput = typeof LinkResolveInput.Type;

export const LinkBacklinksInput = Schema.Struct({
  scheme: LinkResolverScheme,
  // The absolute path, on the server asked, of the note whose linking notes are wanted.
  path: NotePath,
});
export type LinkBacklinksInput = typeof LinkBacklinksInput.Type;

// How the client colours the mark: mapped to theme colours, never to raw colour values.
export const ResolvedLinkTone = Schema.Literals(["normal", "muted", "warning", "danger"]);
export type ResolvedLinkTone = typeof ResolvedLinkTone.Type;

export const ResolvedLink = Schema.Struct({
  // Absolute host path of the file the link names, on the server that answered.
  path: TrimmedNonEmptyString,
  // The chip's text; empty when the program gave none.
  label: Schema.String,
  // One character shown in front of the label, as text; empty for none.
  mark: Schema.String,
  tone: ResolvedLinkTone,
  // The chip's tooltip; lines split on `\n`.
  tooltip: Schema.String,
});
export type ResolvedLink = typeof ResolvedLink.Type;

// The program could not answer now: it failed, timed out or is busy. Not an answer about the
// link, so a client keeps what it last showed.
export const LinkResolveUnavailable = Schema.Struct({ unavailable: Schema.Literal(true) });
export type LinkResolveUnavailable = typeof LinkResolveUnavailable.Type;

// Null when this server resolves no such scheme, or its program does not know the link.
export const LinkResolveResult = Schema.Union([ResolvedLink, LinkResolveUnavailable, Schema.Null]);
export type LinkResolveResult = typeof LinkResolveResult.Type;

// The notes that link to a note, each named as a resolved link is.
export const LinkBacklinks = Schema.Struct({ links: Schema.Array(ResolvedLink) });
export type LinkBacklinks = typeof LinkBacklinks.Type;

// Null when this server resolves no such scheme.
export const LinkBacklinksResult = Schema.Union([
  LinkBacklinks,
  LinkResolveUnavailable,
  Schema.Null,
]);
export type LinkBacklinksResult = typeof LinkBacklinksResult.Type;
