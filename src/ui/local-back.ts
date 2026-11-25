/** Same-document Back levels for the reader, its editor and open dialogs.
 * History holds only a depth. Reopening a surface requires its live in-memory context. */
export interface BackLayer {
  close(): void | Promise<void>;
  reopen?(): void | Promise<void>;
}

export function bindLocalBack(layers: () => BackLayer[], admitted: () => boolean, error: (cause: unknown) => void) {
  const history = window.history;
  const stamp = performance.timeOrigin;
  let available = Boolean(history);
  // The app restores two possible scrollers after the destination is visible.
  // A later browser restoration would overwrite the mobile document offset.
  try {
    if (history && "scrollRestoration" in history) history.scrollRestoration = "manual";
  } catch { /* A restricted host may still support same-document Back. */ }
  let travelling = false, handling = false;
  const forward: BackLayer[] = [];
  function level(): number {
    const entry = history.state?.shiguangBack;
    return entry?.stamp === stamp && Number.isInteger(entry.level) ? entry.level : 0;
  }
  function state(depth: number) { return { ...history.state, shiguangBack: { stamp, level: depth } }; }
  function sync() {
    if (!available || handling || travelling) return;
    const stack = layers();
    try {
      const depth = level();
      if (stack.length < depth) {
        travelling = true;
        history.go(stack.length - depth);
      } else {
        for (let i = depth; i < stack.length; i++) {
          forward[i] = stack[i];
          history.pushState(state(i + 1), "");
        }
      }
    } catch {
      // Explicit Back/Done and native dialog cancellation still work on restricted hosts.
      available = false;
      travelling = false;
    }
  }
  window.addEventListener("popstate", async () => {
    if (!available) return;
    if (travelling) { travelling = false; sync(); return; }
    if (handling) return;
    handling = true;
    try {
      let stack = layers();
      while (admitted() && stack.length !== level()) {
        const action = stack.length > level() ? stack.at(-1)?.close : forward[stack.length]?.reopen;
        if (!action) break;
        await action();
        const next = layers();
        if (next.length === stack.length) break;
        stack = next;
      }
      // A closed confirmation, a different origin or a lock can invalidate Forward.
      if (level() > stack.length) history.replaceState(state(stack.length), "");
    } catch (cause) { error(cause); }
    finally { handling = false; sync(); }
  });
  return sync;
}
