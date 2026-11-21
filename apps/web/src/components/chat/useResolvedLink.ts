import type { EnvironmentId, ResolvedLink } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ResolvedLinkRef } from "../../resolvedLinks";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { resolvedLinkLookup } from "../../state/resolvedLinkLookup";
import { subscribeResolvedLinkRefresh } from "./resolvedLinkLiveRefresh";

export type ResolvedLinkResolution =
  | { readonly _tag: "resolving" }
  | {
      readonly _tag: "found";
      readonly environmentId: EnvironmentId;
      readonly serverLabel: string;
      readonly target: ResolvedLink;
    }
  | { readonly _tag: "missing" };

interface Candidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

interface Position {
  readonly key: string;
  readonly index: number;
  /** 0 for the first pass over the servers, 1 for the one re-run after a miss. */
  readonly round: number;
  readonly startedAt: number;
}

// A server that neither answers nor fails in this long counts as not knowing the link. The
// server itself gives up on its program after 10 s, so this is a backstop for a lost connection.
const SERVER_ANSWER_TIMEOUT_MS = 12_000;
// A program may index what it resolves and rescan only every few seconds, so a target made just
// before the first ask is found by asking once more after that.
const RETRY_AFTER_MISS_MS = 6_000;

/**
 * Asks the chat's own server first, then every other connected server that announces the link's
 * scheme, in label order, one at a time; the first that knows the link wins. A server that fails
 * the call, such as an older build without the method, or that does not answer in time, counts
 * as not knowing it. When none knows it, the whole chain runs once more after
 * `RETRY_AFTER_MISS_MS`.
 *
 * Once found, the link is asked for again on that server while the page is visible (see
 * `resolvedLinkLiveRefresh`), so its label and mark stay current. If that server then does not
 * know it, fails or goes silent, the chain runs again from the chat's own server.
 */
export function useResolvedLink(
  link: ResolvedLinkRef,
  ownEnvironmentId: EnvironmentId | null,
): ResolvedLinkResolution {
  const { scheme, id } = link;
  const { environments, isReady } = useEnvironments();
  const candidates = useMemo<ReadonlyArray<Candidate>>(() => {
    const able = environments
      .filter(
        (environment) =>
          environment.connection.phase === "connected" &&
          (environment.serverConfig?.linkSchemes ?? []).some(
            (announced) => announced.trim().toLowerCase() === scheme,
          ),
      )
      .map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
      }));
    const own = able.find((candidate) => candidate.environmentId === ownEnvironmentId);
    const others = able
      .filter((candidate) => candidate.environmentId !== ownEnvironmentId)
      .sort(
        (left, right) =>
          left.label.localeCompare(right.label) ||
          left.environmentId.localeCompare(right.environmentId),
      );
    return own ? [own, ...others] : others;
  }, [environments, ownEnvironmentId, scheme]);
  const candidatesKey = `${scheme}://${id}|${candidates.map((candidate) => candidate.environmentId).join(",")}`;
  const [position, setPosition] = useState<Position>({
    key: candidatesKey,
    index: 0,
    round: 0,
    startedAt: 0,
  });
  const step: Position =
    position.key === candidatesKey
      ? position
      : { key: candidatesKey, index: 0, round: 0, startedAt: 0 };
  const { index, round, startedAt } = step;
  // `startedAt` tells apart the re-runs a lost link starts, so each asks its servers afresh.
  const stepKey = `${candidatesKey}|${round}|${index}|${startedAt}`;
  const current = candidates[index] ?? null;
  const currentEnvironmentId = current?.environmentId ?? null;
  const result = useEnvironmentQuery(
    currentEnvironmentId === null
      ? null
      : resolvedLinkLookup({ environmentId: currentEnvironmentId, input: { scheme, id } }),
  );
  const { isPending, refresh } = result;

  // The re-run asks each server again; the answer it held from the first pass does not count.
  const refreshedStep = useRef<string | null>(null);
  const [pendingSeenStep, setPendingSeenStep] = useState<string | null>(null);
  useEffect(() => {
    if (round === 0 || currentEnvironmentId === null || refreshedStep.current === stepKey) return;
    refreshedStep.current = stepKey;
    refresh();
  }, [currentEnvironmentId, refresh, round, stepKey]);
  useEffect(() => {
    if (round > 0 && isPending) setPendingSeenStep(stepKey);
  }, [isPending, round, stepKey]);

  const settled = result.failure !== null || result.error !== null || result.isSuccess;
  const answeredThisRound =
    round === 0 ||
    pendingSeenStep === stepKey ||
    (result.isSuccess && result.dataUpdatedAt >= startedAt);
  const answered = !isPending && settled && answeredThisRound;
  const hit = result.isSuccess ? result.data : null;
  const settledMiss = currentEnvironmentId !== null && answered && hit === null;

  // The step whose server last knew the link. When that server then loses it, fails or goes
  // silent, the target may have moved, so the whole chain runs again.
  const [foundStep, setFoundStep] = useState<string | null>(null);
  const hasHit = hit !== null;
  useEffect(() => {
    if (hasHit) setFoundStep(stepKey);
  }, [hasHit, stepKey]);
  const lostFound = foundStep === stepKey;

  useEffect(() => {
    if (currentEnvironmentId === null) return;
    const advance = () =>
      setPosition(
        lostFound
          ? { key: candidatesKey, index: 0, round: 1, startedAt: Date.now() }
          : { key: candidatesKey, index: index + 1, round, startedAt },
      );
    if (settledMiss) {
      advance();
      return;
    }
    if (answered) return;
    const timer = setTimeout(advance, SERVER_ANSWER_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [
    answered,
    candidatesKey,
    currentEnvironmentId,
    index,
    lostFound,
    round,
    settledMiss,
    startedAt,
  ]);

  // Live: the server that knows the link is asked again while the chip is on screen.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  const liveKey =
    hasHit && currentEnvironmentId !== null ? `${currentEnvironmentId}|${scheme}://${id}` : null;
  useEffect(() => {
    if (liveKey === null) return;
    return subscribeResolvedLinkRefresh(liveKey, () => refreshRef.current());
  }, [liveKey]);

  const exhausted = candidates.length > 0 && index >= candidates.length;
  useEffect(() => {
    if (!exhausted || round > 0) return;
    const timer = setTimeout(
      () => setPosition({ key: candidatesKey, index: 0, round: 1, startedAt: Date.now() }),
      RETRY_AFTER_MISS_MS,
    );
    return () => clearTimeout(timer);
  }, [candidatesKey, exhausted, round]);

  if (current === null) return { _tag: isReady ? "missing" : "resolving" };
  if (hit !== null && result.isSuccess) {
    return {
      _tag: "found",
      environmentId: current.environmentId,
      serverLabel: current.label,
      target: hit,
    };
  }
  return { _tag: "resolving" };
}
