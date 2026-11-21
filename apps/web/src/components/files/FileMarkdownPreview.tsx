import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import {
  type FrontmatterProperty,
  maskMarkdownFrontmatter,
  readFrontmatterProperties,
} from "@t3tools/shared/markdownFrontmatter";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import { remarkWikilinks } from "@t3tools/shared/wikilinks";
import * as Schema from "effect/Schema";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useTheme } from "~/hooks/useTheme";
import { useRightPanelStore } from "~/rightPanelStore";

import { type NoteLinks, NoteLinksContext, ResolvedTargetChip, useNoteServer } from "./noteLinks";
import { propertyMarkdown } from "./notePropertiesMarkdown";
import { useNoteBacklinks } from "./useNoteLinkLookups";

const NOTE_REMARK_PLUGINS = [remarkWikilinks];
const PROPERTIES_OPEN_STORAGE_KEY = "t3code.noteProperties.open";

export function FileMarkdownPreview(props: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly text: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  /** The server holding the file; the thread's when absent. */
  readonly environmentId?: EnvironmentId | undefined;
  /** The file's absolute path on that server, for link resolvers. */
  readonly notePath?: string | null | undefined;
  /** Follows a link in place, keeping history; without it a link opens in its own tab. */
  readonly onFollowLink?:
    | ((path: string, line: number | undefined, environmentId: EnvironmentId) => void)
    | undefined;
  readonly onTaskListChange?:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined;
}) {
  const environmentId = props.environmentId ?? props.threadRef.environmentId;
  const server = useNoteServer(environmentId);
  const lastSeparator = Math.max(
    props.relativePath.lastIndexOf("/"),
    props.relativePath.lastIndexOf("\\"),
  );
  const imageBaseDir =
    lastSeparator >= 0
      ? resolvePathLinkTarget(props.relativePath.slice(0, lastSeparator), props.cwd)
      : props.cwd;
  const { threadRef, onFollowLink } = props;
  const noteLinks: NoteLinks = {
    environmentId,
    notePath: props.notePath ?? null,
    serverLabel: server.label,
    resolvesWikilinks: server.resolvesWikilinks,
    open: (resolvedPath, line, linkEnvironmentId) => {
      const target = linkEnvironmentId ?? environmentId;
      // A resolver names a note by its absolute path, the file tree by its workspace path; one
      // name for one file keeps it in one tab and its history steps honest.
      const inWorkspace =
        target === environmentId ? workspaceRelativeFilePath(resolvedPath, props.cwd) : null;
      const path = inWorkspace !== null && inWorkspace !== "." ? inWorkspace : resolvedPath;
      if (onFollowLink) onFollowLink(path, line, target);
      else useRightPanelStore.getState().openFile(threadRef, path, line, target);
    },
  };
  const properties = readFrontmatterProperties(props.text);
  const markdownProps = {
    cwd: props.cwd,
    imageBaseDir,
    threadRef,
    environmentId,
    workspaceMutationId: props.workspaceMutationId,
    extraRemarkPlugins: NOTE_REMARK_PLUGINS,
  };

  return (
    <NoteLinksContext value={noteLinks}>
      <div className="mx-auto max-w-4xl px-6 py-5">
        {properties !== null ? (
          <NoteProperties
            properties={properties}
            noteLinks={noteLinks}
            renderValue={(text) => <ChatMarkdown text={text} {...markdownProps} />}
          />
        ) : null}
        <ChatMarkdown
          text={maskMarkdownFrontmatter(props.text)}
          {...markdownProps}
          onTaskListChange={props.onTaskListChange}
        />
      </div>
    </NoteLinksContext>
  );
}

// Each item keyed by its name and how many times the name came before, since hand-written
// frontmatter can repeat a key and a resolver can list a note twice.
function withOccurrenceKeys<A>(
  items: ReadonlyArray<A>,
  nameOf: (item: A) => string,
): ReadonlyArray<readonly [string, A]> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const name = nameOf(item);
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return [`${name}#${count}`, item] as const;
  });
}

/**
 * The note's frontmatter, folded under one line, and the notes that link to it. Values keep
 * their wikilinks and URLs as links; the rest shows as written.
 */
function NoteProperties(props: {
  readonly properties: ReadonlyArray<FrontmatterProperty>;
  readonly noteLinks: NoteLinks;
  readonly renderValue: (markdown: string) => ReactNode;
}) {
  const [open, setOpen] = useLocalStorage(PROPERTIES_OPEN_STORAGE_KEY, false, Schema.Boolean);
  const backlinks = useNoteBacklinks(props.noteLinks);
  const { resolvedTheme } = useTheme();
  const shown = props.properties.filter((property) => property.values.length > 0);
  const linkedFrom = backlinks ?? [];
  return (
    <details
      className="group mb-4 rounded-md border border-border/70 bg-card/40 text-xs"
      data-note-properties
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 text-muted-foreground select-none">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
        <span>
          Properties ({shown.length})
          {linkedFrom.length > 0 ? `, linked from ${linkedFrom.length}` : ""}
        </span>
      </summary>
      <dl className="grid grid-cols-[minmax(6rem,max-content)_1fr] gap-x-3 gap-y-1 border-t border-border/60 px-3 py-2">
        {withOccurrenceKeys(shown, (property) => property.key).map(([rowKey, property]) => (
          <div key={rowKey} className="contents">
            <dt className="pt-0.5 font-mono break-all text-muted-foreground">{property.key}</dt>
            <dd className="min-w-0 [&_.chat-markdown]:text-xs [&_p]:my-0 [&_ul]:my-0">
              {props.renderValue(propertyMarkdown(property))}
            </dd>
          </div>
        ))}
        {linkedFrom.length > 0 ? (
          <div className="contents" data-note-linked-from>
            <dt className="pt-0.5 text-muted-foreground">linked from</dt>
            <dd className="flex min-w-0 flex-col items-start gap-0.5">
              {withOccurrenceKeys(linkedFrom, (link) => link.path).map(([rowKey, link]) => (
                <ResolvedTargetChip
                  key={rowKey}
                  noteLinks={props.noteLinks}
                  target={link}
                  label={link.label || link.path}
                  href={link.path}
                  copyMarkdown={`[${(link.label || link.path).replace(/[\\[\]]/g, "\\$&")}](<${link.path}>)`}
                  threadRef={undefined}
                  theme={resolvedTheme}
                />
              ))}
            </dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}
