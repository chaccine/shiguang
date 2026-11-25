import test from "node:test";
import assert from "node:assert/strict";
import { PersonalUi } from "../src/ui/personal.ts";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";

let activeControl: Control | undefined;
class Control {
  value = ""; hidden = false; disabled = false; inert = false; textContent = ""; dataset: Record<string,string> = {}; style = {};
  children: Control[] = [];
  focusables: Control[] = []; isConnected = true;
  handlers = new Map<string, (() => void)[]>();
  addEventListener(name: string, fn: () => void): void { this.handlers.set(name,[...(this.handlers.get(name) ?? []),fn]); }
  fire(name: string, event: object = {preventDefault(){}}): void { for (const fn of this.handlers.get(name) ?? []) (fn as (e: object)=>void)(event); }
  focus(): void { activeControl = this; } close(): void {} replaceChildren(...nodes: Control[]): void { this.children=nodes; }
  querySelectorAll(): Control[] { return this.focusables; }
}
let tick = () => {};
async function until(predicate:()=>boolean):Promise<void> {
  for(let i=0;i<200;i++){tick(); if(predicate())return;await new Promise(r=>setTimeout(r,10));}
  assert.fail("UI operation did not settle");
}

test("app-lock UI enables/confirms, clears every password input, gates restart, rejects wrong code, changes and disables",async()=>{
  const originalWindow=globalThis.window, originalDocument=globalThis.document;
  const elements=new Map<string,Control>(); const get=(id:string)=>{let n=elements.get(id);if(!n){n=new Control();elements.set(id,n);}return n;};
  const shell=get("shell"), root=get("root"); let nativeFocus: ((e:{payload:boolean})=>void)|undefined;
  const background=new Control();
  Object.assign(globalThis,{
    window:{localStorage:{getItem:()=>null,setItem:()=>{}},setInterval:(fn:()=>void)=>{tick=fn;return 0;},
      matchMedia:()=>({matches:false,addEventListener(){}}),addEventListener:(name:string,fn:()=>void)=>background.addEventListener(name,fn),
      __TAURI__:{window:{getCurrentWindow:()=>({onFocusChanged:async(fn:(e:{payload:boolean})=>void)=>{nativeFocus=fn;return ()=>{};}})}}},
    document:{hidden:false,documentElement:root,get activeElement(){return activeControl;},querySelector:(selector:string)=>selector===".app-shell"?shell:get(selector.match(/data-testid="([^"]+)"/)![1]),
      querySelectorAll:()=>[],addEventListener(){},createElement:()=>new Control()},
  });
  try {
    const api=new MemoryAdapter({search:""}); const ui=new PersonalUi(api,true,async()=>true); await ui.start();
    assert.equal(shell.inert,false);
    get("lock-new").value="1234"; get("lock-confirm").value="5678"; get("lock-settings-form").fire("submit");
    await until(()=>get("lock-feedback").textContent.includes("相同"));
    assert.equal((await api.getSettings()).appLock.enabled,false);
    get("lock-new").value=get("lock-confirm").value="482615";get("lock-settings-form").fire("submit");
    await until(()=>get("lock-feedback").textContent==="口令已设置。");
    for(const id of ["lock-new","lock-current","lock-confirm"]) assert.equal(get(id).value,"");
    get("lock-now").focus();get("lock-now").fire("click");assert.equal(shell.inert,true);assert.equal(get("app-lock-screen").hidden,false);
    const gate = get("app-lock-screen"), passcode = get("app-passcode"), unlock = get("app-unlock");
    gate.focusables = [passcode, unlock]; assert.equal(activeControl, passcode);
    let prevented = false; unlock.focus(); gate.fire("keydown", {key:"Tab",shiftKey:false,preventDefault(){prevented=true;}});
    assert.equal(prevented,true); assert.equal(activeControl,passcode);
    prevented=false; gate.fire("keydown", {key:"Tab",shiftKey:true,preventDefault(){prevented=true;}});
    assert.equal(prevented,true); assert.equal(activeControl,unlock);
    get("app-passcode").value="1111";get("unlock-form").fire("submit");
    await until(()=>get("unlock-feedback").textContent.includes("不正确"));
    await until(()=>!get("app-unlock").disabled);
    assert.equal(shell.inert,true);assert.equal(get("app-passcode").value,"");
    for (let attempt = 0; attempt < 2; attempt++) {
      get("unlock-feedback").textContent = "";
      get("app-passcode").value = "1111"; get("unlock-form").fire("submit");
      await until(() => get("unlock-feedback").textContent.length > 0);
      if (attempt === 0) await until(() => !get("app-unlock").disabled);
    }
    assert.equal(get("app-unlock").disabled, true);
    assert.match(get("unlock-feedback").textContent, /秒后重试/);
    assert.equal(get("app-passcode").value, "");
    await until(() => !get("app-unlock").disabled);
    get("app-passcode").value="482615";get("unlock-form").fire("submit");
    await until(()=>!shell.inert);assert.equal(get("app-passcode").value,"");
    assert.equal(activeControl,get("lock-now"));
    nativeFocus!({payload:false});assert.equal(shell.inert,true);nativeFocus!({payload:true});assert.equal(shell.inert,false);
    get("lock-feedback").textContent="";
    get("lock-current").value="482615";get("lock-new").value=get("lock-confirm").value="735182";get("lock-settings-form").fire("submit");
    await until(()=>get("lock-feedback").textContent==="口令已设置。");
    for (const control of elements.values()) control.handlers.clear();
    get("unlock-hint").textContent="";
    const restarted=new PersonalUi(api,true,async()=>true); const start=restarted.start();
    await until(()=>get("unlock-hint").textContent.includes("输入口令"));assert.equal(shell.inert,true);
    get("app-passcode").value="735182";get("unlock-form").fire("submit");await start;
    await until(()=>!get("app-unlock").disabled);
    get("lock-current").value="735182";get("lock-disable").fire("click");
    await until(()=>get("lock-feedback").textContent==="已关闭应用锁。");assert.equal((await api.getSettings()).appLock.enabled,false);
    for(const id of ["lock-new","lock-current","lock-confirm","app-passcode"]) assert.equal(get(id).value,"");
    get("theme-select").value="dark"; get("theme-select").fire("change");
    await until(()=>root.dataset.theme==="dark"); assert.equal((await api.getSettings()).theme,"dark");
    await restarted.renderStorage();assert.equal(get("storage-stats").children.length,12);assert.match(get("storage-space").textContent,/未知/);
    const stats=await api.storageStats(); api.storageStats=async()=>({...stats,available:1024});
    await restarted.renderStorage();assert.match(get("storage-space").textContent,/不足 512 MB/);
  } finally {Object.assign(globalThis,{window:originalWindow,document:originalDocument});}
});

test("Mine privacy museum reset entry restores hidden preferences with honest failure feedback", async () => {
  const original = { window: globalThis.window, document: globalThis.document };
  const controls = new Map<string, Control>();
  const get = (id: string) => { let n = controls.get(id); if (!n) { n = new Control(); controls.set(id, n); } return n; };
  Object.assign(globalThis, {
    window: { localStorage: { getItem: () => null, setItem() {} }, setInterval: () => 0, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document: { documentElement: get("root"), querySelector: (s: string) => s === ".app-shell" ? get("shell") : get(s.match(/data-testid="([^"]+)"/)![1]),
      querySelectorAll: () => [], addEventListener() {} },
  });
  try {
    const api = new MemoryAdapter({ search: "" });
    const id = (await api.createDraft({ body: "合成记录", eventDate: "2024-11-12" })).row.recordId;
    await api.commitRecord(id, 0); await api.setMuseumHidden(id, true);
    new PersonalUi(api, true, async () => true);
    api.failNext("DISK_FULL", "resetMuseumHidden"); get("museum-hidden-reset").fire("click");
    await until(() => !get("museum-hidden-reset").disabled);
    assert.equal((await api.getRecord(id)).museumHidden, true); assert.ok(get("museum-hidden-feedback").textContent);
    get("museum-hidden-reset").fire("click"); await until(() => !get("museum-hidden-reset").disabled);
    assert.match(get("museum-hidden-feedback").textContent, /已恢复 1 条记录/);
    assert.equal((await api.getRecord(id)).museumHidden, false);
  } finally { Object.assign(globalThis, original); }
});
