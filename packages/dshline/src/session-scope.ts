/**
 * Teardown for one attached session, so a window can attach another.
 *
 * The runner used to own everything through `ctx.effect`, which was right while
 * a window drove exactly one session for the life of the process: the plugin
 * fiber outlived the session, so the two were the same lifetime. Reopening a
 * session from inside the window breaks that identity — the slot registrations,
 * the log listener, the spinner timer, and the capability projections belong to
 * the session, not to the window — and a second attach without a matching
 * detach would leave the previous session's listener still projecting into the
 * terminal.
 *
 * Deliberately not a Cordis fiber. A fiber would give scoping for free, but the
 * agent handle's disposer is asynchronous and must run AFTER the presentation is
 * gone, and expressing "these synchronous disposers, then that awaited one" is
 * clearer as an explicit ordered stack than as a nested composite effect.
 * @module dshline/session-scope
 */

/**
 * An ordered, error-contained teardown stack.
 *
 * Reverse order on purpose: registrations are made outermost-first, so a view
 * registered after the projection that feeds it must come down before it.
 */
export class SessionScope {
  private readonly disposers: (() => void)[] = []
  private done = false

  /**
   * Take ownership of one disposer.
   * @param disposer - the teardown to run when this scope closes.
   */
  own(disposer: () => void): void {
    // A disposer handed over after teardown has already run would never be
    // called, so it is run at once rather than retained and forgotten.
    if (this.done) {
      disposer()
      return
    }
    this.disposers.push(disposer)
  }

  /**
   * Run every owned disposer, newest first.
   *
   * A throwing disposer must not strand the ones behind it: the whole point of
   * this call is that nothing from the previous session is left listening, and
   * one failed unregistration is a smaller problem than a leaked transcript
   * projection. Failures are collected and the first is rethrown afterwards, so
   * a bug here is still visible.
   * @throws the first failure, after every disposer has run.
   */
  dispose(): void {
    if (this.done) return
    this.done = true
    let failure: unknown
    let failed = false
    for (const disposer of this.disposers.splice(0).reverse()) {
      try {
        disposer()
      } catch (error: unknown) {
        if (!failed) {
          failed = true
          failure = error
        }
      }
    }
    if (failed) throw failure
  }

  /** Whether teardown has already run. */
  get closed(): boolean {
    return this.done
  }
}
