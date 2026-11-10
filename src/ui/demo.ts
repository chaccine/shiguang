import { localToday } from "../domain/timeline.ts";
import type { MemoryAdapter } from "../platform/memory-adapter.ts";

/** 预览模式的合成数据存储键；仅在 demo=1 时主动清空。 */
export const PREVIEW_STORAGE_KEY = "shiguang.preview.unit02";

const encoder = new TextEncoder();
const svgBytes = (svg: string): Uint8Array => encoder.encode(svg);

const MINT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
  <rect width="320" height="240" fill="#f4ebdc"/>
  <circle cx="258" cy="46" r="26" fill="#f3d39b" opacity="0.75"/>
  <rect x="0" y="158" width="320" height="82" fill="#e5d3ba"/>
  <ellipse cx="158" cy="210" rx="78" ry="11" fill="#cdb795" opacity="0.55"/>
  <path d="M108 158h100l-13 56h-74z" fill="#b97850"/>
  <rect x="100" y="148" width="116" height="16" rx="8" fill="#c98a60"/>
  <g fill="#7f9a63">
    <path d="M160 146c-2-30 18-49 41-53-4 27-17 45-41 53z"/>
    <path d="M158 144c-23-14-33-39-27-62 23 12 33 35 27 62z"/>
    <path d="M166 142c11-24 35-35 57-31-14 23-35 33-57 31z"/>
    <path d="M152 148c-27 4-47-8-55-29 25-4 45 8 55 29z"/>
  </g>
  <g fill="#a9bd8b">
    <path d="M160 146c4-23 17-37 35-43-2 21-15 37-35 43z"/>
  </g>
  <path d="M126 200c22 8 46 8 68 0" stroke="#8f5a38" stroke-width="4" fill="none" stroke-linecap="round"/>
</svg>`;

const RAIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
  <rect width="320" height="240" fill="#e2e7e5"/>
  <rect x="0" y="118" width="320" height="122" fill="#b9c3c1"/>
  <path d="M0 168h320v72H0z" fill="#a3adab"/>
  <path d="M38 208h76l22 32H54z" fill="#7f8d8b"/>
  <path d="M196 196h64l18 44h-82z" fill="#8c9997"/>
  <path d="M148 176h58v26h-58z" fill="#c9d1cf"/>
  <path d="M162 176v-42l26-14 26 14v42z" fill="#d9dfdd"/>
  <path d="M188 120v56" stroke="#7f8d8b" stroke-width="3"/>
  <circle cx="188" cy="112" r="9" fill="#f1c37d"/>
  <ellipse cx="122" cy="206" rx="34" ry="7" fill="#d7e0df" opacity="0.75"/>
  <ellipse cx="236" cy="224" rx="30" ry="6" fill="#d7e0df" opacity="0.6"/>
  <g stroke="#8fa4ad" stroke-width="2" stroke-linecap="round" opacity="0.7">
    <path d="M40 52l-6 12"/>
    <path d="M82 34l-6 12"/>
    <path d="M128 58l-6 12"/>
    <path d="M236 40l-6 12"/>
    <path d="M280 66l-6 12"/>
  </g>
</svg>`;

const ORANGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
  <rect width="320" height="240" fill="#f3e7d5"/>
  <rect x="0" y="150" width="320" height="90" fill="#d9b98f" opacity="0.75"/>
  <ellipse cx="164" cy="196" rx="92" ry="18" fill="#c99e6f" opacity="0.5"/>
  <rect x="86" y="144" width="160" height="20" rx="10" fill="#e8cba4"/>
  <circle cx="168" cy="126" r="42" fill="#e79a45"/>
  <path d="M168 84c2-12 10-20 22-22-2 13-10 21-22 22z" fill="#7f9a63"/>
  <path d="M166 84c-10-8-22-9-33-4 8 9 20 11 33 4z" fill="#6f8a57"/>
  <path d="M140 120c10 14 28 20 46 15" stroke="#f6c47e" stroke-width="5" fill="none" stroke-linecap="round" opacity="0.8"/>
  <path d="M132 158c22 8 54 8 76 0" stroke="#b98a5c" stroke-width="3" fill="none" stroke-linecap="round"/>
</svg>`;

const pad = (value: number): string => String(value).padStart(2, "0");

/** 以本地日期为基准做 UTC 日历运算，避免时区把日期挪一天。 */
function addDays(date: string, delta: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const next = new Date(Date.UTC(year, month - 1, day + delta));
  return `${String(next.getUTCFullYear()).padStart(4, "0")}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** 往年同月同日；2 月 29 日遇到平年时退到 2 月 28 日，保证演示总有内容。 */
function sameDayInYear(today: string, year: number): string {
  const month = Number(today.slice(5, 7));
  const day = Number(today.slice(8, 10));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(Math.min(day, last))}`;
}

/**
 * 只写入虚构的日常小事；照片是代码里手写的 SVG 字节，
 * 经 MemoryAdapter 正常走 SHA-256 与 Base64，不读取任何真实文件。
 */
export async function seedDemo(adapter: MemoryAdapter): Promise<void> {
  const mint = await adapter.createDraft({
    title: "阳台上的薄荷",
    body: "傍晚给薄荷浇了点水，叶子上还挂着水珠。风从纱窗吹进来，整间屋子都是清凉的味道。",
    eventDate: "2026-11-07",
    eventTime: "17:40",
  });
  await adapter.attachPhotoBytes({
    recordId: mint.row.recordId,
    fileName: "mint.svg",
    bytes: svgBytes(MINT_SVG),
    caption: "窗台的薄荷",
    mediaType: "image/svg+xml",
  });
  await adapter.commitRecord(mint.row.recordId, mint.row.baseRevision);

  const rain = await adapter.createDraft({
    title: "雨停后的路口",
    body: "下班路上雨刚停，路面积着浅浅的水，路灯一盏一盏亮起来。顺手买了一袋热乎的糖炒栗子。",
    eventDate: "2026-11-05",
    eventTime: null,
  });
  await adapter.attachPhotoBytes({
    recordId: rain.row.recordId,
    fileName: "rain.svg",
    bytes: svgBytes(RAIN_SVG),
    caption: "雨后的街角",
    mediaType: "image/svg+xml",
  });
  await adapter.commitRecord(rain.row.recordId, rain.row.baseRevision);

  const draft = await adapter.createDraft({
    title: "窗边的橘子",
    body: "午后的光落在桌角，橘子剥了一半，空气里有淡淡的甜味。还没想好怎么结尾，先放在这里。",
    eventDate: "2026-11-09",
    eventTime: "15:10",
  });
  await adapter.attachPhotoBytes({
    recordId: draft.row.recordId,
    fileName: "orange.svg",
    bytes: svgBytes(ORANGE_SVG),
    caption: "剥了一半的橘子",
    mediaType: "image/svg+xml",
  });

  // ---- Unit-0.7 合成记录：跨年份、同一天多条、未来、照片、珍藏、标签 ----
  const today = localToday();
  const thisYear = Number(today.slice(0, 4));
  const travel = await adapter.createTag("旅行");
  const family = await adapter.createTag("家人");
  const campus = await adapter.createTag("校园");

  const createRecord = async (
    input: { title: string; body: string; eventDate: string; eventTime: string | null },
    photo?: { svg: string; fileName: string; caption: string },
  ): Promise<string> => {
    const created = await adapter.createDraft(input);
    if (photo) {
      await adapter.attachPhotoBytes({
        recordId: created.row.recordId,
        fileName: photo.fileName,
        bytes: svgBytes(photo.svg),
        caption: photo.caption,
        mediaType: "image/svg+xml",
      });
    }
    await adapter.commitRecord(created.row.recordId, created.row.baseRevision);
    return created.row.recordId;
  };
  const tagRecord = async (recordId: string, tagIds: string[]): Promise<void> => {
    await adapter.setRecordTags(recordId, tagIds, 0);
  };

  const lastYearWalk = await createRecord({
    title: "合成：那年今日的散步",
    body: "虚构的旧记录。沿着河边慢慢走，梧桐叶落在肩上，回家时天已经黑了。",
    eventDate: sameDayInYear(today, thisYear - 1),
    eventTime: "18:20",
  }, { svg: RAIN_SVG, fileName: "synthetic-past-walk.svg", caption: "往年河边的雨" });
  await tagRecord(lastYearWalk, [family.tagId]);

  const oldYard = await createRecord({
    title: "合成：旧照里的院子",
    body: "虚构的旧记录。院子里的石榴树又高了一截，木桌上还放着没喝完的茶。",
    eventDate: sameDayInYear(today, thisYear - 2),
    eventTime: null,
  }, { svg: MINT_SVG, fileName: "synthetic-old-yard.svg", caption: "往年院子的绿意" });
  await tagRecord(oldYard, [campus.tagId]);

  const futurePlan = await createRecord({
    title: "合成：下个月的约定",
    body: "虚构的未来记录。约好下个月再去看一次海，先把车票和天气都记在这里。",
    eventDate: addDays(today, 12),
    eventTime: "09:00",
  });
  await tagRecord(futurePlan, [travel.tagId]);
  await adapter.setFavorite(futurePlan, true, 0);

  const park = await createRecord({
    title: "合成：周末去公园",
    body: "虚构的一天。公园的长椅上晒着太阳，湖面有风，孩子在远处追着泡泡跑。",
    eventDate: today,
    eventTime: "10:20",
  }, { svg: ORANGE_SVG, fileName: "synthetic-park.svg", caption: "公园里的橙色午后" });
  await tagRecord(park, [travel.tagId, family.tagId]);
  await adapter.setFavorite(park, true, 0);

  const bench = await createRecord({
    title: "合成：午后的长椅",
    body: "虚构的一天。坐在树荫下读了几页书，蝉声很密，风把书页吹得哗哗响。",
    eventDate: today,
    eventTime: "16:45",
  });
  await tagRecord(bench, [campus.tagId]);

  const walkHome = await createRecord({
    title: "合成：傍晚回家",
    body: "虚构的一天。没有记具体时刻，只记得晚霞把楼顶染成了橘红色。",
    eventDate: today,
    eventTime: null,
  });
  await tagRecord(walkHome, [family.tagId]);
}
