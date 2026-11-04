import type { EnvironmentId, ResolvedLink } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useDeadlinePassed } from "../../hooks/useDeadline";
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

// A server that neither answers nor fails in this long counts as not knowing the link. The
// server itself gives up on its program after 10 s, so this is a backstop for a lost connection.
const SERVER_ANSWER_TIMEOUT_MS = 12_000;
// A program may index what it resolves and rescan only every few seconds, so a target made just
// before the first ask is found by asking once more after that.
const RETRY_AFTER_MISS_MS = 6_000;

interface Walk {
  /** The link and the servers that announce its scheme, in asking order. */
  readonly key: string;
  readonly index: number;
  /** 0 for the first pass over the servers, 1 for a re-run after a miss or a lost link. */
  readonly round: number;
  /** Counts re-runs, so each one asks its servers afresh. */
  readonly run: number;
  readonly startedAt: number;
  /** When the wait in progress gives up: a server's answer, or the re-run after a full miss. */
  readonly deadline: number | null;
  /** In a re-run, this server's query was seen waiting, so the answer it settles on is new. */
  readonly pendingSeen: boolean;
  /** The target this server last gave; it stays while the server's program is unavailable. */
  readonly kept: ResolvedLink | null;
}

interface WalkInput {
  readonly key: string;
  readonly count: number;
  readonly answered: boolean;
  readonly isPending: boolean;
  readonly fresh: ResolvedLink | null;
  readonly hit: ResolvedLink | null;
  readonly deadlinePassed: boolean;
}

function startWalk(key: string, run: number, round: number, now: () => number): Walk {
  const startedAt = now();
  return {
    key,
    index: 0,
    round,
    run,
    startedAt,
    deadline: startedAt + SERVER_ANSWER_TIMEOUT_MS,
    pendingSeen: false,
    kept: null,
  };
}

// A server that knew the link and then loses it, fails or goes silent may mean the target moved,
// so the whole chain runs again; otherwise the next server is asked.
function advanceWalk(walk: Walk, count: number, now: () => number): Walk {
  if (walk.kept !== null) return startWalk(walk.key, walk.run + 1, 1, now);
  const index = walk.index + 1;
  const startedAt = now();
  const wait =
    index < count ? SERVER_ANSWER_TIMEOUT_MS : walk.round === 0 ? RETRY_AFTER_MISS_MS : null;
  return {
    ...walk,
    index,
    startedAt,
    deadline: wait === null ? null : startedAt + wait,
    pendingSeen: false,
    kept: null,
  };
}

/**
 * Returns `walk` itself when nothing changes, so it can run on every render. `now` is read only to
 * stamp a new deadline; it is a function so the React Compiler cannot cache a stale clock reading.
 */
function stepWalk(walk: Walk, input: WalkInput, now: () => number): Walk {
  if (walk.key !== input.key) return startWalk(input.key, walk.run, 0, now);
  if (walk.index >= input.count) {
    if (input.count === 0 || walk.round > 0 || !input.deadlinePassed) return walk;
    return startWalk(walk.key, walk.run + 1, 1, now);
  }
  const kept = input.fresh ?? walk.kept;
  if (input.answered) {
    if (input.hit === null) return advanceWalk(walk, input.count, now);
    return kept === walk.kept && walk.deadline === null ? walk : { ...walk, kept, deadline: null };
  }
  if (walk.deadline !== null && input.deadlinePassed) return advanceWalk(walk, input.count, now);
  const pendingSeen = walk.pendingSeen || (walk.round > 0 && input.isPending);
  if (kept === walk.kept && pendingSeen === walk.pendingSeen && walk.deadline !== null) {
    return walk;
  }
  return {
    ...walk,
    kept,
    pendingSeen,
    deadline: walk.deadline ?? now() + SERVER_ANSWER_TIMEOUT_MS,
  };
}

function askingOrder(
  environments: ReturnType<typeof useEnvironments>["environments"],
  scheme: string,
  ownEnvironmentId: EnvironmentId | null,
): ReadonlyArray<Candidate> {
  const able = environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        (environment.serverConfig?.linkSchemes ?? []).some(
          (announced) => announced.trim().toLowerCase() === scheme,
        ),
    )
    .map((environment) => ({ environmentId: environment.environmentId, label: environment.label }));
  const own = able.find((candidate) => candidate.environmentId === ownEnvironmentId);
  const others = able
    .filter((candidate) => candidate.environmentId !== ownEnvironmentId)
    .sort(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        left.environmentId.localeCompare(right.environmentId),
    );
  return own ? [own, ...others] : others;
}

/**
 * Asks the chat's own server, then each other server announcing the scheme in label order; the
 * first that knows the link wins, and a failure or `SERVER_ANSWER_TIMEOUT_MS` of silence is a miss.
 * After a full miss the chain runs once more; a found link stays live via `resolvedLinkLiveRefresh`
 * and losing it runs the chain again.
 */
export function useResolvedLink(
  link: ResolvedLinkRef,
  ownEnvironmentId: EnvironmentId | null,
): ResolvedLinkResolution {
  const { scheme, id } = link;
  const { environments, isReady } = useEnvironments();
  const candidates = askingOrder(environments, scheme, ownEnvironmentId);
  const key = `${scheme}://${id}|${candidates.map((candidate) => candidate.environmentId).join(",")}`;
  const [walk, setWalk] = useState(() => startWalk(key, 0, 0, Date.now));
  // A walk over another server list restarts at its first server; this render is then discarded.
  const index = walk.key === key ? walk.index : 0;
  const current = candidates[index] ?? null;
  const currentEnvironmentId = current?.environmentId ?? null;
  const result = useEnvironmentQuery(
    currentEnvironmentId === null
      ? null
      : resolvedLinkLookup({ environmentId: currentEnvironmentId, input: { scheme, id } }),
  );
  const deadlinePassed = useDeadlinePassed(walk.deadline);

  const settled = result.failure !== null || result.error !== null || result.isSuccess;
  // A re-run asks each server again; the answer it held from the pass before does not count.
  const answeredThisRound =
    walk.round === 0 ||
    walk.pendingSeen ||
    (result.isSuccess && result.dataUpdatedAt > walk.startedAt);
  const answered = !result.isPending && settled && answeredThisRound;
  const data = result.isSuccess ? result.data : null;
  const unavailable = data !== null && "unavailable" in data;
  const fresh = data !== null && !unavailable ? data : null;
  // A program that cannot answer now says nothing about the link, so the target this server
  // last gave stays; before any, it counts as a miss and the next server is asked.
  const hit = fresh ?? (unavailable ? walk.kept : null);
  const next = stepWalk(
    walk,
    {
      key,
      count: candidates.length,
      answered,
      isPending: result.isPending,
      fresh,
      hit,
      deadlinePassed,
    },
    Date.now,
  );
  if (next !== walk) setWalk(next);

  const refreshQuery = useEffectEvent(() => result.refresh());
  const rerunStep =
    walk.round > 0 && currentEnvironmentId !== null ? `${walk.key}|${walk.run}|${index}` : null;
  const refreshedStep = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the query atom of a re-run's server once as the step starts, since the answer it holds is from the pass before
  useEffect(() => {
    if (rerunStep === null || refreshedStep.current === rerunStep) return;
    refreshedStep.current = rerunStep;
    refreshQuery();
  }, [rerunStep]);

  const liveKey =
    hit !== null && currentEnvironmentId !== null
      ? `${currentEnvironmentId}|${scheme}://${id}`
      : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds this chip in the shared live-refresh timer and focus listener while its server knows the link
  useEffect(() => {
    if (liveKey === null) return;
    return subscribeResolvedLinkRefresh(liveKey, () => refreshQuery());
  }, [liveKey]);

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
