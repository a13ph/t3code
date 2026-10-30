/**
 * Open-in apps that are not editors the server can launch: Neovim and
 * Obsidian. Every open, on a local or a remote thread, goes out as a
 * `zed://ssh/<host><path>?app=<id>[&line=<n>][&thread=<id>]` link through
 * the desktop shell, whose external-URL allowlist already passes Zed's SSH
 * shape. The desktop shell hands the link to whatever handles `zed://` on the
 * client; this repo ships no handler. A handler reads `app` to pick the
 * program and may use `thread` to tie the open to its thread. These ids stay
 * out of the contracts' EDITORS list so the server never probes for them or
 * advertises them.
 */
import { EditorId, buildRemoteOpenUrl } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { RemoteOpenMode, RemoteOpenState } from "./remoteOpen";

export const OPEN_IN_APPS = [
  { id: "nvim", label: "Neovim" },
  { id: "obsidian", label: "Obsidian" },
] as const;

export type OpenInAppId = (typeof OPEN_IN_APPS)[number]["id"];
export const OPEN_IN_APP_IDS: ReadonlyArray<OpenInAppId> = OPEN_IN_APPS.map((app) => app.id);

export const OpenInAppIdSchema = Schema.Literals(OPEN_IN_APP_IDS);
/** A stock editor or one of the link-only apps above. */
export const OpenInTargetId = Schema.Union([EditorId, OpenInAppIdSchema]);
export type OpenInTargetId = EditorId | OpenInAppId;

export function isOpenInAppId(id: string | null | undefined): id is OpenInAppId {
  return id !== null && id !== undefined && (OPEN_IN_APP_IDS as ReadonlyArray<string>).includes(id);
}

export function openInAppLabel(id: OpenInAppId): string {
  return OPEN_IN_APPS.find((app) => app.id === id)?.label ?? id;
}

/** Host segment for a client on the thread's own server. */
export const LOCAL_OPEN_HOST = "local";

const WINDOWS_DRIVE_SEGMENT = /^[A-Za-z]:$/;

/**
 * Builds the link for an app open. `host` is the thread environment's ssh
 * host, or null when this client runs on the thread's server. The path is
 * rooted and percent-encoded per segment; a Windows drive stays as `/C:/...`.
 */
export function buildOpenInAppUrl(input: {
  readonly app: OpenInAppId;
  readonly host: string | null;
  readonly absolutePath: string;
  readonly line?: number | undefined;
  readonly threadId?: string | null | undefined;
}): string {
  const posixPath = input.absolutePath.replaceAll("\\", "/");
  const rootedPath = posixPath.startsWith("/") ? posixPath : `/${posixPath}`;
  const encodedPath = rootedPath
    .split("/")
    .map((segment, index) =>
      index === 1 && WINDOWS_DRIVE_SEGMENT.test(segment) ? segment : encodeURIComponent(segment),
    )
    .join("/");
  const host = input.host === null || input.host.length === 0 ? LOCAL_OPEN_HOST : input.host;
  const params = new URLSearchParams({ app: input.app });
  if (input.line !== undefined && Number.isInteger(input.line) && input.line > 0) {
    params.set("line", String(input.line));
  }
  if (input.threadId) {
    params.set("thread", input.threadId);
  }
  return `zed://ssh/${encodeURIComponent(host)}${encodedPath}?${params.toString()}`;
}

/** The host an app link names for a thread, or undefined when none exists. */
export function openInAppHost(state: RemoteOpenState): string | null | undefined {
  if (state.mode === "local-exec") return null;
  if (state.mode === "remote-links") return state.host.host;
  return undefined;
}

/** True when the app entries can be offered: only the desktop shell can pass the link on. */
export function canOfferOpenInApps(): boolean {
  return typeof window !== "undefined" && window.desktopBridge !== undefined;
}

export type ChipOpenTarget = OpenInAppId | "vscodium";

/**
 * "Open in <app>" items on a file chip's context menu. Offered on the desktop
 * for local and remote threads alike, once the thread's open mode is known
 * and it has a route; the path must be absolute to name a file over ssh.
 * VSCodium on a local thread is launched by the server, so it needs the
 * server's PATH probe and the right to operate the host.
 */
export function resolveChipOpenTargets(input: {
  readonly isDesktop: boolean;
  readonly isRemoteOpenResolved: boolean;
  readonly remoteOpenMode: RemoteOpenMode;
  readonly canUseShellActions: boolean;
  readonly availableEditors: ReadonlyArray<EditorId>;
}): ReadonlyArray<ChipOpenTarget> {
  if (!input.isDesktop || !input.isRemoteOpenResolved) return [];
  if (input.remoteOpenMode === "remote-unavailable") return [];
  const vscodium =
    input.remoteOpenMode === "remote-links" ||
    (input.canUseShellActions && input.availableEditors.includes("vscodium"));
  return [...OPEN_IN_APP_IDS, ...(vscodium ? (["vscodium"] as const) : [])];
}

export function chipOpenTargetLabel(target: ChipOpenTarget): string {
  return target === "vscodium" ? "VSCodium" : openInAppLabel(target);
}

/** Link for a chip open in a remote thread; local VSCodium goes to the server. */
export function buildChipOpenUrl(input: {
  readonly target: ChipOpenTarget;
  readonly state: RemoteOpenState;
  readonly absolutePath: string;
  readonly line?: number | undefined;
  readonly threadId?: string | null | undefined;
}): string | undefined {
  const host = openInAppHost(input.state);
  if (host === undefined) return undefined;
  if (input.target === "vscodium") {
    return host === null
      ? undefined
      : buildRemoteOpenUrl({ editor: "vscodium", host, absolutePath: input.absolutePath });
  }
  return buildOpenInAppUrl({
    app: input.target,
    host,
    absolutePath: input.absolutePath,
    line: input.line,
    threadId: input.threadId,
  });
}
