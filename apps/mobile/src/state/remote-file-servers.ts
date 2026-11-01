import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import type { RemoteFileServerCandidate } from "../lib/remoteFileLinks";
import { environmentServerConfigsAtom } from "./server";
import { useWorkspaceEnvironments } from "./workspace";

/** Every switched-on connection, by this client's name for it and by the server's own. */
export function useRemoteFileServers(): ReadonlyArray<RemoteFileServerCandidate> {
  const environments = useWorkspaceEnvironments();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  return useMemo(
    () =>
      environments
        .filter((environment) => environment.isEnabled)
        .map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.environmentLabel,
          serverLabel: serverConfigs.get(environment.environmentId)?.environment.label ?? null,
        })),
    [environments, serverConfigs],
  );
}
