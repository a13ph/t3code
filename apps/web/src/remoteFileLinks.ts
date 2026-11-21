import { splitFilePathPosition } from "@t3tools/shared/fileLinks";

/**
 * A chat link to a file on another server the client is connected to. Two forms:
 *
 * - `<server>:<absolute path>`, as in `alpha:/home/user/docs.md` or `beta:C:/user/docs.md`.
 *   The server is named by the client's label for the connection or by the server's own label.
 * - `remote-file://v1/<environmentId>/<absolute path>`, naming the server by its environment id.
 *
 * Either may end in `:line` or `:line:column`. The path is absolute on the named server, so it is
 * read there as a host file, never as a path inside the message's workspace.
 */
export interface RemoteFileLink {
  /** The server as written: a label, or an environment id for the `remote-file` form. */
  readonly server: string;
  readonly byEnvironmentId: boolean;
  /** Absolute on that server, without the position suffix. */
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

// Not `t3-file`: upstream may take that name, and a link of theirs must never
// be read as this fork's.
export const REMOTE_FILE_LINK_PROTOCOL = "remote-file";
const REMOTE_FILE_LINK_PREFIX = `${REMOTE_FILE_LINK_PROTOCOL}://v1/`;

// Two characters at least, so a Windows drive (`C:/user`) never reads as a server name.
const SERVER_PATH = /^(?<server>[A-Za-z0-9][A-Za-z0-9._-]+):(?<path>\/(?!\/)[^\n]*|[A-Za-z]:[/\\][^\n]*)$/;
// Schemes whose `name:/path` shape would otherwise pass for a server and a path.
const NOT_A_SERVER = new Set(["file", "http", "https", "ftp", "mailto", "data", "blob", "about"]);

function decodePath(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

function withPosition(
  server: string,
  byEnvironmentId: boolean,
  rawPath: string,
): RemoteFileLink | null {
  const decoded = decodePath(rawPath);
  if (decoded === null) return null;
  const { path, line, column } = splitFilePathPosition(decoded);
  if (path.length <= 1) return null;
  return {
    server,
    byEnvironmentId,
    path,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

export function parseRemoteFileHref(href: string | undefined | null): RemoteFileLink | null {
  if (!href) return null;
  const trimmed = href.trim().replace(/^<(.*)>$/, "$1");
  if (trimmed.startsWith(REMOTE_FILE_LINK_PREFIX)) {
    const rest = trimmed.slice(REMOTE_FILE_LINK_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    const environmentId = rest.slice(0, slash);
    // `/C:/user/x` is a Windows path written after the id's slash.
    const path = rest.slice(slash).replace(/^\/(?=[A-Za-z]:[/\\])/, "");
    return withPosition(environmentId, true, path);
  }
  const match = SERVER_PATH.exec(trimmed);
  const server = match?.groups?.server;
  const path = match?.groups?.path;
  if (!server || !path || NOT_A_SERVER.has(server.toLowerCase())) return null;
  return withPosition(server, false, path);
}

export interface RemoteFileServerCandidate {
  readonly environmentId: string;
  /** The client's name for the connection. */
  readonly label: string;
  /** The server's own name for itself, when the client has its config. */
  readonly serverLabel: string | null;
}

export type RemoteFileServerResolution =
  | { readonly _tag: "found"; readonly environmentId: string; readonly label: string }
  | { readonly _tag: "ambiguous"; readonly labels: ReadonlyArray<string> }
  | { readonly _tag: "missing" };

const firstDnsLabel = (name: string) => name.split(".", 1)[0] ?? name;

/**
 * Finds the server a link names. An environment id matches exactly. A name matches, without
 * case, the client's label first, then the server's own label, then the first DNS label of
 * either; the first rule with exactly one match wins, and two matches under one rule are
 * ambiguous rather than a guess.
 */
export function resolveRemoteFileServer(
  link: Pick<RemoteFileLink, "server" | "byEnvironmentId">,
  candidates: ReadonlyArray<RemoteFileServerCandidate>,
): RemoteFileServerResolution {
  if (link.byEnvironmentId) {
    const found = candidates.find((candidate) => candidate.environmentId === link.server);
    return found
      ? { _tag: "found", environmentId: found.environmentId, label: found.label }
      : { _tag: "missing" };
  }
  const wanted = link.server.toLowerCase();
  const rules: ReadonlyArray<(candidate: RemoteFileServerCandidate) => boolean> = [
    (candidate) => candidate.label.toLowerCase() === wanted,
    (candidate) => candidate.serverLabel?.toLowerCase() === wanted,
    (candidate) =>
      firstDnsLabel(candidate.label.toLowerCase()) === wanted ||
      (candidate.serverLabel !== null &&
        firstDnsLabel(candidate.serverLabel.toLowerCase()) === wanted),
  ];
  for (const rule of rules) {
    const matches = candidates.filter(rule);
    const [only] = matches;
    if (matches.length === 1 && only) {
      return { _tag: "found", environmentId: only.environmentId, label: only.label };
    }
    if (matches.length > 1) {
      return { _tag: "ambiguous", labels: matches.map((candidate) => candidate.label) };
    }
  }
  return { _tag: "missing" };
}
