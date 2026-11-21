import {
  type AssistantCitation,
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { page, userEvent } from "vite-plus/test/browser";

import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { render } from "../../../test/render";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};

function Timeline({ onCite }: { onCite: (citation: AssistantCitation) => boolean }) {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  return (
    <>
      <div ref={setViewport} data-assistant-citation-viewport="" style={{ height: 200 }}>
        <p data-assistant-citation-source="message">hello world</p>
      </div>
      <AssistantSelectionToolbar viewport={viewport} threadRef={threadRef} onCite={onCite} />
    </>
  );
}

afterEach(() => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
});

it("cites a mouse selection at once while cite on selection is on", async () => {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, citeOnSelection: true });
  const onCite = vi.fn((_citation: AssistantCitation) => true);
  await using _screen = await render(<Timeline onCite={onCite} />);

  await userEvent.dblClick(page.getByText("hello world"));

  await expect.poll(() => onCite.mock.calls.length).toBe(1);
  expect(onCite.mock.calls[0]?.[0].text).toBe("hello");
  expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
  await expect.element(page.getByLabelText("Cite selection in composer")).not.toBeInTheDocument();
});

it("offers the Cite button for a mouse selection while cite on selection is off", async () => {
  const onCite = vi.fn((_citation: AssistantCitation) => true);
  await using _screen = await render(<Timeline onCite={onCite} />);

  await userEvent.dblClick(page.getByText("hello world"));

  await expect.element(page.getByLabelText("Cite selection in composer")).toBeVisible();
  expect(onCite).not.toHaveBeenCalled();
});
