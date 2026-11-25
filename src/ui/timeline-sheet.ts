/** Dispatch initial and return focus explicitly. Native dialog owns Tab and Escape. */
export function bindTimelineSheet(dialog: HTMLDialogElement, opener: HTMLButtonElement, done: HTMLButtonElement,
  available: () => boolean, syncBack: () => void) {
  function open() {
    if (!available() || dialog.open) return;
    dialog.showModal();
    document.documentElement.classList.add("sheet-open");
    opener.setAttribute("aria-expanded", "true");
    done.focus({ preventScroll: true });
    syncBack();
  }
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    document.documentElement.classList.remove("sheet-open");
    opener.setAttribute("aria-expanded", "false");
    if (available()) opener.focus({ preventScroll: true });
    syncBack();
  });
  opener.addEventListener("click", open);
  done.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
  return open;
}
