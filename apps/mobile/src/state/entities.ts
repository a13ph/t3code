import { useAtomValue } from "@effect/atom-react";
import { deriveReportedModelSelection } from "@t3tools/client-runtime/state/thread-execution";

import { appAtomRegistry } from "./atom-registry";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ScopedProjectRef,
  ScopedThreadRef,
  ServerConfig,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  hasThreadLinks,
  percentDecodedThreadLinkId,
  relabelThreadLinks,
} from "@t3tools/shared/threadLinks";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { environmentShell } from "./shell";
import { environmentThreadDetails, environmentThreadShells } from "./threads";

const EMPTY_PROJECT_ATOM = Atom.make<EnvironmentProject | null>(null).pipe(
  Atom.withLabel("mobile-project:empty"),
);
const EMPTY_THREAD_SHELL_ATOM = Atom.make<EnvironmentThreadShell | null>(null).pipe(
  Atom.withLabel("mobile-thread-shell:empty"),
);
const EMPTY_SERVER_CONFIG_ATOM = Atom.make<ServerConfig | null>(null).pipe(
  Atom.withLabel("mobile-server-config:empty"),
);
const EMPTY_THREAD_ATOM = Atom.make<EnvironmentThread | null>(null).pipe(
  Atom.withLabel("mobile-thread:empty"),
);
const EMPTY_THREAD_TITLES: ReadonlyMap<ThreadId, string> = new Map();
const EMPTY_THREAD_TITLES_ATOM = Atom.make(EMPTY_THREAD_TITLES).pipe(
  Atom.withLabel("mobile-thread-titles:empty"),
);

/**
 * Thread titles in one environment, then in every other connected environment for ids it
 * does not hold. Emits when a title changes, not on every shell update.
 */
const threadTitlesAtom = Atom.family((environmentId: EnvironmentId) => {
  let previous = EMPTY_THREAD_TITLES;
  return Atom.make((get) => {
    const next = new Map<ThreadId, string>();
    for (const shell of get(environmentThreadShells.threadShellsAtom)) {
      if (shell.environmentId !== environmentId) next.set(shell.id, shell.title);
    }
    for (const [threadId, shell] of get(
      environmentThreadShells.environmentThreadIndexAtom(environmentId),
    )) {
      next.set(threadId, shell.title);
    }
    const unchanged =
      next.size === previous.size &&
      Array.from(next).every(([threadId, title]) => previous.get(threadId) === title);
    if (!unchanged) previous = next;
    return previous;
  }).pipe(Atom.withLabel(`mobile-thread-titles:${environmentId}`));
});

/**
 * The thread a link in `environmentId` opens: the id as written or its percent-decoded form,
 * in that environment when it holds the thread, else in whichever other connected environment
 * does. Thread ids are UUIDs, so a match elsewhere is this thread. Looks elsewhere only once
 * the own environment is live, so a link to a local thread never points away while the local
 * index loads. Reads the shell state the open thread route keeps mounted.
 */
export function resolveThreadLink(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ScopedThreadRef {
  const decodedId = percentDecodedThreadLinkId(threadId);
  const own = appAtomRegistry.get(
    environmentThreadShells.environmentThreadIndexAtom(environmentId),
  );
  if (own.has(threadId)) return scopeThreadRef(environmentId, threadId);
  if (decodedId !== null && own.has(decodedId)) return scopeThreadRef(environmentId, decodedId);
  if (appAtomRegistry.get(environmentShell.stateValueAtom(environmentId)).status === "live") {
    const elsewhere = appAtomRegistry
      .get(environmentThreadShells.threadRefsAtom)
      .find((ref) => ref.threadId === threadId || ref.threadId === decodedId);
    if (elsewhere) return elsewhere;
  }
  return scopeThreadRef(environmentId, threadId);
}

/** Resolves when the project event reaches the live client store. */
export function waitForProject(
  ref: ScopedProjectRef,
  timeoutMs = 10_000,
): Promise<EnvironmentProject | null> {
  const atom = environmentProjects.projectAtom(ref);
  const current = appAtomRegistry.get(atom);
  if (current !== null) return Promise.resolve(current);
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      resolve(null);
    }, timeoutMs);
    const finish = (project: EnvironmentProject | null) => {
      if (project === null) return;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(project);
    };
    unsubscribe = appAtomRegistry.subscribe(atom, finish);
    finish(appAtomRegistry.get(atom));
  });
}

export function useProjects(): ReadonlyArray<EnvironmentProject> {
  return useAtomValue(environmentProjects.projectsAtom);
}

export function useThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(environmentThreadShells.threadShellsAtom);
}

export function useNavigationThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(environmentThreadShells.navigationThreadShellsAtom);
}

export function useProject(ref: ScopedProjectRef | null): EnvironmentProject | null {
  return useAtomValue(ref === null ? EMPTY_PROJECT_ATOM : environmentProjects.projectAtom(ref));
}

export function useThreadShell(ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_SHELL_ATOM : environmentThreadShells.threadShellAtom(ref),
  );
}

export function useChildThreadInputs(ref: ScopedThreadRef) {
  return useAtomValue(environmentThreadShells.childThreadInputsAtom(ref));
}

/** `markdown` with each thread link labeled by the thread's current title, `environmentId` first. */
export function useLiveThreadLinkLabels(markdown: string, environmentId: EnvironmentId): string {
  const titles = useAtomValue(
    hasThreadLinks(markdown) ? threadTitlesAtom(environmentId) : EMPTY_THREAD_TITLES_ATOM,
  );
  return useMemo(
    () =>
      titles.size === 0
        ? markdown
        : relabelThreadLinks(markdown, (threadId) => titles.get(threadId)),
    [markdown, titles],
  );
}

export function useEnvironmentServerConfig(
  environmentId: EnvironmentId | null,
): ServerConfig | null {
  return useAtomValue(
    environmentId === null
      ? EMPTY_SERVER_CONFIG_ATOM
      : serverEnvironment.configValueAtom(environmentId),
  );
}

export function useServerConfigs(): ReadonlyMap<EnvironmentId, ServerConfig> {
  return useAtomValue(environmentServerConfigsAtom);
}

const selectReportedModelSelection = (thread: EnvironmentThread | null) =>
  thread === null ? null : deriveReportedModelSelection(thread.projection);

export function useThreadReportedModelSelection(ref: ScopedThreadRef | null) {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_ATOM : environmentThreadDetails.threadAtom(ref),
    selectReportedModelSelection,
  );
}
