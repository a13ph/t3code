import type { EnvironmentId, ResolvedLinkTone, ScopedThreadRef } from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";

import {
  resolvedLinkHref,
  resolvedLinkPlaceholder,
  resolvedLinkTooltipLines,
  type ResolvedLinkRef,
} from "@t3tools/client-runtime/resolved-links";
import { useRightPanelStore } from "../../rightPanelStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MarkdownFileLink } from "./MarkdownFileLink";
import { useNoteLinks } from "../files/noteLinks";
import { useResolvedLink } from "./useResolvedLink";

// Theme colours only, so the mark follows light, dark and custom themes.
const TONE_CLASS_NAMES: Readonly<Record<ResolvedLinkTone, string>> = {
  normal: "",
  muted: "text-muted-foreground",
  warning: "text-warning",
  danger: "text-destructive",
};

/**
 * A link of a scheme some connected server resolves, such as `notes://<id>`. It finds the server
 * that knows the link and shows what that server's program says it names: a label, a mark in
 * front, a tooltip. A click opens the target file read-only in the files panel, from that server.
 * `label` is the link's own text, shown while the servers answer and when none knows the link.
 */
export function MarkdownResolvedLink(props: {
  readonly link: ResolvedLinkRef;
  readonly label?: string;
  readonly copyMarkdown: string;
  readonly environmentId: EnvironmentId | null;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly theme: "light" | "dark";
}) {
  const resolution = useResolvedLink(props.link, props.environmentId);
  const noteLinks = useNoteLinks();
  const { threadRef } = props;
  const fallbackLabel = props.label || resolvedLinkPlaceholder(props.link);
  const href = resolvedLinkHref(props.link);
  if (resolution._tag === "found") {
    const { target, environmentId, serverLabel } = resolution;
    const label = target.label || fallbackLabel;
    const muted = target.tone === "muted";
    return (
      <MarkdownFileLink
        environmentId={environmentId}
        href={href}
        targetPath={`${serverLabel}:${target.path}`}
        iconPath={target.path}
        workspaceRelativePath={null}
        panelPath={target.path}
        line={undefined}
        label={label}
        copyMarkdown={props.copyMarkdown}
        theme={props.theme}
        threadRef={threadRef}
        onOpenInPanel={(panelPath, line) => {
          if (noteLinks) {
            noteLinks.open(panelPath, line, environmentId);
            return;
          }
          if (!threadRef) return;
          useRightPanelStore.getState().openFile(threadRef, panelPath, line, environmentId);
        }}
        resolveCopyPaths={() =>
          Promise.resolve({ fullPath: target.path, relativePath: fileBasename(target.path) })
        }
        openInEditorMenuLabel=""
        tooltipLines={resolvedLinkTooltipLines(target, label, serverLabel)}
        leadingMark={
          target.mark === ""
            ? undefined
            : {
                text: target.mark,
                label: target.tone,
                className: TONE_CLASS_NAMES[target.tone],
              }
        }
        labelClassName={muted ? "text-muted-foreground" : undefined}
        hrefIsInternal
      />
    );
  }
  const missing = resolution._tag === "missing";
  return (
    <Tooltip>
      <TooltipTrigger render={<span data-resolved-link={missing ? "missing" : "resolving"} />}>
        {fallbackLabel}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {missing ? `No connected server knows ${href}` : `Looking up ${href}`}
      </TooltipPopup>
    </Tooltip>
  );
}
