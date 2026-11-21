import { EDITORS, type EditorId } from "@t3tools/contracts";

import { getLocalFileManagerName } from "~/lib/utils";
import { msg } from "gt-react";

import { m, type MessageResolver } from "./i18n/messages";
import { isOpenInAppId, openInAppLabel, type OpenInTargetId } from "~/openInApps";

const editorLabels = new Map<EditorId, string>(EDITORS.map((editor) => [editor.id, editor.label]));

export function editorLabelForPlatform(
  editorId: OpenInTargetId,
  platform: string,
  resolve: MessageResolver = m,
): string {
  if (isOpenInAppId(editorId)) {
    return openInAppLabel(editorId);
  }
  if (editorId === "file-manager") {
    return getLocalFileManagerName(platform, resolve);
  }

  return (
    editorLabels.get(editorId) ?? resolve(msg("Editor", { $context: "noun, a code editor app" }))
  );
}

export function openInEditorMenuLabel(
  editorId: EditorId | null,
  resolve: MessageResolver = m,
): string {
  return editorId === null || editorId === "file-manager"
    ? resolve(msg("Open in editor"))
    : resolve(
        msg("Open in {editor}", {
          editor:
            editorLabels.get(editorId) ??
            resolve(msg("Editor", { $context: "noun, a code editor app" })),
        }),
      );
}
