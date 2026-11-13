import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH } from "@t3tools/contracts";

type AssistantCitationCommentDismissal =
  | { kind: "commit"; comment: string }
  | { kind: "close" }
  | { kind: "keep-open" }
  | { kind: "discard" };

/**
 * `discardIfEmpty` is set when a press on assistant text starts the next citation while this
 * fresh one is open; without a comment the fresh citation is dropped instead of kept.
 */
export function resolveAssistantCitationCommentDismissal({
  reason,
  draft,
  savedComment,
  discardIfEmpty = false,
}: {
  reason: string;
  draft: string | null;
  savedComment: string | undefined;
  discardIfEmpty?: boolean;
}): AssistantCitationCommentDismissal {
  if (discardIfEmpty && (draft ?? savedComment ?? "").trim() === "") return { kind: "discard" };
  if (reason === "escape-key" || draft === null) return { kind: "close" };
  if (draft.trim() === (savedComment ?? "").trim()) return { kind: "close" };
  if (draft.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH) return { kind: "keep-open" };
  return { kind: "commit", comment: draft };
}
