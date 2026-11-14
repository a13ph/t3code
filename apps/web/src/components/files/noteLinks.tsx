import { resolvedLinkTooltipLines } from "@t3tools/client-runtime/resolved-links";
import {
  type EnvironmentId,
  type ResolvedLink,
  type ResolvedLinkTone,
  type ScopedThreadRef,
  WIKILINK_RESOLVER_SCHEME,
} from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";
import { createContext, type ReactNode, use } from "react";

import { useEnvironments } from "../../state/environments";
import { MarkdownFileLink } from "../chat/MarkdownFileLink";
import { useWikilinkTarget } from "./useNoteLinkLookups";

/** The note a markdown preview shows, for the links inside it. */
export interface NoteLinks {
  /** The server holding the note. */
  readonly environmentId: EnvironmentId;
  /** The note's absolute path on that server, or null when it has none. */
  readonly notePath: string | null;
  /** That server's label, for tooltips. */
  readonly serverLabel: string;
  /** That server answers wikilink and backlink lookups. */
  readonly resolvesWikilinks: boolean;
  /** Opens a file a link in the note names; `environmentId` defaults to the note's server. */
  readonly open: (path: string, line: number | undefined, environmentId?: EnvironmentId) => void;
}

/** Set by a file preview around a note; links inside it open beside or in place of the note. */
export const NoteLinksContext = createContext<NoteLinks | null>(null);

export function useNoteLinks(): NoteLinks | null {
  return use(NoteLinksContext);
}

/** The server's label and whether it resolves wikilinks, read from its announced config. */
export function useNoteServer(environmentId: EnvironmentId): {
  readonly label: string;
  readonly resolvesWikilinks: boolean;
} {
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  return {
    label: environment?.label ?? "",
    resolvesWikilinks:
      environment?.connection.phase === "connected" &&
      (environment.serverConfig?.linkSchemes ?? []).some(
        (scheme) => scheme.trim().toLowerCase() === WIKILINK_RESOLVER_SCHEME,
      ),
  };
}

// Theme colours only, so the mark follows light, dark and custom themes.
const TONE_CLASS_NAMES: Readonly<Record<ResolvedLinkTone, string>> = {
  normal: "",
  muted: "text-muted-foreground",
  warning: "text-warning",
  danger: "text-destructive",
};

/** A chip for a file a resolver named: its mark, label and tooltip; a click opens it. */
export function ResolvedTargetChip(props: {
  readonly noteLinks: NoteLinks;
  readonly target: ResolvedLink;
  readonly label: string;
  readonly href: string;
  readonly copyMarkdown: string;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly theme: "light" | "dark";
}) {
  const { noteLinks, target } = props;
  return (
    <MarkdownFileLink
      environmentId={noteLinks.environmentId}
      href={props.href}
      targetPath={`${noteLinks.serverLabel}:${target.path}`}
      iconPath={target.path}
      workspaceRelativePath={null}
      panelPath={target.path}
      line={undefined}
      label={props.label}
      copyMarkdown={props.copyMarkdown}
      theme={props.theme}
      threadRef={props.threadRef}
      onOpenInPanel={(panelPath, line) => noteLinks.open(panelPath, line)}
      resolveCopyPaths={() =>
        Promise.resolve({ fullPath: target.path, relativePath: fileBasename(target.path) })
      }
      openInEditorMenuLabel=""
      tooltipLines={resolvedLinkTooltipLines(target, props.label, noteLinks.serverLabel)}
      leadingMark={
        target.mark === ""
          ? undefined
          : { text: target.mark, label: target.tone, className: TONE_CLASS_NAMES[target.tone] }
      }
      labelClassName={target.tone === "muted" ? "text-muted-foreground" : undefined}
      hrefIsInternal
    />
  );
}

/**
 * A `[[wikilink]]` in a note. With a resolver on the note's server it shows what the resolver
 * says the link names; until then, and when it names nothing, the plain file link beside the note.
 */
export function MarkdownWikilink(props: {
  readonly target: string;
  /** The link's own text; kept over the resolver's label when the link has an alias. */
  readonly written: string;
  readonly hasAlias: boolean;
  readonly fallback: ReactNode;
  readonly copyMarkdown: string;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly theme: "light" | "dark";
}) {
  const noteLinks = useNoteLinks();
  const target = useWikilinkTarget(noteLinks, props.target);
  if (noteLinks === null || target === null) return props.fallback;
  return (
    <ResolvedTargetChip
      noteLinks={noteLinks}
      target={target}
      label={props.hasAlias ? props.written : target.label || props.written}
      href={target.path}
      copyMarkdown={props.copyMarkdown}
      threadRef={props.threadRef}
      theme={props.theme}
    />
  );
}
