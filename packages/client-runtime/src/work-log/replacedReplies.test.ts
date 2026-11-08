import { describe, expect, it } from "vite-plus/test";

import { type ReplyTimelineStep, replacedReplyIds } from "./replacedReplies.js";

const reply = (id: string, text: string): ReplyTimelineStep => ({ kind: "reply", id, text });
const reasoning: ReplyTimelineStep = { kind: "reasoning" };
const refused: ReplyTimelineStep = { kind: "refused-question" };
const other: ReplyTimelineStep = { kind: "other" };

describe("replacedReplyIds", () => {
  it("marks the lead-in of a refused question, across reasoning", () => {
    expect([
      ...replacedReplyIds([reply("a", "Report"), reasoning, refused, reply("b", "Report again")]),
    ]).toEqual(["a"]);
  });

  it("keeps a reply that other work follows before the refused question", () => {
    expect(replacedReplyIds([reply("a", "Report"), other, refused, reply("b", "x")]).size).toBe(0);
  });

  it("marks an earlier reply whose first line a later reply repeats", () => {
    expect([
      ...replacedReplyIds([
        reply("a", "\n  TL;DR: done  \nold body"),
        other,
        reply("b", "Something else"),
        reply("c", "TL;DR: done\nnew body"),
      ]),
    ]).toEqual(["a"]);
  });

  it("never marks the last reply", () => {
    expect(replacedReplyIds([reply("a", "Report"), refused]).size).toBe(0);
  });
});
