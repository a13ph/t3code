import { describe, expect, it } from "vite-plus/test";

import { buildChipOpenUrl, buildOpenInAppUrl, resolveChipOpenTargets } from "./openInApps";

// The desktop main process lets a zed link through only in this shape
// (ElectronShell.ts, isRemoteEditorUrl at v0.1.0).
const ZED_SSH_PATHNAME = /^\/[^/@:]+\/.*$/;
const passesDesktopAllowlist = (raw: string) => {
  const url = new URL(raw);
  return (
    url.protocol === "zed:" &&
    url.host === "ssh" &&
    url.username === "" &&
    url.password === "" &&
    ZED_SSH_PATHNAME.test(url.pathname) &&
    url.href === raw
  );
};

describe("buildOpenInAppUrl", () => {
  it("names `local` when the client runs on the thread's server", () => {
    const url = buildOpenInAppUrl({
      app: "nvim",
      host: null,
      absolutePath: "/home/user/project",
      threadId: "thread-1",
    });
    expect(url).toBe("zed://ssh/local/home/user/project?app=nvim&thread=thread-1");
    expect(passesDesktopAllowlist(url)).toBe(true);
  });

  it("encodes a remote linux file path with its line and thread", () => {
    const url = buildOpenInAppUrl({
      app: "nvim",
      host: "host-a",
      absolutePath: "/home/user/docs/x y.md",
      line: 3,
      threadId: "abc",
    });
    expect(url).toBe(
      "zed://ssh/host-a/home/user/docs/x%20y.md?app=nvim&line=3&thread=abc",
    );
    expect(passesDesktopAllowlist(url)).toBe(true);
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.pathname)).toBe("/host-a/home/user/docs/x y.md");
    expect(parsed.searchParams.get("line")).toBe("3");
  });

  it("keeps a Windows drive as /C:/ and never strips it", () => {
    const url = buildOpenInAppUrl({
      app: "obsidian",
      host: "host-b",
      absolutePath: "C:\\Users\\user\\project\\a.md",
      threadId: "t9",
    });
    expect(url).toBe("zed://ssh/host-b/C:/Users/user/project/a.md?app=obsidian&thread=t9");
    expect(passesDesktopAllowlist(url)).toBe(true);
  });

  it("percent-encodes `#` and `?` so they stay in the path", () => {
    const url = buildOpenInAppUrl({
      app: "nvim",
      host: "host-a",
      absolutePath: "/tmp/a#b/c?d.md",
    });
    expect(url).toBe("zed://ssh/host-a/tmp/a%23b/c%3Fd.md?app=nvim");
    const parsed = new URL(url);
    expect(parsed.hash).toBe("");
    expect(parsed.searchParams.get("app")).toBe("nvim");
    expect(passesDesktopAllowlist(url)).toBe(true);
  });

  it("drops a non-positive line and an empty thread", () => {
    expect(
      buildOpenInAppUrl({ app: "nvim", host: null, absolutePath: "/a", line: 0, threadId: "" }),
    ).toBe("zed://ssh/local/a?app=nvim");
  });
});

describe("resolveChipOpenTargets", () => {
  const base = {
    isDesktop: true,
    isRemoteOpenResolved: true,
    canUseShellActions: false,
    availableEditors: [],
  } as const;

  it("offers all three apps on a remote thread", () => {
    expect(resolveChipOpenTargets({ ...base, remoteOpenMode: "remote-links" })).toEqual([
      "nvim",
      "obsidian",
      "vscodium",
    ]);
  });

  it("offers VSCodium on a local thread only when the server found it", () => {
    expect(resolveChipOpenTargets({ ...base, remoteOpenMode: "local-exec" })).toEqual([
      "nvim",
      "obsidian",
    ]);
    expect(
      resolveChipOpenTargets({
        ...base,
        remoteOpenMode: "local-exec",
        canUseShellActions: true,
        availableEditors: ["vscodium"],
      }),
    ).toEqual(["nvim", "obsidian", "vscodium"]);
  });

  it("offers nothing in a browser, before resolution, or without an ssh route", () => {
    expect(
      resolveChipOpenTargets({ ...base, isDesktop: false, remoteOpenMode: "remote-links" }),
    ).toEqual([]);
    expect(
      resolveChipOpenTargets({
        ...base,
        isRemoteOpenResolved: false,
        remoteOpenMode: "remote-links",
      }),
    ).toEqual([]);
    expect(resolveChipOpenTargets({ ...base, remoteOpenMode: "remote-unavailable" })).toEqual([]);
  });
});

describe("buildChipOpenUrl", () => {
  const remote = {
    mode: "remote-links",
    host: { kind: "tailscale", host: "host-a" },
  } as const;

  it("uses the stock VSCodium remote link on a remote thread", () => {
    expect(
      buildChipOpenUrl({
        target: "vscodium",
        state: remote,
        absolutePath: "/home/user/docs/x y.md",
        line: 3,
        threadId: "abc",
      }),
    ).toBe("vscodium://vscode-remote/ssh-remote+host-a/home/user/docs/x%20y.md");
  });

  it("sends thread and line on an app link", () => {
    expect(
      buildChipOpenUrl({
        target: "obsidian",
        state: remote,
        absolutePath: "/home/user/docs/x y.md",
        line: 3,
        threadId: "abc",
      }),
    ).toBe("zed://ssh/host-a/home/user/docs/x%20y.md?app=obsidian&line=3&thread=abc");
  });

  it("leaves local VSCodium to the server", () => {
    expect(
      buildChipOpenUrl({ target: "vscodium", state: { mode: "local-exec" }, absolutePath: "/a" }),
    ).toBeUndefined();
  });
});
