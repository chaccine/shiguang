import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Minimal event DOM for exercising the real application bootstrap without a browser process.
 * Layout, CSS, focus delivery and image decoding are deliberately not simulated. */
class Node {
  tag: string; id=""; value=""; hidden=false; disabled=false; checked=false; inert=false; scrollTop=0;
  textContent=""; className=""; dataset:Record<string,string>={}; style={}; children:Node[]=[];
  parent: Node | null = null;
  attributes=new Map<string,string>(); listeners=new Map<string,Array<(e:unknown)=>void>>();
  constructor(tag:string){this.tag=tag;}
  classList={add:(...names:string[])=>{this.className+=" "+names.join(" ");},remove:(...names:string[])=>{this.className=this.className.split(" ").filter(n=>!names.includes(n)).join(" ");},
    toggle:(name:string,on:boolean)=>{if(on)this.classList.add(name);else this.classList.remove(name);},contains:(name:string)=>this.className.split(" ").includes(name)};
  setAttribute(k:string,v:string){this.attributes.set(k,v);if(k==="data-testid")this.dataset.testid=v;}
  getAttribute(k:string){return this.attributes.get(k)??null;}
  append(...nodes:Node[]){for (const n of nodes) n.parent=this; this.children.push(...nodes);}
  replaceChildren(...nodes:Node[]){this.children=[]; this.append(...nodes);}
  get visible(): boolean { return !this.hidden && (this.parent?.visible ?? true); }
  visibleText(): string {
    return this.visible ? [this.textContent, ...this.children.map(n => n.visibleText())].filter(Boolean).join(" ") : "";
  }
  addEventListener(name:string,fn:(e:unknown)=>void){this.listeners.set(name,[...(this.listeners.get(name)??[]),fn]);}
  fire(name:string){for(const fn of this.listeners.get(name)??[])fn({target:this,preventDefault(){}});}
  querySelector(selector:string):Node|null {return this.querySelectorAll(selector)[0]??(selector==="h2"?new Node("h2"):null);}
  querySelectorAll(selector:string):Node[]{return this.children.flatMap(n=>[...(matches(n,selector)?[n]:[]),...n.querySelectorAll(selector)]);}
  focus(){} close(){} showModal(){} remove(){}
}
function matches(n:Node,selector:string):boolean {
  const test=selector.match(/data-testid="([^"]+)"/);if(test)return n.dataset.testid===test[1];
  if(selector==="[data-go]")return !!n.dataset.go;
  return n.tag===selector;
}
export async function until(predicate:()=>boolean){for(let i=0;i<250;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}assert.fail("Application did not reach expected UI state");}

export function bootDom(search = "") {
  const original={window:globalThis.window,document:globalThis.document,IntersectionObserver:globalThis.IntersectionObserver};
  const nodes:Node[]=[];const create=(tag:string)=>{const n=new Node(tag);nodes.push(n);return n;};
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
      if(key==="id")n.id=value;else if(key==="class")n.className=value;
      else if(key==="data-testid")n.dataset.testid=value;else if(key==="data-go")n.dataset.go=value;
    }
    n.hidden=/\shidden(?:\s|$)/.test(attrs);n.inert=/\sinert(?:\s|$)/.test(attrs);
  }
  const id=(value:string)=>{const found=nodes.find(n=>n.id===value);assert.ok(found,value);return found;};
  const findTest=(value:string)=>nodes.find(n=>n.dataset.testid===value);
  const byTest=(value:string)=>{const found=findTest(value);assert.ok(found,value);return found;};
  const query=(selector:string)=>selector.startsWith(".")?nodes.find(n=>n.classList.contains(selector.slice(1)))??null:nodes.find(n=>matches(n,selector))??null;
  const saved=new Map<string,string>(); const storage={getItem:(k:string)=>saved.get(k)??null,setItem:(k:string,v:string)=>{saved.set(k,v);},removeItem:(k:string)=>{saved.delete(k);}};
  const body=nodes[0],root=create("html"),windowEvents=new Node("window"),documentEvents=new Node("document");
  const doc = {body,documentElement:root,hidden:false,visibilityState:"visible",getElementById:id,querySelector:query,
    querySelectorAll:(selector:string)=>nodes.filter(n=>matches(n,selector)),createElement:create,createTextNode:()=>create("text"),
    addEventListener:documentEvents.addEventListener.bind(documentEvents)};
  Object.assign(globalThis,{
    document:doc,
    window:{localStorage:storage,location:{search},scrollY:0,scrollTo(){},addEventListener:windowEvents.addEventListener.bind(windowEvents),setInterval:()=>0,
      setTimeout,clearTimeout,matchMedia:()=>({matches:false,addEventListener(){}})},
    IntersectionObserver:class{observe(){}},
  });
  function setHidden(hidden: boolean) {
    doc.hidden = hidden;
    doc.visibilityState = hidden ? "hidden" : "visible";
    documentEvents.fire("visibilitychange");
  }
  return { id, byTest, findTest, query, body, storage, windowEvents, setHidden, restore: () => Object.assign(globalThis, original) };
}
