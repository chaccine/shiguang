// Pointer capture keeps the handle in control while hit-testing the block under the
// pointer. Only a release on a valid target commits an edit.
interface DragActions {
  allowed(): boolean;
  target(x: number, y: number): HTMLElement | null;
  scroll(y: number): void;
  start(): void;
  finish(target: HTMLElement | null): void;
}

export function bindPhotoDrag(handle: HTMLButtonElement, actions: DragActions) {
  let pointer: number | undefined, hold: number | undefined, frame: number | undefined;
  let active = false, x = 0, y = 0, startX = 0, startY = 0;
  let target: HTMLElement | null = null;
  const highlight = (next: HTMLElement | null) => {
    if (target === next) return;
    target?.classList.remove("photo-drop-target");
    target = next;
    target?.classList.add("photo-drop-target");
  };
  const end = (drop = false) => {
    if (pointer === undefined) return;
    const id = pointer, wasActive = active;
    const next = drop && active && actions.allowed() ? actions.target(x, y) : null;
    pointer = undefined; active = false;
    window.clearTimeout(hold);
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    handle.classList.remove("dragging");
    highlight(null);
    window.removeEventListener("blur", cancel);
    document.removeEventListener("visibilitychange", hidden);
    document.removeEventListener("keydown", escape);
    if (wasActive) actions.finish(next);
  };
  const cancel = () => end();
  const hidden = () => { if (document.hidden) end(); };
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); end(); }
  };
  const tick = () => {
    if (!handle.isConnected || !actions.allowed()) { end(); return; }
    actions.scroll(y);
    highlight(actions.target(x, y));
    frame = window.requestAnimationFrame(tick);
  };
  const begin = () => {
    if (!handle.isConnected || !actions.allowed()) { end(); return; }
    active = true; handle.classList.add("dragging"); actions.start();
    frame = window.requestAnimationFrame(tick);
  };
  handle.addEventListener("pointerdown", event => {
    if (pointer !== undefined || !event.isPrimary || event.button !== 0 || !actions.allowed()) return;
    pointer = event.pointerId; startX = x = event.clientX; startY = y = event.clientY;
    handle.setPointerCapture(pointer);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", hidden);
    document.addEventListener("keydown", escape);
    if (event.pointerType === "touch") hold = window.setTimeout(begin, 350);
    else begin();
  });
  handle.addEventListener("pointermove", event => {
    if (pointer !== event.pointerId) return;
    x = event.clientX; y = event.clientY;
    if (!active && Math.hypot(x - startX, y - startY) > 8) end();
    else if (active) highlight(actions.target(x, y));
  });
  handle.addEventListener("pointerup", event => {
    if (pointer !== event.pointerId) return;
    x = event.clientX; y = event.clientY; end(true);
  });
  for (const name of ["pointercancel", "lostpointercapture"] as const)
    handle.addEventListener(name, e => { if (pointer === e.pointerId) end(); });
  handle.addEventListener("contextmenu", e => e.preventDefault());
}
