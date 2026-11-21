/**
 * Spawns the Claude CLI through t3-keeper (`../../t3Keeper/`) when
 * `T3_KEEPER_SOCKET` names its socket. A relative path is taken under
 * `$XDG_RUNTIME_DIR`.
 *
 * The CLI and every command it starts are children of the keeper, not of the
 * server. The CLI leads its own process group there, and what it leaves in
 * the group is killed when it exits, as with `spawnClaudeProcessGroup`.
 *
 * When the keeper cannot be reached for 10 s, the shim spawns the CLI
 * itself, as the SDK would have.
 */
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
// @effect-diagnostics nodeBuiltinImport:off -- the socket path is a host path.
import { isAbsolute, join } from "node:path";

// @ts-ignore - plain ESM without types
import { spawnNew } from "../../t3Keeper/shim.mjs";

function keeperSocketPath(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.T3_KEEPER_SOCKET;
  if (!raw) return undefined;
  if (isAbsolute(raw)) return raw;
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (!runtimeDir) {
    console.warn(
      `t3-keeper: T3_KEEPER_SOCKET=${raw} is relative and XDG_RUNTIME_DIR is unset, spawning claude without the keeper`,
    );
    return undefined;
  }
  return join(runtimeDir, raw);
}

/** The SDK's `spawnClaudeCodeProcess` for one thread, or undefined without a keeper socket. */
export function keeperSpawnProcess(
  threadId: string,
  options: { readonly env?: NodeJS.ProcessEnv; readonly connectRetryMs?: number } = {},
): ((options: SpawnOptions) => SpawnedProcess) | undefined {
  const socketPath = keeperSocketPath(options.env ?? process.env);
  if (socketPath === undefined) return undefined;
  return spawnNew({
    socketPath,
    name: threadId,
    group: true,
    // nothing reattaches, so the keeper may drop each line once delivered
    autoAck: true,
    // a keeper restarting (2 s) still gets the CLI
    connectRetryMs: options.connectRetryMs ?? 10_000,
    fallbackLocal: true,
    onFallback: (error: NodeJS.ErrnoException) => {
      console.warn(
        `t3-keeper: ${socketPath} unreachable (${error.code ?? error.message}), spawning claude locally for thread ${threadId}`,
      );
    },
  });
}
