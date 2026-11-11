import test from "node:test";
import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import { MemoryAdapter } from "../src/platform/memory-adapter.ts";
import type { PreviewBackup } from "../src/platform/memory-adapter.ts";
import { createTauriApi } from "../src/platform/tauri-adapter.ts";
import { sha256 } from "../src/platform/bytes.ts";
import { backoffMs } from "../src/platform/preview-lock.ts";
import type { ThemePreference } from "../src/domain/types.ts";

const key="u010-lock-synthetic";
const code=(wanted:string)=>(e:unknown)=>{assert.equal((e as {code:string}).code,wanted);return true;};
function storage(){const data=new Map<string,string>();let broken=false;return {data,breakWrites:(value:boolean)=>{broken=value;},getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{if(broken)throw new Error("synthetic write failure");data.set(k,v);}};}
function device(){const saved=storage();let now=1_000_000;const options={storage:saved,storageKey:key,lockNowMs:()=>now,search:""};return {saved,api:new MemoryAdapter(options),reopen:()=>new MemoryAdapter(options),advance:(ms:number)=>{now+=ms;}};}
function credential(saved:ReturnType<typeof storage>){return JSON.parse(saved.getItem(key)!).settings.appLock;}
async function pick(api:MemoryAdapter,pkg:PreviewBackup){api.setNextPickedPackage(pkg);const p=await api.pickBackup();if(p.cancelled)throw new Error("synthetic pick missing");return p.token;}
function repack(body:unknown):PreviewBackup{const text=JSON.stringify(body),bytes=new TextEncoder().encode(text);return {magic:"SGBAK-PREVIEW",body:text,bytes:bytes.length,sha256:sha256(bytes)};}

test("U010 settings default to system and lock off; format errors never echo submitted values",async()=>{
  const {api,saved}=device();assert.deepEqual(await api.getSettings(),{theme:"system",appLock:{enabled:false,failedAttempts:0,retryAfterMs:0}});
  await assert.rejects(api.verifyAppLock("482615"),code("APP_LOCK_NOT_SET"));
  for(const bad of ["","123","123456789","１２３４","12 34","1234\n","1234\r","1234\r\n","<script>synthetic</script>"]){
    await assert.rejects(api.setAppLock(bad),(e:unknown)=>{code("APP_LOCK_CODE_INVALID")(e);if(bad)assert.ok(!JSON.stringify(e).includes(bad));return true;});
    assert.equal(saved.getItem(key),null);
  }
  await assert.rejects(api.setTheme("blue" as ThemePreference),code("THEME_INVALID"));assert.equal(saved.getItem(key),null);
});

test("U010 preview uses actual salted WebCrypto PBKDF2 and never exposes verifier in settings",async()=>{
  const a=device(),b=device();await a.api.setAppLock("482615");await b.api.setAppLock("482615");const x=credential(a.saved),y=credential(b.saved);
  assert.equal(x.algorithm,"pbkdf2-sha256-preview");assert.equal(x.iterations,100000);assert.notEqual(x.salt,y.salt);assert.notEqual(x.hash,y.hash);
  assert.equal(x.hash,pbkdf2Sync("482615",Buffer.from(x.salt,"hex"),100000,32,"sha256").toString("hex"));
  assert.ok(!a.saved.getItem(key)!.includes('"482615"'));
  const view=JSON.stringify(await a.api.getSettings());for(const secret of [x.hash,x.salt,"482615"])assert.ok(!view.includes(secret));
});

test("U010 set/verify/change/disable require current code and survive restart",async()=>{
  const d=device();let api=d.api;await api.setAppLock("482615");await assert.rejects(api.setAppLock("123456"),code("APP_LOCK_ALREADY_SET"));
  await assert.rejects(api.verifyAppLock("wrong-synthetic"),code("APP_LOCK_WRONG"));assert.equal((await api.getSettings()).appLock.failedAttempts,1);
  await api.verifyAppLock("482615");assert.equal((await api.getSettings()).appLock.failedAttempts,0);
  await assert.rejects(api.changeAppLock("wrong-synthetic","123456"),code("APP_LOCK_WRONG"));const before=d.saved.getItem(key);
  await assert.rejects(api.changeAppLock("482615","invalid-new"),code("APP_LOCK_CODE_INVALID"));assert.equal(d.saved.getItem(key),before);
  const old=credential(d.saved);await api.changeAppLock("482615","123456");assert.notEqual(credential(d.saved).salt,old.salt);
  api=d.reopen();await assert.rejects(api.verifyAppLock("482615"),code("APP_LOCK_WRONG"));await api.verifyAppLock("123456");
  await assert.rejects(api.disableAppLock("482615"),code("APP_LOCK_WRONG"));await api.disableAppLock("123456");
  assert.equal((await d.reopen().getSettings()).appLock.enabled,false);assert.equal(credential(d.saved),null);
});

test("U010 exponential backoff persists across restart and blocks correct code until expiry",async()=>{
  const d=device();let api=d.api;await api.setAppLock("482615");
  for(let failures=1;failures<=20;failures++){
    await assert.rejects(api.verifyAppLock("invalid"),code("APP_LOCK_WRONG"));const delay=backoffMs(failures);api=d.reopen();
    assert.deepEqual((await api.getSettings()).appLock,{enabled:true,failedAttempts:failures,retryAfterMs:delay});
    if(delay){
      const before=d.saved.getItem(key);
      for(const op of [()=>api.verifyAppLock("482615"),()=>api.changeAppLock("482615","123456"),()=>api.disableAppLock("482615")])await assert.rejects(op(),code("APP_LOCK_THROTTLED"));
      await assert.rejects(api.setAppLock("123456"),code("APP_LOCK_ALREADY_SET"));assert.equal(d.saved.getItem(key),before);
    }
    d.advance(delay);
  }
  assert.equal(backoffMs(0xffffffff),3_600_000);await api.verifyAppLock("482615");assert.deepEqual((await api.getSettings()).appLock,{enabled:true,failedAttempts:0,retryAfterMs:0});
});

test("U010 concurrent settings/auth operations preserve counters and concurrent draft writes",async()=>{
  const d=device(),other=d.reopen();const set=await Promise.allSettled([d.api.setAppLock("482615"),other.setAppLock("123456")]);
  assert.equal(set.filter((r)=>r.status==="fulfilled").length,1);assert.equal((set[1] as PromiseRejectedResult).reason.code,"APP_LOCK_ALREADY_SET");
  const id=(await d.api.createDraft({body:"旧合成正文",eventDate:"2026-11-09"})).row.recordId;
  const pending=d.api.verifyAppLock("482615");await other.saveDraft({recordId:id,body:"在密码派生期间保存的合成正文"});await pending;
  assert.equal((await d.api.getRecord(id)).draft!.body,"在密码派生期间保存的合成正文");
  const results=await Promise.allSettled(Array.from({length:6},(_,i)=>(i%2?other:d.api).verifyAppLock("invalid")));
  assert.equal(results.filter((r)=>r.status==="rejected"&&r.reason.code==="APP_LOCK_WRONG").length,3);
  assert.equal(results.filter((r)=>r.status==="rejected"&&r.reason.code==="APP_LOCK_THROTTLED").length,3);
  assert.equal((await d.api.getSettings()).appLock.failedAttempts,3);
});

test("U010 settings I/O failures grant no success and preserve credential, content and counters",async()=>{
  for(const op of ["set","change","disable","verify","wrong","theme"]){
    const d=device();const id=(await d.api.createDraft({body:"合成正文",eventDate:"2026-11-09"})).row.recordId;
    if(op!=="set")await d.api.setAppLock("482615");const before=d.saved.getItem(key);d.saved.breakWrites(true);
    const result=op==="set"?d.api.setAppLock("482615"):op==="change"?d.api.changeAppLock("482615","123456"):op==="disable"?d.api.disableAppLock("482615"):op==="verify"?d.api.verifyAppLock("482615"):op==="wrong"?d.api.verifyAppLock("invalid"):d.api.setTheme("dark");
    await assert.rejects(result,code("PERSIST_REPLACE_FAILED"));assert.equal(d.saved.getItem(key),before);d.saved.breakWrites(false);
    assert.equal((await d.reopen().getRecord(id)).draft!.body,"合成正文");
  }
});

test("U010 theme survives restart/overwrite, merge retains local preference and no content publication",async()=>{
  const d=device(),id=(await d.api.createDraft({body:"合成正文",eventDate:"2026-11-09",location:"待提交地点"})).row.recordId;
  const row=await d.api.getRecord(id);await d.api.setAppLock("482615");const lock=credential(d.saved);
  for(const theme of ["light","dark","system"] as const){await d.api.setTheme(theme);assert.equal((await d.reopen().getSettings()).theme,theme);assert.deepEqual(await d.api.getRecord(id),row);assert.deepEqual(credential(d.saved),lock);}
  const src=device();await src.api.setTheme("dark");await src.api.exportBackup();await d.api.restoreBackup(await pick(d.api,src.api.lastExportedPackage()!));assert.equal((await d.api.getSettings()).theme,"dark");assert.deepEqual(credential(d.saved),lock);
  await d.api.setTheme("light");await d.api.mergeBackup(await pick(d.api,src.api.lastExportedPackage()!));assert.equal((await d.api.getSettings()).theme,"light");assert.deepEqual(credential(d.saved),lock);
});

test("U010 portable backup omits credential; crafted incoming lock never overrides local lock or backoff",async()=>{
  const src=device();await src.api.setAppLock("123456");const rawCredential=credential(src.saved);await src.api.exportBackup();const pkg=src.api.lastExportedPackage()!;
  const body=JSON.parse(pkg.body);assert.equal(body.state.settings.appLock,null);assert.ok(!pkg.body.includes(rawCredential.hash));
  // A valid, maliciously supplied lock is ignored in both import modes.
  body.state.settings.appLock=rawCredential;const crafted=repack(body);
  for(const merge of [false,true])for(const locked of [false,true]){
    const d=device();if(locked){await d.api.setAppLock("482615");await assert.rejects(d.api.verifyAppLock("invalid"),code("APP_LOCK_WRONG"));}
    const before=locked?credential(d.saved):null,token=await pick(d.api,crafted);
    if(merge)await d.api.mergeBackup(token);else await d.api.restoreBackup(token);
    assert.deepEqual(credential(d.saved),before);
  }
});

test("U010 v3 restore cannot disable existing device lock or reset its waiting counter",async()=>{
  const src=device();await src.api.exportBackup();const body=JSON.parse(src.api.lastExportedPackage()!.body);body.manifest.schemaVersion=3;body.state.schemaVersion=3;delete body.state.settings;
  const d=device();await d.api.setAppLock("482615");for(let i=0;i<3;i++)await assert.rejects(d.api.verifyAppLock("invalid"),code("APP_LOCK_WRONG"));
  const before=credential(d.saved);await d.api.restoreBackup(await pick(d.api,repack(body)));assert.deepEqual(credential(d.saved),before);await assert.rejects(d.api.verifyAppLock("482615"),code("APP_LOCK_THROTTLED"));
});

test("U010 corrupt lock fails closed; diagnostics and production sources have no credential logging",async()=>{
  const d=device();await d.api.setAppLock("482615");const lock=credential(d.saved),errors:unknown[]=[];
  for(const op of [()=>d.api.setAppLock("482615"),()=>d.api.verifyAppLock("invalid"),()=>d.api.changeAppLock("invalid","482615")])try{await op();}catch(e){errors.push(e);}
  const text=JSON.stringify(errors);for(const secret of ["482615",lock.hash,lock.salt])assert.ok(!text.includes(secret));
  const bad=JSON.parse(d.saved.getItem(key)!);bad.settings.appLock.iterations=1;d.saved.setItem(key,JSON.stringify(bad));const before=d.saved.getItem(key);assert.throws(()=>d.reopen(),code("STATE_CORRUPT"));assert.equal(d.saved.getItem(key),before);
  for(const file of ["../src/platform/preview-lock.ts","../src-tauri/src/u010_cmd.rs"]){const production=readFileSync(new URL(file,import.meta.url),"utf8");for(const pattern of [/console\.(log|debug|error|warn)\s*\(/,/\b(?:println|eprintln|dbg)!/,/\b(?:log|tracing)::/])assert.ok(!pattern.test(production));}
});

test("U010 Tauri settings/lock commands pass exact arguments and are registered",async()=>{
  const calls:unknown[]=[];const api=createTauriApi(async<T>(command:string,args?:Record<string,unknown>)=>{calls.push([command,args]);return {} as T;});
  await api.getSettings();await api.setTheme("dark");await api.setAppLock("482615");await api.verifyAppLock("482615");await api.changeAppLock("482615","123456");await api.disableAppLock("123456");
  assert.deepEqual(calls,[["get_settings",undefined],["set_theme",{theme:"dark"}],["set_app_lock",{passcode:"482615"}],["verify_app_lock",{passcode:"482615"}],["change_app_lock",{currentPasscode:"482615",newPasscode:"123456"}],["disable_app_lock",{currentPasscode:"123456"}]]);
  const source=readFileSync(new URL("../src-tauri/src/lib.rs",import.meta.url),"utf8");for(const [command] of calls as [string,unknown][])assert.ok(source.includes(`u010_cmd::${command}`));
});
