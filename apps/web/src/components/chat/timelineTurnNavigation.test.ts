import { describe, expect, it } from "vite-plus/test";

import {
  resolveTimelineTurnNavigationIndex,
  timelineTurnNavigationFromCommand,
} from "./MessagesTimeline.logic";

describe("resolveTimelineTurnNavigationIndex", () => {
  it("steps from the turn at the reader's position and clamps at the ends", () => {
    const at = (currentIndex: number | null, direction: "first" | "previous" | "next" | "last") =>
      resolveTimelineTurnNavigationIndex({ itemCount: 4, currentIndex, direction });
    expect(at(2, "previous")).toBe(1);
    expect(at(2, "next")).toBe(3);
    expect(at(0, "previous")).toBe(0);
    expect(at(3, "next")).toBe(3);
    expect(at(2, "first")).toBe(0);
    expect(at(1, "last")).toBe(3);
  });

  it("starts from the end when no turn is current, and has nothing to do in an empty thread", () => {
    expect(
      resolveTimelineTurnNavigationIndex({
        itemCount: 3,
        currentIndex: null,
        direction: "previous",
      }),
    ).toBe(2);
    expect(
      resolveTimelineTurnNavigationIndex({ itemCount: 0, currentIndex: null, direction: "first" }),
    ).toBeNull();
  });

  it("maps only the turn commands", () => {
    expect(timelineTurnNavigationFromCommand("chat.turn.previous")).toBe("previous");
    expect(timelineTurnNavigationFromCommand("chat.turn.last")).toBe("last");
    expect(timelineTurnNavigationFromCommand("thread.previous")).toBeNull();
    expect(timelineTurnNavigationFromCommand(null)).toBeNull();
  });
});
