import { createLinkResolverEnvironmentAtoms } from "@t3tools/client-runtime/state/link-resolver";

import { connectionAtomRuntime } from "../connection/runtime";

const linkResolverAtoms = createLinkResolverEnvironmentAtoms(connectionAtomRuntime);

/** What a link names, asked of one connected server. */
export const resolvedLinkLookup = linkResolverAtoms.resolve;

/** The notes that link to a note, asked of the server holding it. */
export const linkBacklinksLookup = linkResolverAtoms.backlinks;
