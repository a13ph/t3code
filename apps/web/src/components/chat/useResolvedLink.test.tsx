// @vitest-environment jsdom

import { EnvironmentId } from "@t3tools/contracts";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface View {
  readonly data: unknown;
  readonly dataUpdatedAt: number;
  readonly error: string | null;
  readonly failure: unknown;
  readonly isPending: boolean;
  readonly isSuccess: boolean;
}

// One answer per server, as the query atom would hold it; a refresh makes it wait again.
const servers = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    version: 0,
    views: new Map<string, View>(),
    asked: [] as string[],
    inputs: [] as unknown[],
    refreshed: [] as string[],
    environments: [] as ReadonlyArray<unknown>,
  };
  const notify = () => {
    state.version += 1;
    for (const listener of listeners) listener();
  };
  return {
    state,
    notify,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

const PENDING: View = {
  data: null,
  dataUpdatedAt: 0,
  error: null,
  failure: null,
  isPending: true,
  isSuccess: false,
};
const IDLE: View = { ...PENDING, isPending: false };

vi.mock("../../state/resolvedLinkLookup", () => ({
  resolvedLinkLookup: (target: { environmentId: string; input: unknown }) => {
    servers.state.inputs.push(target.input);
    return { environmentId: target.environmentId };
  },
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => {
    useSyncExternalStore(servers.subscribe, () => servers.state.version);
    return { environments: servers.state.environments, isReady: true };
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { environmentId: string } | null) => {
    useSyncExternalStore(servers.subscribe, () => servers.state.version);
    if (atom === null) return { ...IDLE, refresh: () => {} };
    const environmentId = atom.environmentId;
    if (servers.state.asked.at(-1) !== environmentId) servers.state.asked.push(environmentId);
    const view = servers.state.views.get(environmentId) ?? PENDING;
    return {
      ...view,
      refresh: () => {
        servers.state.refreshed.push(environmentId);
        servers.state.views.set(environmentId, { ...view, isPending: true });
        queueMicrotask(servers.notify);
      },
    };
  },
}));

import { useResolvedLink, type ResolvedLinkResolution } from "./useResolvedLink";

const LINK = { scheme: "notes", id: "3f2b9c1e-7d4a-4e6b-9a8c-2d5f1b0e7c43" };
const OWN = EnvironmentId.make("env-own");
const OTHER = EnvironmentId.make("env-other");
const PLAIN = EnvironmentId.make("env-plain");
const TARGET = {
  path: "/home/user/notes/n.md",
  label: "N",
  mark: "o",
  tone: "normal",
  tooltip: "N",
};

const environment = (environmentId: string, label: string, linkSchemes = ["notes"]) => ({
  environmentId,
  label,
  connection: { phase: "connected" },
  serverConfig: { linkSchemes },
});
const answer = (data: unknown): View => ({
  data,
  dataUpdatedAt: Date.now(),
  error: null,
  failure: null,
  isPending: false,
  isSuccess: true,
});

let seen: ResolvedLinkResolution[];
let root: Root;
let container: HTMLDivElement;

function Probe() {
  seen.push(useResolvedLink(LINK, OWN));
  return null;
}

const last = () => seen.at(-1)?._tag;

async function settle(update: () => void = () => {}) {
  await act(async () => {
    update();
    servers.notify();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  seen = [];
  servers.state.views.clear();
  servers.state.asked = [];
  servers.state.inputs = [];
  servers.state.refreshed = [];
  servers.state.environments = [environment(OWN, "own")];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useResolvedLink", () => {
  it("asks with the link's scheme and id", async () => {
    await settle(() => servers.state.views.set(OWN, answer(TARGET)));
    expect(servers.state.inputs.at(-1)).toEqual(LINK);
    expect(seen.at(-1)).toMatchObject({ _tag: "found", environmentId: OWN, target: TARGET });
  });

  it("never asks a server that does not announce the scheme", async () => {
    servers.state.environments = [
      environment(PLAIN, "aaa", ["other"]),
      environment(OWN, "own"),
    ];
    await settle(() => servers.state.views.set(OWN, answer(null)));
    await advance(6_500);
    await settle(() => servers.state.views.set(OWN, answer(null)));
    expect(servers.state.asked).not.toContain(PLAIN);
    expect(last()).toBe("missing");
  });

  it("is missing at once when no connected server announces the scheme", async () => {
    await settle(() => {
      servers.state.environments = [environment(PLAIN, "plain", [])];
    });
    expect(servers.state.asked).toEqual([OWN]);
    expect(last()).toBe("missing");
  });

  it("asks once more about 6 s after a miss, so a target made just then shows", async () => {
    await settle(() => servers.state.views.set(OWN, answer(null)));
    expect(last()).toBe("missing");

    await advance(6_500);
    expect(servers.state.refreshed).toEqual([OWN]);
    expect(last()).toBe("resolving");
    await settle(() => servers.state.views.set(OWN, answer(TARGET)));
    expect(seen.at(-1)).toMatchObject({ _tag: "found", environmentId: OWN, target: TARGET });
  });

  it("stays missing after the one re-run also misses", async () => {
    await settle(() => servers.state.views.set(OWN, answer(null)));
    await advance(6_500);
    await settle(() => servers.state.views.set(OWN, answer(null)));
    expect(last()).toBe("missing");
    await advance(60_000);
    expect(servers.state.refreshed).toEqual([OWN]);
    expect(last()).toBe("missing");
  });

  it("gives up on a silent server even while the server list re-renders", async () => {
    servers.state.environments = [environment(OWN, "own"), environment(OTHER, "other")];
    await settle();
    expect(servers.state.asked.at(-1)).toBe(OWN);
    for (let step = 0; step < 3; step += 1) {
      await advance(3_000);
      // A new array with the same servers, as each environments update makes.
      await settle(() => {
        servers.state.environments = [environment(OWN, "own"), environment(OTHER, "other")];
      });
    }
    // Not yet: 9 s is inside the timeout.
    expect(servers.state.asked.at(-1)).toBe(OWN);
    await advance(3_500);
    expect(servers.state.asked.at(-1)).toBe(OTHER);
  });
});

describe("useResolvedLink live refresh", () => {
  let visibility: DocumentVisibilityState = "visible";
  const setVisibility = (state: DocumentVisibilityState) => {
    visibility = state;
  };
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });

  const found = () => seen.at(-1) as Extract<ResolvedLinkResolution, { _tag: "found" }>;

  it("shows a change after the 15 s refresh", async () => {
    await settle(() => servers.state.views.set(OWN, answer(TARGET)));
    expect(found().target.mark).toBe("o");

    await advance(14_000);
    expect(servers.state.refreshed).toEqual([]);
    await advance(1_000);
    expect(servers.state.refreshed).toEqual([OWN]);
    await settle(() =>
      servers.state.views.set(OWN, answer({ ...TARGET, mark: "x", tone: "muted" })),
    );
    expect(found()).toMatchObject({ _tag: "found", target: { mark: "x", tone: "muted" } });
  });

  it("does not refresh while the page is hidden, and refreshes on focus", async () => {
    await settle(() => servers.state.views.set(OWN, answer(TARGET)));
    setVisibility("hidden");
    try {
      await advance(60_000);
      expect(servers.state.refreshed).toEqual([]);
    } finally {
      setVisibility("visible");
    }
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(servers.state.refreshed).toEqual([OWN]);
  });

  it("shares one refresh among chips of one link and stops after unmount", async () => {
    await act(async () =>
      root.render(
        <>
          <Probe />
          <Probe />
          <Probe />
        </>,
      ),
    );
    await settle(() => servers.state.views.set(OWN, answer(TARGET)));
    await advance(15_000);
    expect(servers.state.refreshed).toEqual([OWN]);
    await act(async () => root.render(<></>));
    await advance(45_000);
    expect(servers.state.refreshed).toEqual([OWN]);
  });

  it("runs the chain again when the server that knew the link loses it", async () => {
    servers.state.environments = [environment(OWN, "own"), environment(OTHER, "other")];
    await settle(() => servers.state.views.set(OWN, answer(TARGET)));
    expect(found().environmentId).toBe(OWN);

    await advance(15_000);
    await settle(() => servers.state.views.set(OWN, answer(null)));
    await settle(() => servers.state.views.set(OWN, answer(null)));
    expect(servers.state.refreshed).toEqual([OWN, OWN, OTHER]);
    expect(servers.state.asked.at(-1)).toBe(OTHER);
    await settle(() => servers.state.views.set(OTHER, answer({ ...TARGET, label: "Moved" })));
    expect(found()).toMatchObject({ environmentId: OTHER, target: { label: "Moved" } });
  });
});
