import assert from "node:assert/strict";
/** Event/DOM fixture only: does not claim browser layout, decoding or native focus behavior. */
export class MuseumNode {
  tagName: string; parentElement: MuseumNode | null = null; children: MuseumNode[] = [];
  textContent = ""; className = ""; dataset: Record<string, string> = {}; style = { height: "" };
  attributes = new Map<string, string>(); hidden = false; disabled = false; inert = false; open = false;
  scrollTop = 0; tabIndex = 0; alt = ""; loading = ""; decoding = ""; src = ""; type = "";
  listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  constructor(tag: string) { this.tagName = tag; }
  get firstElementChild() { return this.children[0] ?? null; }
  get isConnected(): boolean { return this === activeRoot || !!this.parentElement?.isConnected; }
  append(...nodes: MuseumNode[]) { for (const n of nodes) { n.parentElement = this; this.children.push(n); } }
  replaceChildren(...nodes: MuseumNode[]) { this.children.forEach(n => { n.parentElement = null; }); this.children = []; this.append(...nodes); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null; }
  setAttribute(k: string, v: string) { this.attributes.set(k, v); }
  getAttribute(k: string) { return this.attributes.get(k) ?? null; }
  addEventListener(name: string, handler: (event: Record<string, unknown>) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], handler]); }
  fire(name: string, extra: Record<string, unknown> = {}) {
    const event = { key: "", target: this, preventDefault() {}, ...extra };
    if (name === "click" && this.disabled) return;
    for (const fn of this.listeners.get(name) ?? []) fn(event);
  }
  focus() { activeNode = this; this.fire("focus"); }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire("close"); }
  querySelectorAll(selector: string): MuseumNode[] {
    return this.children.flatMap(n => [...(matches(n, selector) ? [n] : []), ...n.querySelectorAll(selector)]);
  }
  querySelector(selector: string): MuseumNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  text(): string { return this.textContent + this.children.map(n => n.text()).join(""); }
}
let activeNode: MuseumNode | null = null, activeRoot: MuseumNode | null = null;
function matches(n: MuseumNode, selector: string): boolean {
  const data = selector.match(/^\[data-([\w-]+)(?:="([^"]*)")?\]$/);
  if (data) { const key = data[1].replace(/-([a-z])/g, (_, x: string) => x.toUpperCase()); return data[2] === undefined ? key in n.dataset : n.dataset[key] === data[2]; }
  if (selector.startsWith(".")) return n.className.split(" ").includes(selector.slice(1));
  return n.tagName === selector;
}
export function museumDom() {
  const original = { document: globalThis.document, window: globalThis.window, IntersectionObserver: globalThis.IntersectionObserver, getComputedStyle: globalThis.getComputedStyle };
  const shell = new MuseumNode("div"); shell.className = "app-shell";
  activeRoot = shell; activeNode = null;
  const main = new MuseumNode("main"); main.className = "main";
  const root = new MuseumNode("section");
  const content = new MuseumNode("div"); content.dataset.testid = "museum-content";
  const feedback = new MuseumNode("div"); feedback.dataset.testid = "museum-feedback"; feedback.hidden = true;
  const message = new MuseumNode("p"); message.dataset.testid = "museum-message";
  const undo = new MuseumNode("button"); undo.dataset.testid = "museum-undo"; undo.hidden = true;
  feedback.append(message, undo); root.append(content, feedback); main.append(root); shell.append(main);
  const observers: FakeObserver[] = [];
  const created: MuseumNode[] = [];
  class FakeObserver {
    disconnected = false; target: unknown;
    callback: (entries: Array<{ isIntersecting: boolean }>) => void;
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { this.callback = callback; observers.push(this); }
    observe(target: unknown) { this.target = target; }
    disconnect() { this.disconnected = true; }
    intersect() { if (!this.disconnected) this.callback([{ isIntersecting: true }]); }
  }
  const win = { scrollY: 0, scrollTo(_x: number, y: number) { this.scrollY = y; } };
  Object.assign(globalThis, { document: { createElement: (tag: string) => { const node = new MuseumNode(tag); created.push(node); return node; }, querySelector: (s: string) => matches(shell, s) ? shell : shell.querySelector(s),
    get activeElement() { return activeNode; } }, window: win, IntersectionObserver: FakeObserver,
    getComputedStyle: () => ({ gridTemplateColumns: "100px 100px" }) });
  return { root, shell, main, win, content, feedback, undo, observers, created, active: () => activeNode,
    byTest(id: string) { const node = root.querySelector(`[data-testid="${id}"]`); assert.ok(node, `Missing ${id}`); return node; },
    restore() { Object.assign(globalThis, original); activeRoot = null; activeNode = null; } };
}
export async function settled(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail("Museum operation did not settle");
}
