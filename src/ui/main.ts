import { formatEventWhen, formalHeadline } from "../domain/format.ts";
import { validateForCommit } from "../domain/rules.ts";
import { formalItems } from "../domain/view.ts";
import type { RecordRow, Snapshot } from "../domain/types.ts";
import { createTauriApi, tauriInvokeFromWindow } from "../platform/tauri-adapter.ts";

const banner = document.querySelector<HTMLDivElement>("#banner")!;
const timeline = document.querySelector<HTMLDivElement>("#timeline")!;
const titleInput = document.querySelector<HTMLInputElement>("#title")!;
const bodyInput = document.querySelector<HTMLTextAreaElement>("#body")!;
const dateInput = document.querySelector<HTMLInputElement>("#event-date")!;
const timeInput = document.querySelector<HTMLInputElement>("#event-time")!;
const commitButton = document.querySelector<HTMLButtonElement>("#commit")!;
const errorBox = document.querySelector<HTMLDivElement>("#error")!;

const invoke = tauriInvokeFromWindow();
const api = invoke === null ? null : createTauriApi(invoke);

if (api === null) {
  banner.hidden = false;
  banner.textContent =
    "未检测到 Tauri 运行时：当前页面不会保存任何内容，也不会显示“已保存”。请按 README 构建桌面壳。";
  commitButton.textContent = "需要桌面壳";
  commitButton.disabled = true;
}

function currentDraft(): Snapshot {
  return {
    title: titleInput.value,
    body: bodyInput.value,
    eventDate: dateInput.value,
    eventTime: timeInput.value.trim().length > 0 ? timeInput.value : null,
    photos: [],
  };
}

function render(rows: readonly RecordRow[]): void {
  const items = formalItems(rows);
  if (items.length === 0) {
    timeline.className = "empty";
    timeline.textContent = "还没有正式记录。";
    return;
  }
  timeline.className = "";
  timeline.replaceChildren(
    ...items.map((item) => {
      const article = document.createElement("article");
      const heading = document.createElement("strong");
      heading.textContent = formalHeadline(item);
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = formatEventWhen(item);
      if (item.hasPendingDraft) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "有未提交草稿";
        meta.append(" ", badge);
      }
      article.append(heading, meta);
      return article;
    }),
  );
}

async function refresh(): Promise<void> {
  if (api === null) return;
  try {
    render(await api.listFormalRecords());
  } catch (error) {
    errorBox.textContent = `读取正式列表失败：${String(error)}`;
  }
}

commitButton.addEventListener("click", async () => {
  if (api === null) return;
  errorBox.textContent = "";
  const draft = currentDraft();
  const issue = validateForCommit(draft);
  if (issue !== null) {
    errorBox.textContent = issue.message;
    return;
  }
  commitButton.disabled = true;
  try {
    const created = await api.createDraft({
      title: draft.title,
      body: draft.body,
      eventDate: draft.eventDate,
      eventTime: draft.eventTime,
    });
    await api.commitRecord(created.recordId);
    titleInput.value = "";
    bodyInput.value = "";
    timeInput.value = "";
    await refresh();
  } catch (error) {
    errorBox.textContent = `存入失败：${String(error)}`;
  } finally {
    commitButton.disabled = false;
  }
});

dateInput.value = new Date().toISOString().slice(0, 10);
void refresh();
