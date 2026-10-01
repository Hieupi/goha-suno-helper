// Tiến độ cả hàng chờ cho side panel, dựng từ ảnh hàng chờ cầu nối gửi (tin `queue`, xem protocol.js).
// Logic thuần, không chạm chrome.* — test ở tests/queue-view.test.mjs.
import { episodeShort, humanReason, kindLabel, phaseLabel } from "./ui-status.js";

const MINUTE = 60_000;
// Khoảng giữa hai việc xong dài hơn thế này là máy ngủ / chờ người, không phải nhịp chạy.
const PACE_GAP_MAX_MS = 10 * MINUTE;

const CELL_STATE = Object.freeze({
  done: "done",
  sent: "active",
  running: "active",
  queued: "queued",
  needs_human: "human",
  failed: "failed",
  unknown: "failed",
  cancelled: "cancelled"
});

function cellLabel(job, state) {
  if (state === "active") return phaseLabel(job.step);
  if (state === "human") return humanReason(job.reason);
  if (state === "failed") return job.status === "unknown" ? "Không rõ kết quả — cần kiểm trên Suno" : "Lỗi";
  return { done: "Xong", queued: "Đang chờ", cancelled: "Đã huỷ" }[state];
}

function countStates(jobs) {
  const counts = { done: 0, active: 0, queued: 0, human: 0, failed: 0, cancelled: 0 };
  for (const job of jobs) counts[CELL_STATE[job.status]] += 1;
  return counts;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Nhịp = trung vị khoảng cách giữa các lần xong việc gần nhau; trừ phần việc hiện tại đã chạy. */
function estimateRemaining(jobs, counts, paused, now) {
  const remaining = counts.active + counts.queued;
  if (paused || remaining === 0) return null;
  const finished = jobs
    .filter((job) => job.status === "done" && job.at)
    .map((job) => Date.parse(job.at))
    .sort((a, b) => a - b);
  const gaps = finished.slice(1).map((at, i) => at - finished[i]).filter((gap) => gap > 0 && gap <= PACE_GAP_MAX_MS);
  if (!gaps.length) return null;
  const pace = median(gaps);
  const elapsed = Math.min(Math.max(0, now - finished.at(-1)), pace);
  return Math.max(0, Math.round(pace * remaining - elapsed));
}

function slotGrid(jobs) {
  const bySlot = new Map();
  for (const job of jobs) {
    if (!bySlot.has(job.slot)) bySlot.set(job.slot, { slot: job.slot, title: job.title, cells: [] });
    const state = CELL_STATE[job.status];
    bySlot.get(job.slot).cells.push({ id: job.id, state, label: cellLabel(job, state) });
  }
  return [...bySlot.values()].sort((a, b) => a.slot - b.slot);
}

function summarizeEpisode({ episode, jobs }, paused, now) {
  const counts = countStates(jobs);
  const total = jobs.length - counts.cancelled;
  const kinds = new Set(jobs.map((job) => job.kind));
  return {
    episode,
    short: episodeShort(episode),
    kindLabel: kinds.size > 1 ? "Nhiều loại việc" : kindLabel([...kinds][0]),
    counts,
    total,
    percent: total ? Math.round((counts.done / total) * 100) : 0,
    etaMs: estimateRemaining(jobs, counts, paused, now),
    slots: slotGrid(jobs),
    human: jobs.filter((job) => job.status === "needs_human").map((job) => ({ slot: job.slot, title: job.title, reason: humanReason(job.reason) }))
  };
}

/** Toàn cảnh: từng tập + tập tiêu điểm (tập còn việc chạy/chờ/cần người, không thì tập cuối). */
export function queueOverview(picture, now = Date.now()) {
  if (!picture || !Array.isArray(picture.episodes)) return { paused: false, episodes: [], focus: null };
  const paused = picture.paused === true;
  const episodes = picture.episodes.map((episode) => summarizeEpisode(episode, paused, now));
  const open = (ep) => ep.counts.active + ep.counts.queued + ep.counts.human > 0;
  // Không tập nào còn việc: tập có việc cập nhật gần nhất (không dựa vào thứ tự cầu nối gửi).
  const latest = (picture.episodes ?? []).map((ep, i) => ({ i, at: Math.max(0, ...ep.jobs.map((job) => Date.parse(job.at) || 0)) }));
  const recent = latest.sort((a, b) => b.at - a.at)[0];
  return { paused, episodes, focus: episodes.find(open) ?? (recent ? episodes[recent.i] : null) };
}

/** "khoảng 25 phút" / "khoảng 1 giờ 10 phút" / "dưới 1 phút". */
export function etaText(ms) {
  if (ms === null || ms === undefined) return "";
  if (ms < MINUTE) return "dưới 1 phút";
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `khoảng ${minutes} phút`;
  const rest = minutes % 60;
  return `khoảng ${Math.floor(minutes / 60)} giờ${rest ? ` ${rest} phút` : ""}`;
}
