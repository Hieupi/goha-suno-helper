// Vẽ tiến độ cả hàng chờ (thẻ tiến độ tập + lưới từng bài) từ queueOverview() — lib/queue-view.js.
// Chỉ dựng DOM bằng h()/icon(); chữ tiếng Việt, mỗi trạng thái có icon + chữ, không chỉ dựa vào màu.
import { h, icon } from "./dom.js";
import { etaText } from "../lib/queue-view.js";

// Thứ tự đoạn trên thanh tiến độ và chip đếm: việc đã xong trước, việc còn chờ sau cùng.
const SEGMENTS = Object.freeze([
  { key: "done", tone: "matsu", icon: "i-check", label: "Xong" },
  { key: "active", tone: "ai", icon: "i-down", label: "Đang chạy" },
  { key: "human", tone: "shu", icon: "i-hand", label: "Cần bạn" },
  { key: "failed", tone: "kohaku", icon: "i-x", label: "Lỗi" },
  { key: "queued", tone: "mute", icon: "i-list", label: "Đang chờ" }
]);

const CELL_ICON = Object.freeze({ done: "i-check", active: "i-down", human: "i-hand", failed: "i-x", cancelled: "i-neq", queued: null });

function clock(ms) {
  return new Date(ms).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

function stateLine(ep, paused, now, waiting) {
  const open = ep.counts.active + ep.counts.queued + ep.counts.human;
  if (!open) return ep.counts.failed ? `Đã chạy hết · ${ep.counts.failed} việc lỗi cần xem` : "Xong hết";
  if (waiting) return "Đang chờ cửa sổ Suno hiện lại — hiện là tự chạy tiếp";
  if (paused || ep.counts.human) return "Đang tạm dừng — chờ bạn xử lý";
  if (ep.etaMs === null) return "Đang ước tính thời gian còn lại…";
  return `Còn ${etaText(ep.etaMs)} · xong lúc ~${clock(now + ep.etaMs)}`;
}

function stackedBar(ep) {
  const total = Math.max(1, ep.total);
  return h("div", { class: "sbar", role: "img", "aria-label": `${ep.counts.done} trên ${ep.total} việc đã xong` },
    SEGMENTS.filter((s) => ep.counts[s.key]).map((s) =>
      h("i", { class: `${s.tone}${s.key === "active" ? " live" : ""}`, style: `flex-grow:${ep.counts[s.key] / total}` })));
}

function counters(ep) {
  return h("div", { class: "qchips" }, SEGMENTS.filter((s) => ep.counts[s.key]).map((s) =>
    h("span", { class: `chip ${s.tone}` }, icon(s.icon), `${s.label} ${ep.counts[s.key]}`)));
}

/** Thẻ tiến độ của một tập. `onMore` thêm nút mở lưới từng bài; `onResume` thêm nút "Chạy tiếp" khi đang tạm dừng. */
export function progressCard(ep, { paused, now, waiting = false, onMore = null, onResume = null }) {
  const unit = ["Tải WAV", "Xuất 32-bit"].includes(ep.kindLabel) ? "take" : "việc";
  const open = ep.counts.active + ep.counts.queued + ep.counts.human;
  const tone = ep.counts.human || paused ? "shu" : waiting ? "kohaku" : open ? "ai" : "matsu";
  return h("section", { class: `card hl ${tone} qp` },
    h("div", { class: "chead" }, icon(ep.kindLabel === "Tạo nhạc" ? "i-music" : "i-down", "i20"),
      h("div", {}, h("h3", {}, `${ep.short} · ${ep.kindLabel}`), h("div", { class: "meta" }, stateLine(ep, paused, now, waiting))),
      h("div", { class: "qbig" }, h("b", {}, String(ep.counts.done)), h("span", {}, `/${ep.total} ${unit}`))),
    stackedBar(ep),
    counters(ep),
    ep.human.length ? h("ul", { class: "qhuman" }, ep.human.map((x) =>
      h("li", {}, icon("i-hand"), h("b", {}, `Ô ${String(x.slot).padStart(2, "0")}`), h("span", {}, `${x.title} — ${x.reason}`)))) : null,
    buttonRow([
      paused && onResume ? h("button", { class: "btn primary", type: "button", onclick: onResume }, icon("i-redo"), "Chạy tiếp") : null,
      onMore ? h("button", { class: "btn ghost", type: "button", onclick: onMore }, icon("i-list"), "Xem từng bài") : null
    ]));
}

/** Hàng nút; không có nút nào thì không vẽ (tránh khoảng trống dưới thẻ). */
function buttonRow(buttons) {
  const present = buttons.filter(Boolean);
  return present.length ? h("div", { class: "btns" }, present) : null;
}

/** Lưới từng bài: một dòng mỗi ô, mỗi take một ô vuông có icon + chữ mô tả (title/aria-label). */
export function slotList(ep) {
  return h("section", { class: "card qslots" },
    h("h3", {}, `Từng bài — ${ep.short}`),
    h("ol", { class: "slots" }, ep.slots.map((slot) =>
      h("li", {},
        h("span", { class: "sn" }, String(slot.slot).padStart(2, "0")),
        h("span", { class: "st", title: slot.title }, slot.title),
        h("span", { class: "cells" }, slot.cells.map((cell, index) => {
          const text = `Take ${index + 1}: ${cell.label}`;
          const glyph = CELL_ICON[cell.state];
          return h("span", { class: `cell ${cell.state}`, title: text, "aria-label": text, role: "img" }, glyph ? icon(glyph) : null);
        }))))),
    h("div", { class: "legend" },
      [["done", "Xong"], ["active", "Đang chạy"], ["queued", "Đang chờ"], ["human", "Cần bạn"], ["failed", "Lỗi"]].map(([state, label]) =>
        h("span", {}, h("span", { class: `cell ${state}` }, CELL_ICON[state] ? icon(CELL_ICON[state]) : null), label))));
}

/** "EP008 16/28" cho thanh chạy dưới đáy. */
export function runbarProgress(ep) {
  return ep ? ` · ${ep.short} ${ep.counts.done}/${ep.total}` : "";
}
