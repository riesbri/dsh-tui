/** Compatibility dispatch for the Harness command registry. */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** A command execute method at either supported Harness peer signature. */
export type CommandExecute<Result> = (
  agent: Agent,
  line: string,
  ...arguments_: unknown[]
) => Promise<Result>

/** An object owning a command execute method and therefore its `this` receiver. */
export interface CommandExecutor<Result> {
  /** Execute a registered command against an agent. */
  execute: CommandExecute<Result>
}

/**
 * Dispatch a command across the pre-attachment and attachment-aware registry
 * signatures.
 * @param commands - registry owning the execute method.
 * @param agent - exact receiving agent.
 * @param line - submitted command line.
 * @param signal - cancellation signal owned by the terminal request.
 * @returns the registry's resolved command outcome.
 */
export async function executeCommand<Result>(
  commands: CommandExecutor<Result>,
  agent: Agent,
  line: string,
  signal: AbortSignal,
): Promise<Result> {
  // The old peer floor accepts `(agent, line, signal)` while current Harness
  // inserts an attachment list before the signal. Calling the latter shape on
  // the former gives it an array where it needs AbortSignal, so arity—not a
  // version check—keeps both service contracts usable without another peer.
  return commands.execute.length >= 4
    ? await commands.execute(agent, line, [], signal)
    : await commands.execute(agent, line, signal)
}
