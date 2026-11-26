import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Minimal event DOM for exercising the real application bootstrap without a browser process.
 * Tracks requested focus, dialog state and history events. Layout, native focus traversal and image decoding require device checks. */
class Node {
  tag: string; id=""; value=""; src=""; alt=""; hidden=false; disabled=false; checked=false; inert=false; scrollTop=0;
  textContent=""; className=""; dataset:Record<string,string>={}; style={}; children:Node[]=[];
  parent: Node | null = null;
  open = false;
  selectionStart = 0; selectionEnd = 0;
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  onFocus?: (node: Node) => void;
  get isConnected(): boolean { return this.tag === "body" || (this.parent?.isConnected ?? false); }
  closest(selector: string): Node | null {
    return matches(this, selector) ? this : this.parent?.closest(selector) ?? null;
  }
  attributes=new Map<string,string>(); listeners=new Map<string,Array<(e:unknown)=>void>>();
  constructor(tag:string){this.tag=tag;}
  classList={add:(...names:string[])=>{this.className+=" "+names.join(" ");},remove:(...names:string[])=>{this.className=this.className.split(" ").filter(n=>!names.includes(n)).join(" ");},
    toggle:(name:string,on:boolean)=>{if(on)this.classList.add(name);else this.classList.remove(name);},contains:(name:string)=>this.className.split(" ").includes(name)};
  setAttribute(k:string,v:string){this.attributes.set(k,v);if(k==="data-testid")this.dataset.testid=v;}
  getAttribute(k:string){return this.attributes.get(k)??null;}
  append(...nodes:Node[]){for (const n of nodes) n.parent=this; this.children.push(...nodes);}
  prepend(...nodes:Node[]){for(const n of nodes)n.parent=this;this.children.unshift(...nodes);}
  replaceChildren(...nodes:Node[]){for(const old of this.children)old.parent=null;this.children=[];this.append(...nodes);}
  get visible(): boolean {
    if (this.hidden || this.tag === "dialog" && !this.open) return false;
    if (this.parent?.tag === "details" && !this.parent.open && this.tag !== "summary") return false;
    return this.parent?.visible ?? true;
  }
  visibleText(): string {
    return this.visible ? [this.textContent, ...this.children.map(n => n.visibleText())].filter(Boolean).join(" ") : "";
  }
  addEventListener(name:string,fn:(e:unknown)=>void){this.listeners.set(name,[...(this.listeners.get(name)??[]),fn]);}
  fire(name:string, properties:Record<string,unknown>={}) {
    const event={target:this, defaultPrevented:false, preventDefault(){this.defaultPrevented=true;}, ...properties};
    for(const fn of this.listeners.get(name)??[])fn(event);
    if (name === "cancel" && !event.defaultPrevented && this.open) this.close();
    if (name === "click" && this.tag === "summary" && this.parent) this.parent.open = !this.parent.open;
  }
  querySelector(selector:string):Node|null {return this.querySelectorAll(selector)[0]??(selector==="h2"?new Node("h2"):null);}
  querySelectorAll(selector:string):Node[]{return this.children.flatMap(n=>[...(matches(n,selector)?[n]:[]),...n.querySelectorAll(selector)]);}
  focus(){ if (this.isConnected && this.visible && !this.disabled) this.onFocus?.(this); }
  close(){ if (this.open) { this.open=false; this.fire("close"); } }
  showModal(){ this.open=true; }
  replaceWith(node:Node){
    const parent=this.parent;
    if(!parent)return;
    parent.children.splice(parent.children.indexOf(this),1,node);node.parent=parent;this.parent=null;
  }
  remove(){ if (this.parent) this.parent.children=this.parent.children.filter(n=>n!==this); this.parent=null; }
}
function matches(n:Node,selector:string):boolean {
  if(selector.includes(", ")) return selector.split(", ").some(s=>matches(n,s));
  if(selector.startsWith(".")) return n.classList.contains(selector.slice(1));
  if(selector.startsWith("#")) return n.id===selector.slice(1);
  if(selector==="dialog[open]") return n.tag==="dialog" && n.open;
  const attr=selector.match(/^\[(aria-controls|data-icon)="([^"]+)"\]$/); if(attr) return n.getAttribute(attr[1])===attr[2];
  const date=selector.match(/^\[data-date="([^"]+)"\]$/); if(date) return n.dataset.date===date[1];
  const test=selector.match(/data-testid="([^"]+)"/);if(test)return n.dataset.testid===test[1];
  if(selector==="[data-search-focus]")return !!n.dataset.searchFocus;
  if(selector==="[data-go]")return !!n.dataset.go;
  return n.tag===selector;
}
export async function until(predicate:()=>boolean){for(let i=0;i<250;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}assert.fail("Application did not reach expected UI state");}

export function bootDom(search = "") {
  const original={window:globalThis.window,document:globalThis.document,IntersectionObserver:globalThis.IntersectionObserver};
  let active: Node | null = null;
  const nodes:Node[]=[];const create=(tag:string)=>{const n=new Node(tag);n.onFocus=node=>{active=node;};nodes.push(n);return n;};
  const html=readFileSync(new URL("../../src/ui/index.html",import.meta.url),"utf8");
  const markup = html.slice(html.indexOf("<body>"), html.indexOf("</body>") + 7);
  const stack: Node[] = [];
  const voidTags = new Set(["input", "img", "br", "hr", "source", "wbr"]);
  let offset = 0;
  for(const match of markup.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b([^>]*)>/gi)){
    const parent = stack.at(-1);
    if (parent) parent.textContent += markup.slice(offset, match.index).trim();
    offset = match.index + match[0].length;
    if (match[1]) { stack.pop(); continue; }
    const n=create(match[2]);const attrs=match[3];
    parent?.append(n);
    if (!voidTags.has(n.tag)) stack.push(n);
    for(const [,key,value] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)){
      n.setAttribute(key,value);
      if(key==="id")n.id=value;else if(key==="class")n.className=value;
      else if(key==="data-testid")n.dataset.testid=value;else if(key==="data-go")n.dataset.go=value;
    }
    n.hidden=/\shidden(?:\s|$)/.test(attrs);n.inert=/\sinert(?:\s|$)/.test(attrs);
  }
  const id=(value:string)=>{const found=nodes.find(n=>n.id===value);assert.ok(found,value);return found;};
  const findTest=(value:string)=>nodes.find(n=>n.dataset.testid===value && n.isConnected);
  const byTest=(value:string)=>{const found=findTest(value);assert.ok(found,value);return found;};
  const query=(selector:string)=>selector.startsWith(".")?nodes.find(n=>n.classList.contains(selector.slice(1)))??null:nodes.find(n=>matches(n,selector))??null;
  const saved=new Map<string,string>(); const storage={getItem:(k:string)=>saved.get(k)??null,setItem:(k:string,v:string)=>{saved.set(k,v);},removeItem:(k:string)=>{saved.delete(k);}};
  const body=nodes[0],root=create("html"),windowEvents=new Node("window"),documentEvents=new Node("document");
  const doc = {body,documentElement:root,hidden:false,visibilityState:"visible",getElementById:id,querySelector:query,
    get activeElement(){return active?.isConnected ? active : body;},
    querySelectorAll:(selector:string)=>nodes.filter(n=>n.isConnected && matches(n,selector)),createElement:create,
    createElementNS:(_namespace:string,tag:string)=>create(tag),createTextNode:(value:string)=>{const n=create("text");n.textContent=value;return n;},
    addEventListener:documentEvents.addEventListener.bind(documentEvents)};
  const entries: unknown[] = [null];
  let pointer = 0;
  const history = {
    scrollRestoration:"auto",
    get state(){ return entries[pointer]; },
    pushState(state:unknown){ entries.splice(++pointer, Infinity, state); },
    replaceState(state:unknown){ entries[pointer]=state; },
    go(delta:number){
      const next=pointer+delta;
      if(next>=0 && next<entries.length) queueMicrotask(()=>{pointer=next;windowEvents.fire("popstate");});
    },
    back(){this.go(-1);},
    forward(){this.go(1);},
  };
  const observers = new Map<Node, (entries: unknown[]) => void>();
  Object.assign(globalThis,{
    document:doc,
    window:{localStorage:storage,history,location:{search},scrollY:0,scrollTo(_x:number,y:number){this.scrollY=y;},addEventListener:windowEvents.addEventListener.bind(windowEvents),setInterval:()=>0,
      setTimeout,clearTimeout,matchMedia:()=>({matches:false,addEventListener(){}})},
    IntersectionObserver:class{
      callback:(entries:unknown[])=>void;
      constructor(callback:(entries:unknown[])=>void){this.callback=callback;}
      observe(n:Node){observers.set(n,this.callback);}
      unobserve(n:Node){observers.delete(n);}
    },
  });
  function setHidden(hidden: boolean) {
    doc.hidden = hidden;
    doc.visibilityState = hidden ? "hidden" : "visible";
    documentEvents.fire("visibilitychange");
  }
  return { id, byTest, findTest, query, body, storage, history, active:()=>active, intersect:(n:Node)=>observers.get(n)?.([{target:n,isIntersecting:true}]), windowEvents, setHidden, restore: () => Object.assign(globalThis, original) };
}
