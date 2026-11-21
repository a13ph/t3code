import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Queries a server's link resolvers: what a link names, and which notes link to a note. The short
 * stale time lets a renamed target or a changed status show the next time a link mounts.
 */
export function createLinkResolverEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    resolve: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:links:resolve",
      tag: WS_METHODS.linksResolve,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    backlinks: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:links:backlinks",
      tag: WS_METHODS.linksBacklinks,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
  };
}
