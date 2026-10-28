import { EDITORS, type EditorId } from "@t3tools/contracts";

import { getLocalFileManagerName } from "~/lib/utils";
import { isOpenInAppId, openInAppLabel, type OpenInTargetId } from "~/openInApps";

const editorLabels = new Map<EditorId, string>(EDITORS.map((editor) => [editor.id, editor.label]));

export function editorLabelForPlatform(editorId: OpenInTargetId, platform: string): string {
  if (isOpenInAppId(editorId)) {
    return openInAppLabel(editorId);
  }
  if (editorId === "file-manager") {
    return getLocalFileManagerName(platform);
  }

  return editorLabels.get(editorId) ?? "Editor";
}

export function openInEditorMenuLabel(editorId: EditorId | null): string {
  return editorId === null || editorId === "file-manager"
    ? "Open in editor"
    : `Open in ${editorLabels.get(editorId) ?? "Editor"}`;
}
