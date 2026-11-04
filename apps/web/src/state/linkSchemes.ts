import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { linkSchemesOf } from "../resolvedLinks";
import { environmentPresentations } from "./presentation";

// A joined string, so a config snapshot that changes nothing here re-renders nothing.
const linkSchemesKeyAtom = Atom.make((get) =>
  linkSchemesOf(get(environmentPresentations.serverConfigsAtom).values()).join(","),
).pipe(Atom.withLabel("link-schemes"));

/** Every link scheme some connected server resolves. */
export function useLinkSchemes(): ReadonlySet<string> {
  const key = useAtomValue(linkSchemesKeyAtom);
  return useMemo(() => new Set(key === "" ? [] : key.split(",")), [key]);
}
