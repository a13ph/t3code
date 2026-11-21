import { describe, expect, it } from "@effect/vitest";

import { isResolvedLinkId, isResolverNotePath } from "./linkResolver.ts";

describe("isResolvedLinkId", () => {
  it("takes names and paths below where the program looks", () => {
    for (const id of ["3f2b9c1e-0000-4000-8000-000000000000", "a b", "dir/a b", "v1.5 plan"]) {
      expect(isResolvedLinkId(id)).toBe(true);
    }
  });

  it("refuses ids that climb out, start at a root, or name a host or drive", () => {
    for (const id of ["../x", "a/./b", "/etc/x", "//host/share/x", "a\\b", "C:/x", "c:x"]) {
      expect(isResolvedLinkId(id)).toBe(false);
    }
  });
});

describe("isResolverNotePath", () => {
  it("takes local absolute paths", () => {
    for (const path of ["/home/u/notes/a.md", "C:\\notes\\a.md", "D:/notes/a.md"]) {
      expect(isResolverNotePath(path)).toBe(true);
    }
  });

  it("refuses relative, network and device paths", () => {
    for (const path of [
      "notes/a.md",
      "//host/share/a.md",
      "\\\\host\\share\\a.md",
      "\\\\?\\C:\\a",
    ]) {
      expect(isResolverNotePath(path)).toBe(false);
    }
  });
});
