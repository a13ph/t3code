import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import "../../index.css";

import { filesystemEnvironment } from "../../state/filesystem";

const { workspaceSearch, filesystemMetadata } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
}));
vi.mock(import("../../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) =>
    family === filesystemEnvironment.getMetadata ? filesystemMetadata : workspaceSearch) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("../../state/session"), async (original) => {
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
vi.mock(import("../../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));

const notes = vi.hoisted(() => ({
  resolves: true,
  targets: new Map<string, unknown>(),
  backlinks: null as unknown,
  asked: [] as unknown[],
}));
vi.mock(import("./noteLinks"), async (original) => ({
  ...(await original()),
  useNoteServer: () => ({ label: "notes-host", resolvesWikilinks: notes.resolves }),
}));
vi.mock(import("./useNoteLinkLookups"), () => ({
  useWikilinkTarget: ((noteLinks: { notePath: string | null } | null, target: string) => {
    notes.asked.push([noteLinks?.notePath ?? null, target]);
    return notes.resolves ? (notes.targets.get(target) ?? null) : null;
  }) as never,
  useNoteBacklinks: (() => notes.backlinks) as never,
}));

import { FileMarkdownPreview } from "./FileMarkdownPreview";

const ENVIRONMENT = EnvironmentId.make("env-notes");
const THREAD = scopeThreadRef(ENVIRONMENT, ThreadId.make("thread-notes"));
const NOTE = "/home/u/vault/parent note.md";
const MARK = String.fromCodePoint(0x2605);

const NOTE_TEXT = [
  "---",
  "title: Parent note",
  "related:",
  '  - "[[child one]]"',
  "  - [[child two]]",
  "---",
  "Body links [[child one|the first]] and `[[not a link]]`.",
  "",
].join("\n");

function setup() {
  workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
  notes.resolves = true;
  notes.asked = [];
  notes.backlinks = null;
  notes.targets = new Map([
    [
      "child one",
      {
        path: "/home/u/vault/child one.md",
        label: "Child one, renamed",
        mark: MARK,
        tone: "danger",
        tooltip: "",
      },
    ],
  ]);
  localStorage.removeItem("t3code.noteProperties.open");
}

const renderNote = (onFollowLink = vi.fn()) =>
  render(
    <FileMarkdownPreview
      cwd="/home/u/vault"
      relativePath="parent note.md"
      text={NOTE_TEXT}
      threadRef={THREAD}
      workspaceMutationId={null}
      environmentId={ENVIRONMENT}
      notePath={NOTE}
      onFollowLink={onFollowLink}
    />,
  );

const chipLabels = (root: ParentNode) =>
  [...root.querySelectorAll('.chat-markdown-file-link [data-slot="context-chip-label"]')].map(
    (label) => label.textContent,
  );

// The rendered note body, after the properties block.
const noteBody = (container: HTMLElement) =>
  container.querySelector("[data-note-properties]")!.nextElementSibling!;

describe("FileMarkdownPreview note links", () => {
  it("shows wikilinks as chips, the resolver's label and mark when it names the target", async () => {
    setup();
    await using screen = await renderNote();
    const body = noteBody(screen.container);
    // The alias stays; the resolver gives the mark.
    expect(chipLabels(body)).toEqual(["the first"]);
    expect(body.textContent).toContain(MARK);
    expect(body.querySelector("code")?.textContent).toBe("[[not a link]]");
    expect(notes.asked).toContainEqual([NOTE, "child one"]);
  });

  it("folds the properties, and shows their wikilinks as links once opened", async () => {
    setup();
    await using screen = await renderNote();
    const details = screen.container.querySelector<HTMLDetailsElement>("[data-note-properties]")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toContain("Properties (2)");
    details.open = true;
    await vi.waitFor(() =>
      expect(chipLabels(details)).toEqual(["Child one, renamed", "child two"]),
    );
    expect(details.textContent).toContain("Parent note");
  });

  it("falls back to the file beside the note without a resolver", async () => {
    setup();
    notes.resolves = false;
    await using screen = await renderNote();
    const body = noteBody(screen.container);
    expect(chipLabels(body)).toEqual(["the first"]);
    expect(body.textContent).not.toContain(MARK);
  });

  it("follows a resolved wikilink in place, by its workspace path inside the workspace", async () => {
    setup();
    const onFollowLink = vi.fn();
    await using screen = await renderNote(onFollowLink);
    const body = noteBody(screen.container);
    const chip = body.querySelector<HTMLElement>(".chat-markdown-file-link")!;
    chip.click();
    // The file tree's name for the file, so it is one tab and one history entry.
    await vi.waitFor(() =>
      expect(onFollowLink).toHaveBeenCalledWith("child one.md", undefined, ENVIRONMENT),
    );
  });

  it("follows a resolved wikilink outside the workspace by its absolute path", async () => {
    setup();
    notes.targets.set("child one", {
      path: "/home/u/elsewhere/child one.md",
      label: "Child one, elsewhere",
      mark: "",
      tone: "normal",
      tooltip: "",
    });
    const onFollowLink = vi.fn();
    await using screen = await renderNote(onFollowLink);
    noteBody(screen.container).querySelector<HTMLElement>(".chat-markdown-file-link")!.click();
    await vi.waitFor(() =>
      expect(onFollowLink).toHaveBeenCalledWith(
        "/home/u/elsewhere/child one.md",
        undefined,
        ENVIRONMENT,
      ),
    );
  });

  it("lists the notes that link here in the properties summary and block", async () => {
    setup();
    notes.backlinks = [
      { path: "/home/u/vault/up.md", label: "Up there", mark: "", tone: "normal", tooltip: "" },
    ];
    await using screen = await renderNote();
    const details = screen.container.querySelector<HTMLDetailsElement>("[data-note-properties]")!;
    expect(details.querySelector("summary")?.textContent).toContain("linked from 1");
    details.open = true;
    await vi.waitFor(() =>
      expect(chipLabels(details.querySelector("[data-note-linked-from]")!)).toEqual(["Up there"]),
    );
  });
});
