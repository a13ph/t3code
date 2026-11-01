import { describe, expect, it } from "vite-plus/test";

import {
  parseRemoteFileHref,
  remoteFileChipLabel,
  remoteFileDirectory,
  remoteFileInlineCodePattern,
  remoteFileServerNames,
  resolveRemoteFileServer,
} from "./remoteFileLinks";

describe("parseRemoteFileHref", () => {
  it("reads a server name and a POSIX path", () => {
    expect(parseRemoteFileHref("vps:/home/user/notes.md")).toEqual({
      server: "vps",
      byEnvironmentId: false,
      path: "/home/user/notes.md",
    });
  });

  it("reads a Windows path after a server name", () => {
    expect(parseRemoteFileHref("win-vm:D:/user/notes/x.md")?.path).toBe(
      "D:/user/notes/x.md",
    );
  });

  it("keeps spaces, decodes escapes and splits a line suffix", () => {
    expect(parseRemoteFileHref("<workstation:/home/user/a%20b c.md:12>")).toEqual({
      server: "workstation",
      byEnvironmentId: false,
      path: "/home/user/a b c.md",
      line: 12,
    });
  });

  it("reads the remote-file form with either path style", () => {
    expect(parseRemoteFileHref("remote-file://v1/env-1/home/user/x.md")).toEqual({
      server: "env-1",
      byEnvironmentId: true,
      path: "/home/user/x.md",
    });
    expect(parseRemoteFileHref("remote-file://v1/env-1/D:/user/x.md")?.path).toBe("D:/user/x.md");
  });

  it("reads the environment-id form under any scheme name but t3", () => {
    expect(parseRemoteFileHref("shared-file://v1/env-1/x.md")).toMatchObject({
      server: "env-1",
      byEnvironmentId: true,
    });
    expect(parseRemoteFileHref("t3-file://v1/env-1/x.md")).toBeNull();
  });

  it("leaves drive paths, URLs and relative refs alone", () => {
    for (const href of [
      "D:/user/x.md",
      "C:\\Users\\x.md",
      "https://example.com/x",
      "file:///home/user/x.md",
      "origin/main",
      "vps:relative/path",
      "/home/user/x.md",
      "remote-file://v1/",
      "t3-thread://v1/thread-1",
      "javascript:/a/;alert(1)",
    ]) {
      expect(parseRemoteFileHref(href), href).toBeNull();
    }
  });
});

describe("resolveRemoteFileServer", () => {
  const candidates = [
    { environmentId: "e-vps", label: "vps", serverLabel: "vps" },
    { environmentId: "e-win", label: "win-vm", serverLabel: "WIN-PC" },
    { environmentId: "e-laptop", label: "laptop.example.ts.net", serverLabel: "laptop-host" },
  ];
  const named = (server: string) => ({ server, byEnvironmentId: false });

  it("matches the client's label, then the server's, then a first DNS label", () => {
    expect(resolveRemoteFileServer(named("VPS"), candidates)).toMatchObject({
      environmentId: "e-vps",
    });
    expect(resolveRemoteFileServer(named("win-pc"), candidates)).toMatchObject({
      environmentId: "e-win",
    });
    expect(resolveRemoteFileServer(named("laptop"), candidates)).toMatchObject({
      environmentId: "e-laptop",
    });
  });

  it("matches an environment id exactly and names the server by the client's label", () => {
    expect(
      resolveRemoteFileServer({ server: "e-win", byEnvironmentId: true }, candidates),
    ).toMatchObject({ _tag: "found", label: "win-vm" });
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

describe("remote file chips", () => {
  it("labels a chip with the server and the file name", () => {
    expect(
      remoteFileChipLabel({ server: "e1", byEnvironmentId: true, path: "/a/b c.md" }, "vps"),
    ).toBe("vps: b c.md");
  });

  it("opens the file in its own folder", () => {
    expect(remoteFileDirectory("/home/user/x.md")).toBe("/home/user");
    expect(remoteFileDirectory("/x.md")).toBe("/");
    expect(remoteFileDirectory("D:/user/x.md")).toBe("D:/user");
    expect(remoteFileDirectory("E:/x.md")).toBe("E:/");
    expect(remoteFileDirectory("C:\\Users\\x.md")).toBe("C:\\Users");
  });

  it("recognizes a code span only for a server this client knows", () => {
    const names = remoteFileServerNames([
      { environmentId: "e1", label: "vps", serverLabel: null },
      { environmentId: "e2", label: "Other.example", serverLabel: "other-pc" },
    ]);
    const pattern = new RegExp(`^(?:${remoteFileInlineCodePattern(names)})$`);
    expect(pattern.test("vps:/home/user/a b.md:3")).toBe(true);
    expect(pattern.test("Other:C:/Users/x.md")).toBe(true);
    expect(pattern.test("other:C:\\Users\\x.md")).toBe(true);
    expect(pattern.test("other-pc:/x")).toBe(true);
    expect(pattern.test("nowhere:/etc/hosts")).toBe(false);
    expect(pattern.test("vps://host/x")).toBe(false);
    // A span the link parser cannot decode stays code instead of becoming a dead link.
    expect(pattern.test("vps:/home/user/100%.md")).toBe(false);
    expect(pattern.test("vps:/home/user/a%20b.md")).toBe(true);
    expect(remoteFileInlineCodePattern([])).toBeNull();
  });
});
