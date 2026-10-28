import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { formatThreadLink, percentDecodedThreadLinkId } from "@t3tools/shared/threadLinks";
import { Link } from "@tanstack/react-router";
import { MessageSquareTextIcon } from "lucide-react";

import { useProject, useThreadRefs, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { isThreadRouteSnapshotAuthoritative } from "../../threadRoutes";
import { ProjectFavicon } from "../ProjectFavicon";

/**
 * A `t3-thread://` link in chat. It shows the thread's current title, so a rename
 * reaches every message that links to it, and leads with the thread's project icon
 * the way a web link leads with its favicon. `label` is what the message wrote,
 * shown only when this client cannot see the thread. Opens the thread in the app,
 * in whichever connected environment holds it, not only the message's own.
 */
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
}) {
  const decodedId = percentDecodedThreadLinkId(props.threadId);
  const written = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const decoded = useThreadShell(
    written === null && decodedId !== null ? scopeThreadRef(props.environmentId, decodedId) : null,
  );
  const local = written ?? decoded;
  // Thread ids are UUIDs, so a match in another connected environment is this thread.
  // Look elsewhere only once the message's own environment is live, so a link to a
  // local thread never points at another environment while the local index loads.
  const shell = useEnvironmentQuery(environmentShell.stateAtom(props.environmentId));
  const ownLive = isThreadRouteSnapshotAuthoritative(shell.data?.status);
  const refs = useThreadRefs(local === null && ownLive);
  const elsewhereRef =
    local === null && ownLive
      ? (refs.find((ref) => ref.threadId === props.threadId || ref.threadId === decodedId) ??
        null)
      : null;
  const elsewhere = useThreadShell(elsewhereRef);
  const thread = local ?? elsewhere;
  const environmentId = thread?.environmentId ?? props.environmentId;
  const threadId = thread?.id ?? props.threadId;
  const project = useProject(
    thread === null ? null : scopeProjectRef(environmentId, thread.projectId),
  );
  const title = thread?.title.trim() || props.label;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId }}
      // Like an attached thread chip: archived threads are not in the index but still open.
      title={thread === null ? "Thread no longer available" : project?.title}
      data-markdown-copy={formatThreadLink(threadId, title)}
    >
      <span
        className="ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]"
        aria-hidden
      >
        {project === null ? (
          <MessageSquareTextIcon className="block size-full shrink-0" />
        ) : (
          <ProjectFavicon project={project} className="size-full" />
        )}
      </span>
      {title}
    </Link>
  );
}
