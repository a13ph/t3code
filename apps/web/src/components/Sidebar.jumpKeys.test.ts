import { describe, expect, it } from "vite-plus/test";

import { buildThreadJumpNumbers, resolveLastQueueThreadKey } from "./Sidebar.logic";

describe("buildThreadJumpNumbers", () => {
  it("numbers the first nine rows that have a jump shortcut", () => {
    const keys = Array.from({ length: 11 }, (_, index) => `t${index + 1}`);
    const labels = new Map(keys.slice(0, 9).map((key, index) => [key, `Alt+${index + 1}`]));
    labels.delete("t4");
    const numbers = buildThreadJumpNumbers(keys, labels);
    expect(numbers.get("t1")).toBe("1");
    expect(numbers.get("t4")).toBeUndefined();
    expect(numbers.get("t9")).toBe("9");
    expect(numbers.has("t10")).toBe(false);
  });
});

describe("resolveLastQueueThreadKey", () => {
  it("opens the bottom card and never the thread being left", () => {
    expect(
      resolveLastQueueThreadKey({ queueThreadKeys: ["a", "b", "c"], leavingThreadKey: "a" }),
    ).toBe("c");
    expect(
      resolveLastQueueThreadKey({ queueThreadKeys: ["a", "b", "c"], leavingThreadKey: "c" }),
    ).toBe("b");
    expect(resolveLastQueueThreadKey({ queueThreadKeys: ["c"], leavingThreadKey: "c" })).toBeNull();
    expect(resolveLastQueueThreadKey({ queueThreadKeys: [], leavingThreadKey: null })).toBeNull();
  });
});
