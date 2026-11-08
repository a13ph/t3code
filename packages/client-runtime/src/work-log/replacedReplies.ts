import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

import {
  type WorkLogPresentationEntry,
  workEntryDisplayIndicatesToolFailure,
} from "./presentation.js";

export type ReplyTimelineStep =
  | { readonly kind: "reply"; readonly id: string; readonly text: string }
  | { readonly kind: "reasoning" }
  | { readonly kind: "refused-question" }
  | { readonly kind: "other" };

export function workEntryReplyStep(
  entry: WorkLogPresentationEntry,
  item: OrchestrationV2TurnItem | undefined,
): ReplyTimelineStep {
  if (entry.itemType === "reasoning") return { kind: "reasoning" };
  if (
    item?.type === "dynamic_tool" &&
    item.toolName === "AskUserQuestion" &&
    workEntryDisplayIndicatesToolFailure(entry)
  ) {
    return { kind: "refused-question" };
  }
  return { kind: "other" };
}

export function firstLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return null;
}

/**
 * Replies of one settled turn that the agent wrote again: the lead-in of a
 * refused question, or a reply a Stop hook made it resend with the same first
 * line. The turn's last reply is never replaced.
 */
export function replacedReplyIds(steps: ReadonlyArray<ReplyTimelineStep>): ReadonlySet<string> {
  const replaced = new Set<string>();
  const lastReplyIndex = steps.findLastIndex((step) => step.kind === "reply");
  const laterFirstLines = new Set<string>();
  let nextNonReasoning: ReplyTimelineStep | undefined;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (step.kind === "reply") {
      const line = firstLine(step.text);
      if (
        index !== lastReplyIndex &&
        (nextNonReasoning?.kind === "refused-question" ||
          (line !== null && laterFirstLines.has(line)))
      ) {
        replaced.add(step.id);
      }
      if (line !== null) laterFirstLines.add(line);
    }
    if (step.kind !== "reasoning") nextNonReasoning = step;
  }
  return replaced;
}
