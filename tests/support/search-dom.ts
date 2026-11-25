import assert from "node:assert/strict";

/** An event/DOM harness, following museum-dom. It does not measure browser layout or AT. */
export class SearchNode {
  tagName: string;
  nodeType: number;
  parentElement: SearchNode | null = null;
  children: SearchNode[] = [];
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  className = "";
  style = {};
  hidden = false;
  disabled = false;
  checked = false;
  inert = false;
  open = false;
  value = "";
  id = "";
  type = "";
  name = "";
  htmlFor = "";
  tabIndex = 0;
  scrollTop = 0;
  alt = "";
  loading = "";
  decoding = "";
  src = "";
  validity = { badInput: false, valid: true };
  private ownText = "";
  private handlers = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  constructor(tag: string, text = "") { this.tagName = tag; this.nodeType = tag === "#text" ? 3 : 1; this.ownText = text; }
  get textContent(): string { return this.ownText + this.children.map(n => n.textContent).join(""); }
  set textContent(value: string) { this.replaceChildren(); this.ownText = value; }
  get innerHTML(): never { throw new Error("Search UI must use text nodes, never innerHTML"); }
  set innerHTML(_value: string) { throw new Error("Search UI must use text nodes, never innerHTML"); }
  get childNodes(): SearchNode[] { return this.children; }
  get firstElementChild(): SearchNode | null { return this.children.find(n => n.nodeType === 1) ?? null; }
  get isConnected(): boolean { return this === activeRoot || !!this.parentElement?.isConnected; }
  classList = {
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(" ").filter(Boolean), ...names])].join(" "); },
    remove: (...names: string[]) => { this.className = this.className.split(" ").filter(n => !names.includes(n)).join(" "); },
    contains: (name: string) => this.className.split(" ").includes(name),
    toggle: (name: string, on?: boolean) => { const next = on ?? !this.classList.contains(name); if (next) this.classList.add(name); else this.classList.remove(name); return next; },
  };
  append(...nodes: Array<SearchNode | string>): void {
    for (const node of nodes) { const n = typeof node === "string" ? new SearchNode("#text", node) : node; n.parentElement = this; this.children.push(n); }
  }
  appendChild(node: SearchNode): SearchNode { this.append(node); return node; }
  replaceChildren(...nodes: Array<SearchNode | string>): void {
    this.children.forEach(n => { n.parentElement = null; }); this.children = []; this.ownText = ""; this.append(...nodes);
  }
  remove(): void { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null; }
  replaceWith(node: SearchNode): void {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    node.parentElement = parent; parent.children.splice(index, 1, node); this.parentElement = null;
  }
  setAttribute(key: string, value: string): void {
    this.attributes.set(key, value);
    if (key.startsWith("data-")) this.dataset[dataKey(key.slice(5))] = value;
    if (key === "id") this.id = value;
  }
  getAttribute(key: string): string | null {
    if (key.startsWith("data-")) return this.dataset[dataKey(key.slice(5))] ?? null;
    return this.attributes.get(key) ?? null;
  }
  removeAttribute(key: string): void { this.attributes.delete(key); }
  addEventListener(name: string, fn: (event: Record<string, unknown>) => void): void { this.handlers.set(name, [...this.handlers.get(name) ?? [], fn]); }
  fire(name: string, extra: Record<string, unknown> = {}): void {
    if ((name === "click" || name === "change") && this.disabled) return;
    const event = { key: "", target: this, currentTarget: this, isComposing: false, preventDefault() {}, ...extra };
    for (const fn of this.handlers.get(name) ?? []) fn(event);
  }
  focus(_options?: unknown): void { activeNode = this; }
  querySelectorAll(selector: string): SearchNode[] {
    return this.children.flatMap(n => [...(matches(n, selector) ? [n] : []), ...n.querySelectorAll(selector)]);
  }
  querySelector(selector: string): SearchNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  text(): string { return this.textContent; }
}

let activeNode: SearchNode | null = null;
let activeRoot: SearchNode | null = null;
const dataKey = (name: string) => name.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
function matches(node: SearchNode, selector: string): boolean {
  if (selector.includes(",")) return selector.split(",").some(part => matches(node, part.trim()));
  const attr = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (attr) { const value = node.getAttribute(attr[1]); return attr[2] === undefined ? value !== null : value === attr[2]; }
  if (selector.startsWith(".")) return node.className.split(" ").includes(selector.slice(1));
  if (selector.startsWith("#")) return node.id === selector.slice(1);
  return node.tagName === selector;
}

export function searchDom() {
  const original = { document: globalThis.document, window: globalThis.window, HTMLElement: globalThis.HTMLElement };
  const shell = new SearchNode("div"); shell.className = "app-shell";
  const main = new SearchNode("main"); main.className = "main";
  const root = new SearchNode("section"); root.id = "view-search";
  shell.append(main); main.append(root); activeRoot = shell; activeNode = null;
  const created: SearchNode[] = [];
  const win = { scrollY: 0, scrollTo(_x: number, y: number) { this.scrollY = y; }, setTimeout, clearTimeout };
  Object.assign(globalThis, { HTMLElement: SearchNode, document: {
    createElement(tag: string) { const node = new SearchNode(tag); created.push(node); return node; },
    createTextNode(text: string) { const node = new SearchNode("#text", text); created.push(node); return node; },
    createDocumentFragment() { return new SearchNode("fragment"); },
    querySelector(selector: string) { return matches(shell, selector) ? shell : shell.querySelector(selector); },
    get activeElement() { return activeNode; },
  }, window: win });
  return { root, main, win, shell, created,
    active: () => activeNode,
    find(id: string) { return root.querySelector(`[data-testid="${id}"]`); },
    byTest(id: string) { const node = root.querySelector(`[data-testid="${id}"]`); assert.ok(node, `Missing ${id}`); return node; },
    restore() { Object.assign(globalThis, original); activeNode = null; activeRoot = null; },
  };
}

export function manualTimers() {
  let sequence = 0;
  const tasks = new Map<number, { fn: () => void; ms: number }>();
  return {
    schedule(fn: () => void, ms: number): unknown { const id = ++sequence; tasks.set(id, { fn, ms }); return id; },
    cancel(id: unknown): void { tasks.delete(id as number); },
    pending: () => [...tasks.values()].map(task => task.ms),
    flush(): void { const batch = [...tasks.values()]; tasks.clear(); batch.forEach(task => task.fn()); },
  };
}

export async function settled(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("Search operation did not settle");
}
