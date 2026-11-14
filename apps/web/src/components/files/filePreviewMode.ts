import type { AssetResource, ProjectReadFileError, ScopedThreadRef } from "@t3tools/contracts";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import { isHostPath, workspaceRelativeFilePath } from "@t3tools/shared/path";

export function resolveFilePreviewPath(path: string | null, cwd: string): string | null {
  if (path === null) return null;
  return path === "." || workspaceRelativeFilePath(path, cwd) === "." ? null : path;
}

export const isMarkdownPreviewFile = (path: string): boolean =>
  /\.(?:md|mdx|markdown|mdown|mkd)$/i.test(path);

const TEXT_ENTRY = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/**
 * The tab history step of a key: Alt+Left back, Alt+Right forward, as in a browser. In a text
 * field or an editor those keys move the cursor by word, so there, or once the editor took the
 * key, they step nothing.
 */
export function fileHistoryStepOfKey(event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly key: string;
  readonly defaultPrevented: boolean;
  readonly target: unknown;
}): -1 | 1 | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.defaultPrevented) return null;
  const target = event.target as { closest?: (selector: string) => unknown } | null;
  if (typeof target?.closest === "function" && target.closest(TEXT_ENTRY) !== null) return null;
  if (event.key === "ArrowLeft") return -1;
  if (event.key === "ArrowRight") return 1;
  return null;
}

export function filePreviewReadErrorMessage(error: ProjectReadFileError): string {
  switch (error.failure) {
    case "path_not_file":
      return "The path is a directory or special file, not a regular file.";
    case "binary_file":
      return "The file is binary and cannot be displayed as text.";
    case "workspace_path_outside_root":
      return "The requested path is outside the workspace.";
    case "resolved_path_outside_root":
      return "The path resolves to a location outside the workspace.";
    case "operation_failed":
      return error.operation === "realpath-workspace-root"
        ? "The workspace folder could not be accessed."
        : "The file could not be accessed or read. It may be missing or inaccessible.";
    default:
      return error.message;
  }
}

export function shouldShowFileExplorer(input: {
  readonly relativePath: string | null;
  readonly explorerOpen: boolean;
  readonly attachmentOpen: boolean;
}): boolean {
  if (input.attachmentOpen || (input.relativePath && isHostPath(input.relativePath))) {
    return false;
  }
  return input.explorerOpen || input.relativePath === null;
}

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}

/**
 * The server only signs `workspace-file` assets below the workspace root, so a
 * file opened from outside it, such as an absolute link in the thread, goes
 * through the host `media-file` resource the direct media viewer uses.
 */
export function workspaceAssetResource(input: {
  readonly kind: "workspace-file" | "media-file";
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly workspaceRoot: string;
  readonly absolutePath: string;
}): AssetResource {
  if (input.draft) {
    return { _tag: "draft-workspace-file", cwd: input.workspaceRoot, path: input.absolutePath };
  }
  const insideWorkspace =
    mediaFileReference(input.absolutePath, input.workspaceRoot).relativePath !== undefined;
  return {
    _tag: insideWorkspace ? input.kind : "media-file",
    threadId: input.threadRef.threadId,
    path: input.absolutePath,
  };
}
