/** M04 projections over authoritative formal rows. No media reads or writes. */
import type { MuseumPhotoPage, MuseumPhotoTile, MuseumReunionGroup, MuseumReunionPage, MuseumShuffle,
  MuseumSummary, MuseumYear, MuseumYearRoom, RecordRow, SortOrder, TimelineItem, TimelinePage } from "./types.ts";
import { compareKeys, compareRows, decodeCursor, encodeCursor, isFormalActive, keyOf,
  pageRows, reunionRows, sortedFormal, toItem } from "./timeline.ts";
import type { FormalRow } from "./timeline.ts";
import { isValidDate } from "./rules.ts";

export const MUSEUM_PREVIEW_LIMIT = 6;
export const MUSEUM_FEATURED_LIMIT = 6;
function date(today: string): void {
  if (!isValidDate(today)) throw { code: "INVALID_EVENT_DATE", message: "日期无效" };
}
function eligible(row: FormalRow, today: string): boolean { return !row.museumHidden && row.formal.eventDate <= today; }
function museumItem(row: FormalRow, today: string): TimelineItem {
  return { ...toItem(row,today), title:row.formal.title,
    excerpt:[...row.formal.body].slice(0,80).filter((c) => !["\n","\r","\u2028","\u2029"].includes(c)).join("") };
}
export function museumReunionPage(rows: readonly RecordRow[], cursor: string | null, limit: number, today: string): MuseumReunionPage {
  date(today);
  const page = pageRows(reunionRows(rows,Number(today.slice(5,7)),Number(today.slice(8)),today),"desc",cursor,limit,today,museumItem);
  const groups: MuseumReunionGroup[] = [];
  for (const item of page.items) {
    const year=Number(item.eventDate.slice(0,4)), yearsAgo=Number(today.slice(0,4))-year;
    let group=groups.at(-1);
    if (group?.year!==year) { group={year,yearsAgo,label:`${yearsAgo} 年前的今天`,items:[]}; groups.push(group); }
    group.items.push(item);
  }
  return {groups,nextCursor:page.nextCursor,total:page.total};
}
export function museumFavoritesPage(rows: readonly RecordRow[], order: SortOrder, cursor: string | null, limit: number, today: string): TimelinePage {
  date(today); return pageRows(sortedFormal(rows,{favoriteOnly:true,order}),order,cursor,limit,today,museumItem);
}
export function museumPhotosPage(rows: readonly RecordRow[], order: SortOrder, cursor: string | null, limit: number, today: string): MuseumPhotoPage {
  date(today);
  if (!Number.isInteger(limit) || limit<1 || limit>500) throw {code:"INVALID_LIMIT",message:"每页条数请设置为 1–500"};
  const bad=()=>({code:"INVALID_CURSOR",message:"分页位置无效，请刷新展墙后重试"});
  let after: {key:ReturnType<typeof decodeCursor>;index:number}|undefined;
  if (cursor!==null) {
    try {
      if(cursor.length>32768) throw bad();
      const v: unknown=JSON.parse(cursor);
      if(!Array.isArray(v) || v.length!==4 || v[0]!=="sg11-photo" || v[1]!==order
        || typeof v[2]!=="string" || !Number.isSafeInteger(v[3]) || v[3]<0) throw bad();
      after={key:decodeCursor(v[2]),index:v[3]};
    } catch { throw bad(); }
  }
  const all=sortedFormal(rows,{hasPhoto:true,order}), items:MuseumPhotoTile[]=[];
  let total=0, last:{row:FormalRow;index:number}|undefined, more=false;
  for (const r of all) {
    total+=r.formal.photos.length;
    for (let index=0;index<r.formal.photos.length;index++) {
      if(after && (compareKeys(keyOf(r),after.key,order) || index-after.index)<=0) continue;
      if(items.length>=limit) {more=true;break;}
      const f=r.formal,p=f.photos[index]!;
      items.push({recordId:r.recordId,title:f.title.length>0?f.title:null,eventDate:f.eventDate,eventTime:f.eventTime,
        isFuture:f.eventDate>today,photoIndex:index,photoUseId:p.photoUseId,assetId:p.assetId,caption:p.caption,thumbnailKey:`${p.assetId}.thumb-v2.png`});
      last={row:r,index};
    }
  }
  return {items,total,nextCursor:more && last?JSON.stringify(["sg11-photo",order,encodeCursor(keyOf(last.row)),last.index]):null};
}
function emptyYear(year:number):MuseumYear {return {year,recordCount:0,photoCount:0,months:Array<number>(12).fill(0)};}
function addYear(y:MuseumYear,row:FormalRow):void {
  y.recordCount++; y.photoCount+=row.formal.photos.length; y.months[Number(row.formal.eventDate.slice(5,7))-1]!++;
}
export function museumYears(rows:readonly RecordRow[]):MuseumYear[] {
  const years=new Map<number,MuseumYear>();
  for(const row of rows) {
    if(!isFormalActive(row))continue;
    const year=Number(row.formal.eventDate.slice(0,4)),y=years.get(year)??emptyYear(year);
    addYear(y,row);years.set(year,y);
  }
  return [...years.values()].sort((a,b)=>b.year-a.year);
}
export function museumYearRoom(rows:readonly RecordRow[],year:number,order:SortOrder,cursor:string|null,limit:number,today:string):MuseumYearRoom {
  date(today);
  if(!Number.isInteger(year)||year<0||year>9999)throw {code:"INVALID_EVENT_DATE",message:"年份无效"};
  const y=String(year).padStart(4,"0"),all=sortedFormal(rows,{from:`${y}-01-01`,to:`${y}-12-31`,order}),summary=emptyYear(year);
  all.forEach((row)=>addYear(summary,row));
  const rank=(row:FormalRow)=>row.favorite?0:row.formal.photos.length>0?1:2;
  const featured=all.filter((row)=>eligible(row,today)).sort((a,b)=>rank(a)-rank(b)||compareRows(a,b,"desc"))
    .slice(0,MUSEUM_FEATURED_LIMIT).map((row)=>museumItem(row,today));
  return {summary:summary.recordCount>0?summary:null,page:pageRows(all,order,cursor,limit,today,museumItem),featured};
}
/** Canonical IDs + xorshift32 Fisher–Yates. Unseen first, minimum repeats. */
export function museumReshuffle(rows:readonly RecordRow[],seed:number,previousIds:readonly string[],limit:number,today:string):MuseumShuffle {
  date(today);
  if(!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw {code:"INVALID_SEED",message:"随机种子须为 uint32"};
  if(!Number.isInteger(limit)||limit<1||limit>50)throw {code:"INVALID_LIMIT",message:"每次请查看 1–50 条"};
  const all=rows.filter(isFormalActive).filter((r)=>eligible(r,today)).sort((a,b)=>a.recordId<b.recordId?-1:a.recordId>b.recordId?1:0);
  let rng=seed||0x6d2b79f5;
  for(let i=all.length-1;i>0;i--){rng^=rng<<13;rng^=rng>>>17;rng^=rng<<5;rng>>>=0;const j=rng%(i+1);[all[i],all[j]]=[all[j]!,all[i]!];}
  const previous=new Set(previousIds),unseen=all.filter((r)=>!previous.has(r.recordId)),repeated=all.filter((r)=>previous.has(r.recordId));
  return {eligibleTotal:all.length,items:unseen.concat(repeated).slice(0,limit).map((row)=>museumItem(row,today))};
}
export function museumHomeSummary(rows:readonly RecordRow[],today:string):MuseumSummary {
  date(today);
  const out:MuseumSummary={recordCount:0,reunionCount:0,favoriteCount:0,photoCount:0,yearCount:0,eligibleCount:0,hiddenCount:0},years=new Set<string>();
  for(const r of rows){
    if(r.museumHidden)out.hiddenCount++;
    if(!isFormalActive(r))continue;
    const f=r.formal;out.recordCount++;out.favoriteCount+=Number(r.favorite);out.photoCount+=f.photos.length;years.add(f.eventDate.slice(0,4));
    if(eligible(r,today))out.eligibleCount++;
    if(!r.museumHidden&&f.eventDate.slice(0,4)<today.slice(0,4)&&f.eventDate.slice(5)===today.slice(5))out.reunionCount++;
  }
  out.yearCount=years.size;return out;
}
