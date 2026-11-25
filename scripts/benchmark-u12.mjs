// Synthetic search benchmark only. No browser, network, media decoding or UI.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { cpus, platform, arch, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { searchPage } from '../src/domain/search.ts';
import { MemoryAdapter } from '../src/platform/memory-adapter.ts';
import { KEY, TODAY, photos, stateWithRows, storage, syntheticRows } from '../tests/support/museum.ts';

const rows = syntheticRows(5000);
const tags = [
  {tagId:'tag-100001',name:'校园旅行 Travel',normName:'校园旅行 travel',createdAt:'2026-01-01T00:00:00Z'},
  {tagId:'tag-100002',name:'日常 Daily',normName:'日常 daily',createdAt:'2026-01-01T00:00:01Z'},
];
rows.forEach((r,i) => {
  r.formal.title = `合成旅程 Synthetic memory ${i+1}`;
  r.formal.body = '合成日记：今天走过河边，与朋友记录一段普通生活。 English readable paragraph. '.repeat(24)
    + (i%5===0 ? ' UniqueNeedle 第一次坐火车。' : ' 普通结尾。');
  r.formal.location = '合成地点 Synthetic station';
  r.tagIds = [tags[i%2].tagId]; r.favorite = i%3===0; r.museumHidden = i%37===0;
  if (i%4!==0) { photos(r,i%2+1); r.formal.photos.forEach((p,j) => {p.caption=`合成照片说明 ${j} Sunny trip. `.repeat(4);}); }
});
const state = stateWithRows(rows); state.tags=tags;state.tagDictRevision=2;
const serialized = JSON.stringify(state), saved=storage(); saved.setItem(KEY,serialized);
const filter={keyword:'uniqueneedle'}, budgetMs=10000;
const timings=[];
async function timed(name, fn) {
  const start=performance.now(), page=await fn(), ms=performance.now()-start;
  assert.equal(page.total,1000);assert.equal(page.items.length,50);
  assert.ok(ms<budgetMs,`${name}: ${ms}ms >= ${budgetMs}ms`);
  timings.push({name,ms:Number(ms.toFixed(3)),returned:page.items.length,total:page.total});return page;
}
await timed('domainFirstCall',()=>searchPage(rows,tags,filter,null,50,TODAY));
for(let i=0;i<3;i++)await timed(`domainWarmFirst${i+1}`,()=>searchPage(rows,tags,filter,null,50,TODAY));
let api;
let page=await timed('adapterColdOpenAndFirst',()=>{
  api=new MemoryAdapter({storage:saved,storageKey:KEY,search:''});
  return api.searchPage(filter,null,50,TODAY);
});
for(let i=0;i<3;i++)await timed(`adapterWarmFirst${i+1}`,()=>api.searchPage(filter,null,50,TODAY));
const seen=new Set(page.items.map(r=>r.recordId));
for(let i=0;i<3;i++){
  page=await timed(`adapterPage${i+2}`,()=>api.searchPage(filter,page.nextCursor,50,TODAY));
  for(const row of page.items){assert.ok(!seen.has(row.recordId));seen.add(row.recordId);}
}
const start=performance.now(); const combined=await api.searchPage({keyword:'uniqueneedle',tagIds:tags.map(t=>t.tagId),
  from:'2000-01-01',to:'2029-12-31',favoriteOnly:true,hasPhoto:true},null,50,TODAY);
const combinedMs=performance.now()-start;assert.ok(combinedMs<budgetMs);assert.equal(combined.total,250);assert.equal(combined.items.length,50);
timings.push({name:'adapterCombinedFirst',ms:Number(combinedMs.toFixed(3)),returned:combined.items.length,total:combined.total});
assert.equal(saved.getItem(KEY),serialized);
const sizeRange = values => ({min:Math.min(...values.map(v=>Buffer.byteLength(v))),max:Math.max(...values.map(v=>Buffer.byteLength(v)))});
const report={runtime:process.version,machine:{platform:platform(),arch:arch(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryBytes:totalmem()},
  records:5000,photoUses:rows.reduce((n,r)=>n+r.formal.photos.length,0),tags:2,stateBytes:Buffer.byteLength(serialized),
  fieldUtf8Bytes:{title:sizeRange(rows.map(r=>r.formal.title)),body:sizeRange(rows.map(r=>r.formal.body)),location:sizeRange(rows.map(r=>r.formal.location)),
    caption:sizeRange(rows.flatMap(r=>r.formal.photos.map(p=>p.caption))),tagName:sizeRange(tags.map(t=>t.name))},
  perCallRegressionBudgetMs:budgetMs,timings,distinctAcrossFourPages:seen.size,
  scope:'Synthetic Node/Linux only. Cold = new adapter plus storage parse/validation and first query; OS caches not flushed. No images decoded, no IPC or device PASS.'};
console.log(JSON.stringify(report,null,2));
if(process.env.SHIGUANG_SEARCH_STRESS_OUT)writeFileSync(process.env.SHIGUANG_SEARCH_STRESS_OUT,JSON.stringify(report,null,2)+'\n');
