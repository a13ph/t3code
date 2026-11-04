import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decodeLinkResolvers } from "../cli/config.ts";

describe("decodeLinkResolvers", () => {
  it.effect("reads a scheme to argv map", () =>
    Effect.gen(function* () {
      const resolvers = yield* decodeLinkResolvers(
        '{"notes": ["python", "-X", "utf8", "/opt/resolve"], "x-y.z": ["prog"]}',
      );
      expect(resolvers).toEqual({
        notes: ["python", "-X", "utf8", "/opt/resolve"],
        "x-y.z": ["prog"],
      });
    }),
  );

  it.effect("is unset when the variable is unset or blank", () =>
    Effect.gen(function* () {
      expect(yield* decodeLinkResolvers(undefined)).toBeUndefined();
      expect(yield* decodeLinkResolvers("  ")).toBeUndefined();
    }),
  );

  it.effect("ignores a bad value instead of failing the start", () =>
    Effect.gen(function* () {
      for (const raw of [
        "not json",
        '["prog"]',
        '{"Notes": ["prog"]}',
        '{"1notes": ["prog"]}',
        '{"notes": []}',
        '{"notes": [""]}',
        '{"notes": [" ", "arg"]}',
        '{"notes": "prog"}',
      ]) {
        expect(yield* decodeLinkResolvers(raw)).toBeUndefined();
      }
    }),
  );
});
