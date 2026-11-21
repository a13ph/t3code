import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Web-only: a resolved link in chat asks a connected server what it names. The short stale time
 * lets a renamed target show its new label the next time the chip mounts.
 */
export const resolvedLinkLookup = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:links:resolve",
  tag: WS_METHODS.linksResolve,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});
