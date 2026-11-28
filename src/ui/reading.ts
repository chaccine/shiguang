import type { PhotoUse, RecordRow, Snapshot } from "../domain/types.ts";
import { formatEventWhen } from "../domain/format.ts";
import { storyOf, runText, storyPhotos, type Story, type TextRun } from "../domain/story.ts";

type LoadPhoto = (img: HTMLImageElement, photo: PhotoUse, figure: HTMLElement) => void;
type ReadingMeta = Pick<Snapshot, "title" | "eventDate" | "eventTime" | "location" | "mood">;
export function renderRuns(holder: HTMLElement, runs: TextRun[]) {
  if (runs.every(run => !run.bold && !run.italic)) { holder.textContent = runText(runs); return; }
  holder.replaceChildren(...runs.map(run => {
    let text: Node = document.createTextNode(run.text);
    for (const tag of [run.italic && "em", run.bold && "strong"] as const) {
      if (tag) { const mark = document.createElement(tag); mark.append(text); text = mark; }
    }
    return text;
  }));
}

export function renderStoryReading(holder: HTMLElement, meta: ReadingMeta, story: Story, labels: string[], load: LoadPhoto) {
  const title = document.createElement("h1"); title.textContent = meta.title || "一段时光";
  const when = document.createElement("p");
  when.textContent = [formatEventWhen(meta), meta.location, meta.mood, ...labels].filter(Boolean).join(" · ");
  holder.replaceChildren(title, when);
  const addPhoto = (photo: PhotoUse, cover: boolean) => {
    const figure = document.createElement("figure"); figure.dataset.testid = cover ? "reading-cover" : "reading-photo"; figure.dataset.photoId = photo.photoUseId;
    const img = document.createElement("img"); img.alt = photo.caption || "时光照片"; img.className = "reading-photo"; img.loading = "lazy";
    figure.append(img); load(img, photo, figure);
    const caption = document.createElement("figcaption"); caption.className = "reading-caption"; caption.textContent = photo.caption; if (photo.caption.length) figure.append(caption); holder.append(figure);
  };
  const cover = storyPhotos(story).find(photo => photo.photoUseId === story.coverPhotoUseId);
  if (cover) addPhoto(cover, true);
  for (const block of story.blocks) {
    if (block.kind === "photo") addPhoto(block.photoUse, false);
    else if (block.kind === "divider") holder.append(document.createElement("hr"));
    else {
      const body = document.createElement(block.kind === "quote" ? "blockquote" : block.kind === "smallHeading" ? "h2" : "p");
      body.className = "reading-body"; renderRuns(body, block.runs); holder.append(body);
    }
  }
}

/** A formal reading can only obtain its blocks from row.formal. */
export function renderReading(holder: HTMLElement, row: RecordRow, tagName: (id: string) => string, load: LoadPhoto): void {
  if (!row.formal) { holder.replaceChildren(); return; }
  renderStoryReading(holder, row.formal, storyOf(row.formal), [
    ...(row.favorite ? ["★ 已收藏"] : []), ...row.tagIds.map(tagName),
  ], load);
}
