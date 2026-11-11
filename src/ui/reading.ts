import type { PhotoUse, RecordRow } from "../domain/types.ts";
import { formatEventWhen } from "../domain/format.ts";
/** Formal only: a pending edit draft must never leak into this view. */
export function renderReading(holder: HTMLElement, row: RecordRow, tagName: (id: string) => string,
  load: (img: HTMLImageElement, photo: PhotoUse, figure: HTMLElement) => void): void {
  holder.replaceChildren();
  const f = row.formal; if (!f) return;
  const title = document.createElement("h1"); title.textContent = f.title || "一段时光";
  const meta = document.createElement("p"); meta.textContent = [formatEventWhen(f), f.location, f.mood,
    row.favorite ? "★ 已收藏" : "", ...row.tagIds.map(tagName)].filter(Boolean).join(" · ");
  holder.append(title, meta);
  const addPhoto = (photo: PhotoUse, cover: boolean) => {
    const figure = document.createElement("figure"); figure.dataset.testid = cover ? "reading-cover" : "reading-photo"; figure.dataset.photoId = photo.photoUseId;
    const img = document.createElement("img"); img.alt = photo.caption || "时光照片"; img.className = "reading-photo"; img.loading = "lazy";
    figure.append(img); load(img, photo, figure);
    const caption = document.createElement("figcaption"); caption.className = "reading-caption"; caption.textContent = photo.caption; if (photo.caption.length) figure.append(caption); holder.append(figure);
  };
  const cover = f.photos.find(p => p.photoUseId === f.coverPhotoUseId); if (cover) addPhoto(cover, true);
  const body = document.createElement("p"); body.className = "reading-body"; body.textContent = f.body; holder.append(body);
  for (const photo of f.photos) addPhoto(photo, false);
}
