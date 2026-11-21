import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// A link scheme a server resolves through an external program: lower case, RFC 3986 grammar.
export const LINK_RESOLVER_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;
export const LinkResolverScheme = Schema.String.check(
  Schema.isPattern(LINK_RESOLVER_SCHEME_PATTERN),
  Schema.isMaxLength(64),
);
export type LinkResolverScheme = typeof LinkResolverScheme.Type;

// No control characters or backslashes, and no `.` or `..` segment, so an id a program reads as
// a path cannot climb out of where the program looks.
const LINK_ID_FORBIDDEN = /[\u0000-\u001f\u007f\\]|(?:^|\/)\.{1,2}(?:\/|$)/;
export const LINK_RESOLVER_ID_MAX_LENGTH = 2_048;

/** Whether `id`, what follows `<scheme>://` in a link, may be sent to a link resolver. */
export function isResolvedLinkId(id: string): boolean {
  return (
    id.trim() === id &&
    id !== "" &&
    id.length <= LINK_RESOLVER_ID_MAX_LENGTH &&
    !LINK_ID_FORBIDDEN.test(id)
  );
}

export const LinkResolveInput = Schema.Struct({
  scheme: LinkResolverScheme,
  // What follows `<scheme>://` in the link, as written.
  id: TrimmedNonEmptyString.check(
    Schema.isMaxLength(LINK_RESOLVER_ID_MAX_LENGTH),
    Schema.makeFilter((id: string) => isResolvedLinkId(id), { expected: "a link id" }),
  ),
});
export type LinkResolveInput = typeof LinkResolveInput.Type;

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
