/**
 * What `/profiles` is doing, for as long as the process is doing it.
 *
 * Two facts live here, and both outlive any one browser: which profile has an
 * operation running, and which profile is waiting on a restart to pick up a
 * change that has already landed. Neither is Harness state and neither is
 * persisted — the roster itself stays filesystem-authoritative and is re-read
 * every pass, exactly as before. This is dshline's own presentation state about
 * work dshline started.
 *
 * It is module-scoped, which is to say process-scoped, because the alternative
 * was demonstrably wrong. Holding it inside `openProfiles` meant:
 *
 * ```
 * open the browser, start an install, close the browser, open it again
 *   → the new view sees the lock (so it correctly refuses a second run)
 *   → but shows no running row, because its own copy of that state is empty
 *   → and when the install lands, the CLOSED view is the one that hears,
 *     so nothing refreshes the roster or records the restart the new view
 *     should be showing
 * ```
 *
 * A view is a window onto this; it is not where it lives. Subscribers exist for
 * the same reason: the view that started an operation may be gone by the time it
 * finishes, so completion has to reach whichever views are open then rather than
 * the one that happened to ask.
 *
 * The lock lives here too. It is the same fact from the other side — "this
 * profile has an operation running" — and splitting the authority to refuse from
 * the state that shows why would be two answers to one question.
 * @module dshline/profiles/runtime
 */

/** One operation the process is running, as a view would draw it. */
export interface RunningOperation {
  /** The profile being written to. */
  readonly profile: string
  /** What is being done to it, already safe to display. */
  readonly what: string
}

/** Everything the views need to know about work in flight. */
export interface ProfilesActivityView {
  /** Operations running right now. */
  readonly running: readonly RunningOperation[]
  /** Profiles whose landed change this Host picks up only after a restart. */
  readonly restartQueued: readonly string[]
}

/** Profile name → what is running on it, and the promise to await. */
const running = new Map<string, { readonly what: string; readonly settled: Promise<unknown> }>()

/** Profiles whose landed change needs a restart of THIS Host. */
const restartQueued = new Set<string>()

/** Views that want to know when either of the above changes. */
const listeners = new Set<() => void>()

/** Tell every open view that something changed. */
function announce(): void {
  // Copied first: a listener may unsubscribe while being notified, and mutating
  // the set mid-iteration would skip whoever came after it.
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // One view failing to repaint must not stop the others from hearing, and
      // there is nowhere better to report it from than the view itself.
    }
  }
}

/**
 * Watch for changes to what is running or owed.
 * @param listener - called after any change; never called with arguments.
 * @returns the unsubscribe function.
 */
export function watchProfilesActivity(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * What is running and what is owed, right now.
 * @returns an immutable snapshot.
 */
export function profilesActivity(): ProfilesActivityView {
  return {
    running: [...running].map(([profile, entry]) => ({ profile, what: entry.what })),
    restartQueued: [...restartQueued],
  }
}

/** Whether a profile already has an operation running. */
export function operationInFlight(profile: string): boolean {
  return running.has(profile)
}

/**
 * Record that a landed change needs a restart before this Host sees it.
 * @param profile - the profile whose change is waiting.
 */
export function queueRestart(profile: string): void {
  if (restartQueued.has(profile)) return
  restartQueued.add(profile)
  announce()
}

/**
 * Run `task` as the one operation on `profile`, or refuse.
 *
 * Holds the profile for the whole task and announces both edges, so a view
 * opened midway sees the running row and a view open at the end hears the
 * completion — whether or not it is the view that started it.
 * @param profile - the profile the operation writes to.
 * @param what - what to show while it runs; must already be safe to display.
 * @param task - the work to run.
 * @returns what the task answered, or undefined when the profile was busy.
 */
export async function runExclusively<T>(
  profile: string,
  what: string,
  task: () => Promise<T>,
): Promise<T | undefined> {
  if (running.has(profile)) return undefined
  const settled = task()
  running.set(profile, { what, settled })
  announce()
  try {
    return await settled
  } finally {
    running.delete(profile)
    announce()
  }
}

/**
 * Forget everything, for a test that must not leak state into the next one.
 *
 * Exported for tests only; nothing in the running frontend resets this, because
 * the process is the lifetime.
 */
export function resetProfilesRuntime(): void {
  running.clear()
  restartQueued.clear()
  listeners.clear()
}
