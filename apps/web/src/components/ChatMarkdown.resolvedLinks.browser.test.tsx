import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import "../index.css";

import { filesystemEnvironment } from "../state/filesystem";
import { useRightPanelStore } from "../rightPanelStore";

const { workspaceSearch, filesystemMetadata } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
}));
vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) =>
    family === filesystemEnvironment.getMetadata ? filesystemMetadata : workspaceSearch) as never,
}));
// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));

const links = vi.hoisted(() => ({
  schemes: new Set<string>(["notes"]),
  resolve: (_link: unknown, _environmentId: unknown): unknown => ({ _tag: "resolving" }),
  asked: [] as unknown[],
}));
vi.mock(import("../state/linkSchemes"), () => ({
  useLinkSchemes: () => links.schemes,
}));
vi.mock(import("./chat/useResolvedLink"), () => ({
  useResolvedLink: ((link: unknown, environmentId: unknown) => {
    links.asked.push([link, environmentId]);
    return links.resolve(link, environmentId);
  }) as never,
}));

import ChatMarkdown from "./ChatMarkdown";

const ENVIRONMENT = EnvironmentId.make("env-chat");
const GRAPH = EnvironmentId.make("env-graph");
const ID = "3f2b9c1e-7d4a-4e6b-9a8c-2d5f1b0e7c43";
const PATH = "/home/user/notes/some-note.md";
const MARK = String.fromCodePoint(0x25e7);

const found = (target: Record<string, unknown> = {}) => ({
  _tag: "found",
  environmentId: GRAPH,
  serverLabel: "graph-host",
  target: {
    path: PATH,
    label: "Current title",
    mark: MARK,
    tone: "warning",
    tooltip: `Current title\n${MARK} in-progress`,
    ...target,
  },
});

function setup(resolution: unknown = found()) {
  workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
  links.schemes = new Set(["notes"]);
  links.asked = [];
  links.resolve = () => resolution;
}

const renderText = (text: string, props: Record<string, unknown> = {}) =>
  render(<ChatMarkdown cwd="/tmp/project" environmentId={ENVIRONMENT} text={text} {...props} />);

const chipLabel = (container: HTMLElement) =>
  container.querySelector('.chat-markdown-file-link [data-slot="context-chip-label"]');

describe("ChatMarkdown resolved links", () => {
  it.each([
    `See [](<notes://${ID}>) here`,
    `See [old label](notes://${ID}) here`,
    `See <notes://${ID}> here`,
    `See \`notes://${ID}\` here`,
  ])("shows %s as a chip with the target's current label", async (text) => {
    setup();
    await using screen = await renderText(text);
    expect(chipLabel(screen.container)?.textContent).toBe("Current title");
    expect(screen.container.textContent).not.toContain("old label");
    expect(links.asked.at(-1)).toEqual([{ scheme: "notes", id: ID }, ENVIRONMENT]);
  });

  it("leaves a link of a scheme no server announces as it was", async () => {
    setup();
    links.schemes = new Set();
    await using screen = await renderText(`See \`notes://${ID}\` and [x](notes://${ID})`);
    expect(screen.container.querySelector(".chat-markdown-file-link")).toBeNull();
    expect(screen.container.querySelector("code")?.textContent).toBe(`notes://${ID}`);
    expect(links.asked).toEqual([]);
  });

  it("puts the mark in front of the label, coloured by its tone", async () => {
    setup();
    await using screen = await renderText(`See [](<notes://${ID}>) here`);
    const mark = screen.container.querySelector(".chat-markdown-file-link [data-link-mark]");
    expect(mark?.textContent).toBe(MARK);
    expect(mark?.getAttribute("aria-label")).toBe("warning");
    expect(mark?.className).toContain("text-warning");
    const chip = screen.container.querySelector(".chat-markdown-file-link")!;
    expect(chip.firstElementChild).toBe(mark);
    expect(chipLabel(screen.container)?.className).not.toContain("text-muted-foreground");
  });

  it("mutes the label of a muted target and shows no mark without one", async () => {
    setup(found({ tone: "muted", mark: "" }));
    await using screen = await renderText(`See [](<notes://${ID}>) here`);
    expect(screen.container.querySelector("[data-link-mark]")).toBeNull();
    expect(chipLabel(screen.container)?.className).toContain("text-muted-foreground");
  });

  it("shows the link's text, or a short id, until a server answers", async () => {
    setup({ _tag: "resolving" });
    await using screen = await renderText(`[my note](<notes://${ID}>) and [](<notes://${ID}>)`);
    const waiting = [...screen.container.querySelectorAll('[data-resolved-link="resolving"]')];
    expect(waiting.map((element) => element.textContent)).toEqual(["my note", "notes:3f2b9c1e"]);
    expect(screen.container.querySelector(".chat-markdown-file-link")).toBeNull();
  });

  it("leaves plain text when no server knows the link", async () => {
    setup({ _tag: "missing" });
    await using screen = await renderText(`[my note](<notes://${ID}>)`);
    expect(screen.container.querySelector('[data-resolved-link="missing"]')?.textContent).toBe(
      "my note",
    );
    expect(screen.container.querySelector(".chat-markdown-file-link")).toBeNull();
  });

  it("opens the target in the files panel from the server that answered", async () => {
    setup();
    const openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    const threadRef = { environmentId: ENVIRONMENT, threadId: ThreadId.make("thread-1") };
    try {
      await using screen = await renderText(`Open [](<notes://${ID}>) now`, { threadRef });
      const chip = screen.container.querySelector<HTMLElement>("a.chat-markdown-file-link")!;
      chip.click();
      expect(openFile).toHaveBeenCalledWith(threadRef, PATH, undefined, GRAPH);
    } finally {
      openFile.mockRestore();
    }
  });
});
