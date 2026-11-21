import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveAssistantCitationCommentDismissal } from "./assistantCitationCommentDismissal";

describe("resolveAssistantCitationCommentDismissal", () => {
  it("commits typed text when the popover is dismissed by clicking away", () => {
    expect(
      resolveAssistantCitationCommentDismissal({
        reason: "outside-press",
        draft: "needs a retry",
        savedComment: undefined,
      }),
    ).toEqual({ kind: "commit", comment: "needs a retry" });
  });

  it("commits an edited comment when focus leaves the popover", () => {
    expect(
      resolveAssistantCitationCommentDismissal({
        reason: "focus-out",
        draft: "second thought",
        savedComment: "first thought",
      }),
    ).toEqual({ kind: "commit", comment: "second thought" });
  });

  it("drops a fresh citation left without a comment when the next one starts", () => {
    for (const draft of [null, "", "  "]) {
      expect(
        resolveAssistantCitationCommentDismissal({
          reason: "outside-press",
          draft,
          savedComment: undefined,
          discardIfEmpty: true,
        }),
      ).toEqual({ kind: "discard" });
    }
  });

  it("keeps a commented citation when the next one starts", () => {
    expect(
      resolveAssistantCitationCommentDismissal({
        reason: "outside-press",
        draft: "wrong file",
        savedComment: undefined,
        discardIfEmpty: true,
      }),
    ).toEqual({ kind: "commit", comment: "wrong file" });
  });

  it("keeps an uncommented citation when the press does not start the next one", () => {
    expect(
      resolveAssistantCitationCommentDismissal({
        reason: "outside-press",
        draft: null,
        savedComment: undefined,
      }),
    ).toEqual({ kind: "close" });
  });

  it("keeps the popover open instead of dropping an over-length draft", () => {
    expect(
      resolveAssistantCitationCommentDismissal({
        reason: "outside-press",
        draft: "x".repeat(ASSISTANT_CITATION_MAX_COMMENT_LENGTH + 1),
        savedComment: undefined,
      }),
    ).toEqual({ kind: "keep-open" });
  });
});
