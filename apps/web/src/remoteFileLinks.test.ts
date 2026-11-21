import { describe, expect, it } from "vite-plus/test";

import { parseRemoteFileHref, resolveRemoteFileServer } from "./remoteFileLinks";

describe("parseRemoteFileHref", () => {
  it("reads a server name and a POSIX path", () => {
    expect(parseRemoteFileHref("alpha:/home/user/docs.md")).toEqual({
      server: "alpha",
      byEnvironmentId: false,
      path: "/home/user/docs.md",
    });
  });

  it("reads a Windows path after a server name", () => {
    expect(parseRemoteFileHref("beta:C:/user/docs/x.md")?.path).toBe(
      "C:/user/docs/x.md",
    );
  });

  it("keeps spaces, decodes escapes and splits a line suffix", () => {
    expect(parseRemoteFileHref("<host-a:/home/user/a%20b c.md:12>")).toEqual({
      server: "host-a",
      byEnvironmentId: false,
      path: "/home/user/a b c.md",
      line: 12,
    });
  });

  it("reads the t3-file form with either path style", () => {
    expect(parseRemoteFileHref("t3-file://v1/env-1/home/user/x.md")).toEqual({
      server: "env-1",
      byEnvironmentId: true,
      path: "/home/user/x.md",
    });
    expect(parseRemoteFileHref("t3-file://v1/env-1/C:/user/x.md")?.path).toBe("C:/user/x.md");
  });

  it("leaves drive paths, URLs and relative refs alone", () => {
    for (const href of [
      "C:/user/x.md",
      "C:\\Users\\x.md",
      "https://example.com/x",
      "http:/x",
      "file:///home/user/x.md",
      "origin/main",
      "alpha:relative/path",
      "host://authority/x",
      "/home/user/x.md",
      "t3-file://v1/",
    ]) {
      expect(parseRemoteFileHref(href), href).toBeNull();
    }
  });
});

describe("resolveRemoteFileServer", () => {
  const candidates = [
    { environmentId: "env-a", label: "alpha", serverLabel: "alpha" },
    { environmentId: "env-b", label: "beta", serverLabel: "Beta-Host" },
    { environmentId: "env-c", label: "gamma.example.com", serverLabel: "gamma-host" },
  ];
  const named = (server: string) => ({ server, byEnvironmentId: false });

  it("matches the client's label, then the server's, then a first DNS label", () => {
    expect(resolveRemoteFileServer(named("ALPHA"), candidates)).toMatchObject({
      environmentId: "env-a",
    });
    expect(resolveRemoteFileServer(named("beta-host"), candidates)).toMatchObject({
      environmentId: "env-b",
    });
    expect(resolveRemoteFileServer(named("gamma"), candidates)).toMatchObject({
      environmentId: "env-c",
    });
  });

  it("matches an environment id exactly", () => {
    expect(
      resolveRemoteFileServer({ server: "env-b", byEnvironmentId: true }, candidates),
    ).toMatchObject({ _tag: "found", label: "beta" });
  });

  it("refuses to guess between two servers of one name", () => {
    expect(
      resolveRemoteFileServer(named("twin"), [
        { environmentId: "a", label: "twin", serverLabel: null },
        { environmentId: "b", label: "twin", serverLabel: null },
      ]),
    ).toEqual({ _tag: "ambiguous", labels: ["twin", "twin"] });
    expect(resolveRemoteFileServer(named("nowhere"), candidates)).toEqual({ _tag: "missing" });
  });
});
