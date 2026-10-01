import test from "node:test";
import assert from "node:assert/strict";
import { etaText, queueOverview } from "../lib/queue-view.js";

// Tiến độ cả hàng chờ cho side panel: đếm theo trạng thái, lưới ô × take, ước tính thời gian còn lại.

const EP = "EP008-winter-edo-reading-room";
const MIN = 60_000;
const T0 = Date.parse("2026-09-28T01:00:00Z");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function job(slot, take, status, extra = {}) {
  const id = `EP008.${String(slot).padStart(2, "0")}.${String(take).repeat(8)}-1111-4111-8111-111111111111`;
  return { id, kind: "export_download", slot, status, step: null, reason: null, title: `曲${slot}`, at: iso(T0), ...extra };
}

const picture = (jobs, paused = false) => ({ paused, episodes: [{ episode: EP, jobs }] });

test("đếm theo trạng thái, phần trăm tính trên việc không bị huỷ", () => {
  const view = queueOverview(picture([
    job(5, 1, "done"), job(5, 2, "running"), job(6, 1, "queued"), job(6, 2, "needs_human", { reason: "tab_hidden" }), job(7, 1, "cancelled")
  ]), T0);
  const [ep] = view.episodes;
  assert.equal(ep.short, "EP008");
  assert.equal(ep.kindLabel, "Tải WAV");
  assert.deepEqual(ep.counts, { done: 1, active: 1, queued: 1, human: 1, failed: 0, cancelled: 1 });
  assert.equal(ep.total, 4);
  assert.equal(ep.percent, 25);
  assert.equal(view.focus, ep, "tập còn việc được đưa lên trước");
});

test("lưới ô × take theo thứ tự ô, mỗi ô giữ tên bài và trạng thái từng take", () => {
  const view = queueOverview(picture([job(6, 1, "queued"), job(5, 1, "done"), job(5, 2, "running", { step: "exporting" })]), T0);
  const slots = view.episodes[0].slots;
  assert.deepEqual(slots.map((s) => s.slot), [5, 6]);
  assert.equal(slots[0].title, "曲5");
  assert.deepEqual(slots[0].cells.map((c) => c.state), ["done", "active"]);
  assert.equal(slots[0].cells[1].label, "Xuất bản đầy đủ");
});

test("ước tính còn lại = nhịp xong việc gần đây × số việc chưa xong, trừ phần đã chạy", () => {
  const done = [0, 2, 4, 6].map((m, i) => job(10 + i, 1, "done", { at: iso(T0 + m * MIN) }));
  const rest = [job(20, 1, "running"), job(21, 1, "queued"), job(22, 1, "queued")];
  const view = queueOverview(picture([...done, ...rest]), T0 + 7 * MIN);
  // nhịp 2 phút/việc × 3 việc còn lại − 1 phút việc đang chạy đã đi
  assert.equal(view.episodes[0].etaMs, 5 * MIN);
});

test("khoảng nghỉ dài (máy ngủ, chờ người) không kéo lệch nhịp", () => {
  const done = [0, 2, 60, 62].map((m, i) => job(10 + i, 1, "done", { at: iso(T0 + m * MIN) }));
  const view = queueOverview(picture([...done, job(20, 1, "queued")]), T0 + 62 * MIN);
  assert.equal(view.episodes[0].etaMs, 2 * MIN);
});

test("chưa đủ dữ liệu hoặc đang tạm dừng thì không đoán giờ", () => {
  const few = queueOverview(picture([job(5, 1, "done"), job(6, 1, "queued")]), T0);
  assert.equal(few.episodes[0].etaMs, null);
  const done = [0, 2, 4].map((m, i) => job(10 + i, 1, "done", { at: iso(T0 + m * MIN) }));
  const paused = queueOverview(picture([...done, job(20, 1, "queued")], true), T0 + 5 * MIN);
  assert.equal(paused.episodes[0].etaMs, null);
  assert.equal(paused.paused, true);
});

test("tập đã xong hết: không còn gì để ước tính, tập khác còn việc được chọn làm tiêu điểm", () => {
  const finished = { episode: "EP007-x", jobs: [job(1, 1, "done")] };
  const busy = { episode: EP, jobs: [job(5, 1, "queued")] };
  const view = queueOverview({ paused: false, episodes: [finished, busy] }, T0);
  assert.equal(view.episodes[0].etaMs, null);
  assert.equal(view.focus.short, "EP008");
});

test("việc cần người được liệt kê kèm lý do tiếng Việt", () => {
  const view = queueOverview(picture([job(9, 1, "needs_human", { reason: "tab_hidden" })], true), T0);
  assert.deepEqual(view.episodes[0].human, [{ slot: 9, title: "曲9", reason: "Tab Suno bị ẩn hoặc thu nhỏ" }]);
});

test("không có ảnh hàng chờ → rỗng, không lỗi", () => {
  assert.deepEqual(queueOverview(null, T0), { paused: false, episodes: [], focus: null });
});

test("chữ thời gian còn lại dễ đọc", () => {
  assert.equal(etaText(30_000), "dưới 1 phút");
  assert.equal(etaText(25 * MIN), "khoảng 25 phút");
  assert.equal(etaText(70 * MIN), "khoảng 1 giờ 10 phút");
  assert.equal(etaText(null), "");
});

test("không tập nào còn việc: tiêu điểm là tập hoạt động gần nhất, không phụ thuộc thứ tự gửi", () => {
  const older = { episode: "EP012-x", jobs: [job(1, 1, "done", { at: iso(T0) })] };
  const newer = { episode: EP, jobs: [job(5, 1, "done", { at: iso(T0 + 60 * MIN) })] };
  assert.equal(queueOverview({ paused: false, episodes: [newer, older] }, T0).focus.short, "EP008");
  assert.equal(queueOverview({ paused: false, episodes: [older, newer] }, T0).focus.short, "EP008");
});
