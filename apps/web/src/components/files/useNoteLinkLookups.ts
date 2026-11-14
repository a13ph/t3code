import {
  isResolvedLinkId,
  isResolverNotePath,
  type ResolvedLink,
  WIKILINK_RESOLVER_SCHEME,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { linkBacklinksLookup, resolvedLinkLookup } from "../../state/resolvedLinkLookup";
import { subscribeResolvedLinkRefresh } from "../chat/resolvedLinkLiveRefresh";
import type { NoteLinks } from "./noteLinks";

/**
 * What the note's server says a link names, kept while the server answers unavailable, and
 * refreshed on the shared live-refresh tick. Null until it names something.
 */
function useKeptAnswer<A>(
  answer: A | { readonly unavailable: true } | null | undefined,
  liveKey: string | null,
  refresh: () => void,
): A | null {
  const [kept, setKept] = useState<{ readonly key: string | null; readonly value: A | null }>({
    key: liveKey,
    value: null,
  });
  const fresh =
    answer === undefined
      ? undefined
      : answer !== null && typeof answer === "object" && "unavailable" in answer
        ? undefined
        : (answer as A | null);
  if (kept.key !== liveKey) setKept({ key: liveKey, value: fresh ?? null });
  else if (fresh !== undefined && fresh !== kept.value) setKept({ key: liveKey, value: fresh });
  const refreshQuery = useEffectEvent(refresh);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the answer live on the shared refresh tick while the link is shown
  useEffect(() => {
    if (liveKey === null) return;
    return subscribeResolvedLinkRefresh(liveKey, () => refreshQuery());
  }, [liveKey]);
  if (fresh !== undefined) return fresh;
  return kept.key === liveKey ? kept.value : null;
}

/** The target a wikilink in the note names, by the note server's resolver; null for none yet. */
export function useWikilinkTarget(
  noteLinks: NoteLinks | null,
  target: string,
): ResolvedLink | null {
  // A target no resolver may be sent stays a plain file link.
  const asks =
    noteLinks !== null &&
    noteLinks.resolvesWikilinks &&
    noteLinks.notePath !== null &&
    isResolverNotePath(noteLinks.notePath) &&
    isResolvedLinkId(target);
  const result = useEnvironmentQuery(
    asks
      ? resolvedLinkLookup({
          environmentId: noteLinks.environmentId,
          input: { scheme: WIKILINK_RESOLVER_SCHEME, id: target, from: noteLinks.notePath! },
        })
      : null,
  );
  const liveKey = asks
    ? `${noteLinks.environmentId}|wikilink|${noteLinks.notePath}|${target}`
    : null;
  return useKeptAnswer(result.isSuccess ? result.data : undefined, liveKey, () => result.refresh());
}

/** The notes that link to the note, by its server's resolver; null when it cannot say. */
export function useNoteBacklinks(noteLinks: NoteLinks | null): ReadonlyArray<ResolvedLink> | null {
  const asks =
    noteLinks !== null &&
    noteLinks.resolvesWikilinks &&
    noteLinks.notePath !== null &&
    isResolverNotePath(noteLinks.notePath);
  const result = useEnvironmentQuery(
    asks
      ? linkBacklinksLookup({
          environmentId: noteLinks.environmentId,
          input: { scheme: WIKILINK_RESOLVER_SCHEME, path: noteLinks.notePath! },
        })
      : null,
  );
  const liveKey = asks ? `${noteLinks.environmentId}|backlinks|${noteLinks.notePath}` : null;
  const kept = useKeptAnswer(result.isSuccess ? result.data : undefined, liveKey, () =>
    result.refresh(),
  );
  return kept?.links ?? null;
}
