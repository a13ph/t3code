import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import type { RemoteFileServerCandidate } from "../lib/remoteFileLinks";
import { environmentServerConfigsAtom } from "./server";
import { useWorkspaceEnvironments } from "./workspace";

/**
 * Every switched-on connection, by this client's name for it and by the server's own. The list
 * keeps its identity until a name changes: server configs change on every provider status
 * event, and each message's markdown is rebuilt when this list changes.
 */
export function useRemoteFileServers(): ReadonlyArray<RemoteFileServerCandidate> {
  const environments = useWorkspaceEnvironments();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const key = JSON.stringify(
    environments
      .filter((environment) => environment.isEnabled)
      .map((environment) => [
        environment.environmentId,
        environment.environmentLabel,
        serverConfigs.get(environment.environmentId)?.environment.label ?? null,
      ]),
  );
  return useMemo(
    () =>
      (JSON.parse(key) as Array<[string, string, string | null]>).map(
        ([environmentId, label, serverLabel]) => ({ environmentId, label, serverLabel }),
      ),
    [key],
  );
}
