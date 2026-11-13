import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { createRef, useState } from "react";
import { afterEach, expect, it } from "vite-plus/test";

import { page, userEvent } from "vite-plus/test/browser";

import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { findAssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { act, render } from "../../test/render";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "./ComposerPromptEditorTiptap";

const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "hello",
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};
const promptWithCitation = `See ${serializeAssistantCitation(citation)} `;

function Composer({ editorRef }: { editorRef: React.RefObject<ComposerPromptEditorHandle | null> }) {
  const [prompt, setPrompt] = useState(promptWithCitation);
  return (
    <>
      <div data-assistant-citation-viewport="">
        <p
          data-assistant-citation-source={citation.messageId}
          data-assistant-citation-environment={citation.environmentId}
          data-assistant-citation-thread={citation.threadId}
        >
          hello world
        </p>
      </div>
      <output data-prompt={prompt} />
      <ComposerPromptEditor
        editorRef={editorRef}
        value={prompt}
        cursor={0}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={setPrompt}
        onPaste={() => {}}
      />
    </>
  );
}

// Opens the comment of a citation just inserted after "See ", as a Cite does.
async function renderFreshCitation(citeOnSelection: boolean) {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, citeOnSelection });
  const editorRef = createRef<ComposerPromptEditorHandle>();
  const screen = await render(<Composer editorRef={editorRef} />);
  const sourceAnchor = findAssistantCitationSourceAnchor(document, citation);
  if (!sourceAnchor) throw new Error("Citation source did not resolve");
  await act(async () =>
    editorRef.current?.requestCitationComment({
      previousValue: "See ",
      value: promptWithCitation,
      citationStart: "See ".length,
      sourceAnchor,
      insertedSpaces: { before: false, after: true },
    }),
  );
  await expect.element(page.getByLabelText("Comment on selected text")).toBeVisible();
  return screen;
}

function promptOf(screen: Awaited<ReturnType<typeof render>>) {
  return () => screen.container.querySelector("output")?.dataset.prompt;
}

afterEach(() => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
});

it("drops an uncommented citation when a press on assistant text starts the next one", async () => {
  await using screen = await renderFreshCitation(true);

  await page.getByText("hello world").click();

  await expect.poll(promptOf(screen)).toBe("See ");
  await expect.element(page.getByLabelText("Add comment to citation")).not.toBeInTheDocument();
});

it("keeps a commented citation when a press on assistant text starts the next one", async () => {
  await using screen = await renderFreshCitation(true);

  await page.getByLabelText("Comment on selected text").click();
  await userEvent.keyboard("check this");
  await page.getByText("hello world").click();

  await expect
    .poll(promptOf(screen))
    .toBe(`See ${serializeAssistantCitation(withAssistantCitationComment(citation, "check this"))} `);
});

it("keeps an uncommented citation on the same press while cite on selection is off", async () => {
  await using screen = await renderFreshCitation(false);

  await page.getByText("hello world").click();

  await expect
    .element(page.getByLabelText("Comment on selected text"))
    .not.toBeInTheDocument();
  expect(promptOf(screen)()).toBe(promptWithCitation);
});
