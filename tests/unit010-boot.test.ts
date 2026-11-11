import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import { PREVIEW_STORAGE_KEY } from "../src/ui/demo.ts";

/** Minimal event DOM for exercising the real application bootstrap without a browser process.
 * Layout, CSS, focus delivery and image decoding are deliberately not simulated. */
class Node {
  tag: string; id=""; value=""; hidden=false; disabled=false; checked=false; inert=false; scrollTop=0;
  textContent=""; className=""; dataset:Record<string,string>={}; style={}; children:Node[]=[];
  attributes=new Map<string,string>(); listeners=new Map<string,Array<(e:unknown)=>void>>();
  constructor(tag:string){this.tag=tag;}
  classList={add:(...names:string[])=>{this.className+=" "+names.join(" ");},remove:(...names:string[])=>{this.className=this.className.split(" ").filter(n=>!names.includes(n)).join(" ");},
    toggle:(name:string,on:boolean)=>{if(on)this.classList.add(name);else this.classList.remove(name);},contains:(name:string)=>this.className.split(" ").includes(name)};
  setAttribute(k:string,v:string){this.attributes.set(k,v);if(k==="data-testid")this.dataset.testid=v;}
  getAttribute(k:string){return this.attributes.get(k)??null;}
  append(...nodes:Node[]){this.children.push(...nodes);}
  replaceChildren(...nodes:Node[]){this.children=nodes;}
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
async function until(predicate:()=>boolean){for(let i=0;i<250;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}assert.fail("Application did not reach expected UI state");}
test("real bootstrap opens timeline, all five navigation actions work, Mine reaches drafts, reading edit preserves formal",async()=>{
  const original={window:globalThis.window,document:globalThis.document,IntersectionObserver:globalThis.IntersectionObserver};
  const nodes:Node[]=[];const create=(tag:string)=>{const n=new Node(tag);nodes.push(n);return n;};
  const html=readFileSync(new URL("../src/ui/index.html",import.meta.url),"utf8");
  for(const match of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)){
    const n=create(match[1]);const attrs=match[2];
    for(const [,key,value] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)){
      if(key==="id")n.id=value;else if(key==="class")n.className=value;
      else if(key==="data-testid")n.dataset.testid=value;else if(key==="data-go")n.dataset.go=value;
    }n.hidden=/\bhidden\b/.test(attrs);n.inert=/\binert\b/.test(attrs);
  }
  const id=(value:string)=>nodes.find(n=>n.id===value)!;
  const byTest=(value:string)=>nodes.find(n=>n.dataset.testid===value)!;
  const query=(selector:string)=>selector.startsWith(".")?nodes.find(n=>n.classList.contains(selector.slice(1)))??null:nodes.find(n=>matches(n,selector))??null;
  const saved=new Map<string,string>(); const storage={getItem:(k:string)=>saved.get(k)??null,setItem:(k:string,v:string)=>{saved.set(k,v);},removeItem:(k:string)=>{saved.delete(k);}};
  const api=new MemoryAdapter({storage,storageKey:PREVIEW_STORAGE_KEY,search:""});
  const record=(await api.createDraft({body:"合成正式正文",eventDate:"2026-11-11"})).row.recordId;await api.commitRecord(record,0);
  const formal=(await api.getRecord(record)).formal;
  storage.setItem("shiguang.lastTab","settings");
  const body=create("body"),root=create("html");
  Object.assign(globalThis,{
    document:{body,documentElement:root,hidden:false,visibilityState:"visible",getElementById:id,querySelector:query,
      querySelectorAll:(selector:string)=>nodes.filter(n=>matches(n,selector)),createElement:create,createTextNode:()=>create("text"),addEventListener(){}},
    window:{localStorage:storage,location:{search:""},scrollY:0,scrollTo(){},addEventListener(){},setInterval:()=>0,
      setTimeout,clearTimeout,matchMedia:()=>({matches:false,addEventListener(){}})},
    IntersectionObserver:class{observe(){}},
  });
  try {
    await import("../src/ui/main.ts");await until(()=>body.dataset.appReady==="1");
    assert.equal(id("view-timeline").hidden,false);assert.equal(byTest("app-lock-screen").hidden,true);
    const nav=id("nav-tabs");assert.equal(nav.children.length,5);
    assert.deepEqual(nav.children.map(n=>n.dataset.navTab),["timeline","calendar","create","museum","mine"]);
    byTest("museum-tab").fire("click");await until(()=>!id("view-museum").hidden);
    byTest("mine-tab").fire("click");await until(()=>!id("view-mine").hidden);
    byTest("drafts-tab").fire("click");await until(()=>!id("view-drafts").hidden);
    byTest("create-tab").fire("click");await until(()=>!id("view-editor").hidden);
    byTest("editor-location").value="合成新地点";byTest("editor-location").fire("input");
    byTest("editor-mood").value="开心";byTest("editor-mood").fire("change");
    byTest("timeline-tab").fire("click");await until(()=>!id("view-timeline").hidden);
    const newDraft=(await api.listDrafts())[0];assert.equal(newDraft.draft!.location,"合成新地点");assert.equal(newDraft.draft!.mood,"开心");
    // A newly rendered card has a real click handler into the read-first view.
    const card=id("timeline-list").querySelector('[data-testid="edit-button"]')!;assert.ok(card);card.fire("click");
    await until(()=>!id("view-reading").hidden);assert.equal((await api.getRecord(record)).draft,null);
    byTest("reading-edit").fire("click");await until(()=>!id("view-editor").hidden);
    byTest("editor-body").value="合成修改草稿";byTest("editor-body").fire("input");
    byTest("back-to-drafts").fire("click");await until(()=>!id("view-reading").hidden);
    assert.deepEqual((await api.getRecord(record)).formal,formal);assert.equal((await api.getRecord(record)).draft!.body,"合成修改草稿");
    byTest("reading-back").fire("click");assert.equal(id("view-timeline").hidden,false);
    byTest("calendar-tab").fire("click");await until(()=>!id("view-calendar").hidden);
    byTest("cal-month-input").value="2026-11";byTest("cal-month-input").fire("change");
    await until(()=>id("cal-grid").children.some(n=>n.dataset.date==="2026-11-11"));
    id("cal-grid").children.find(n=>n.dataset.date==="2026-11-11")!.fire("click");
    await until(()=>!!id("day-panel-list").querySelector('[data-testid="edit-button"]'));
    const dateText=id("day-panel-date").textContent;
    id("day-panel-list").querySelector('[data-testid="edit-button"]')!.fire("click");
    await until(()=>!id("view-reading").hidden);assert.equal(byTest("calendar-tab").getAttribute("aria-selected"),"true");
    byTest("reading-back").fire("click");assert.equal(id("view-calendar").hidden,false);assert.equal(id("day-panel-date").textContent,dateText);
  } finally {Object.assign(globalThis,original);}
});
