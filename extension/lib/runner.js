// Bộ máy trạng thái của MỘT job. Bốn loại:
//   export_download    Studio export → tải chỉ WAV (SKILL suno-take-download §3)
//   generate           điền form Create theo packet → đọc lại → (thật) bấm Create → chờ render xong
//   multitrack_export  Studio một track → Export → Multitrack (bản trộn 32-bit float, 0 credit)
//   stems_split        hộp "Extract Stems" → (chưa tách + thật) Auto split, 50 credit → Open in Studio →
//                      Export → Multitrack (bản trộn + mọi stem, 32-bit float)
// THUẦN: step(state, event) → { state, actions }. Không đụng chrome.* — background thực thi actions:
//   navigate{url, then, payload}  mở URL trong tab Suno riêng, tải xong thì ra lệnh `then` cho content
//   await_load{then, payload}     tab Suno sắp tự tải lại (content vừa bấm nút điều hướng): nạp xong thì ra lệnh `then`
//   content{command, payload}     ra lệnh content script (export_full_song, download_wav, stop, ...)
//   check_clip{id, afterMs?}      đọc trạng thái clip công khai (render xong chưa, dài bao nhiêu)
//   expect_download{episode, exportId, title}  bắt lượt tải của bản export này, đặt vào JR-Suno/<EP>/
//   timeout{phase, ms}            hẹn giờ; hết giờ background gửi lại event timeout{phase}
//   report{message}               gửi cho cầu nối (progress / alert / result)
// Mọi state là object mới — không sửa tại chỗ.
import { isUuid } from "./protocol.js";
import { CREATE_URL, songUrl, studioUrl } from "./naming.js";
import "./suno-logic.js";

const { titleMatches } = globalThis.JrSunoLogic;

export const IDLE = Object.freeze({ phase: "idle", job: null });

// Hạn của bước luôn dài hơn tổng các lần chờ bên trong bộ lái (lib/suno-dom.js) ít nhất 15 s: hết giờ bên trong
// phải về trước với lý do cụ thể (timeout:song_saved…), không để hai đồng hồ đua nhau ra "timeout:<bước>" chung chung.
export const STEP_TIMEOUT_MS = Object.freeze({
  opening_studio: 130_000, // nạp Studio + audio ứng viên (~7-50 s đo được); bên trong chờ 110 s + 1,5 s
  exporting: 200_000, // Export → Full Song → "Song Saved!"; bên trong chờ 10 s + 170 s
  checking_export: 300_000, // bản export cần ~30 s xử lý trước khi tải được
  opening_song: 90_000,
  downloading: 330_000, // WAV "Preparing" 20-250 s rồi Chrome mới tải
  exporting_multitrack: 300_000, // ZIP về máy: bản trộn ~68 MB < 30 s (28/09); trộn + 8 stem 701 MB ~1 phút (01/10)
  opening_stems: 120_000, // trang bài + menu Edit + hộp Extract Stems + chờ danh sách stem; bên trong 30 + 4 + 4 + 15 + 30 s
  extracting: 330_000, // Auto split: đo 01/10 ~1 phút; bên trong chờ 300 s
  opening_stems_studio: 140_000, // Open in Studio tải lại trang, nạp bản trộn + mọi stem; bên trong chờ 110 s + 1,5 s
  filling_form: 90_000, // điền + đọc lại form Create (~5 s đo được ở tab trước)
  submitting: 120_000, // bấm Create → 2 bài mới hiện trong danh sách
  rendering: 900_000 // Suno render 2 bài ~330 s
});

const RECHECK_MS = 5000;
const MAX_STEMS = 16; // Auto split tách tối đa 12 nhạc cụ; dư ra là đọc nhầm trang
const RENDER_RECHECK_MS = 10_000;
const MAX_CLIPS = 4;

// Job tải đã export thì mọi tin tiến độ mang mã bản export: cầu nối nhớ để lần xếp lại chỉ tải, không export lần hai.
const progress = (job, stepName, exportId) => ({
  type: "report",
  message: { type: "progress", jobId: job.id, step: stepName, ...(exportId ? { exportId } : {}) }
});
const timeout = (phase) => ({ type: "timeout", phase, ms: STEP_TIMEOUT_MS[phase] });

function enter(state, phase, extra, actions) {
  const next = { ...state, ...extra, phase };
  return { state: next, actions: [...actions, progress(state.job, phase, next.exportId), timeout(phase)] };
}

/**
 * Kết thúc job. Job gen đã bấm Create thì LUÔN kèm clipIds — credit đã tiêu, cầu nối phải biết
 * để không bao giờ gen lại mù cùng slot.
 */
function finish(state, status, fields = {}) {
  const clips = state.clipIds?.length ? { clipIds: state.clipIds } : {};
  const exported = state.exportId ? { exportId: state.exportId } : {};
  // Job tách stem: tên các stem thấy trên Suno, và đã bấm Extract (đã tiêu credit) hay chưa.
  const stems = Array.isArray(state.stems) ? { stems: state.stems, spent: state.spent === true } : {};
  const message = { type: "result", jobId: state.job.id, status, ...clips, ...exported, ...stems, ...fields };
  return { state: IDLE, actions: [{ type: "report", message }] };
}

const ignore = (state) => ({ state, actions: [] });

/** Dữ liệu content script cần cho từng lệnh — không gửi gì thừa. */
function payloadOf(job, extra = {}) {
  return job.kind === "generate" ? { packet: job.packet } : { candidateId: job.candidateId, expectedTitle: job.expectedTitle, ...extra };
}

function onJob(state, event) {
  if (state.phase !== "idle") {
    return { state, actions: [{ type: "report", message: { type: "result", jobId: event.job.id, status: "failed", reason: "busy" } }] };
  }
  const job = event.job;
  if (job.kind === "stems_split") {
    const base = { phase: "idle", job, stems: null, spent: false };
    return enter(base, "opening_stems", {}, [{ type: "navigate", url: songUrl(job.candidateId), then: "open_stems_dialog", payload: payloadOf(job) }]);
  }
  if (job.kind === "generate") {
    const base = { phase: "idle", job, observed: null, clipIds: [], seconds: {} };
    return enter(base, "filling_form", {}, [{ type: "navigate", url: CREATE_URL, then: "fill_create_form", payload: payloadOf(job) }]);
  }
  const base = { phase: "idle", job, exportId: null, seconds: null };
  if (isUuid(job.exportId)) {
    // Lần trước đã export rồi dừng: chỉ còn chờ Suno chuẩn bị file và tải.
    return enter(base, "checking_export", { exportId: job.exportId.toLowerCase() }, [{ type: "check_clip", id: job.exportId.toLowerCase() }]);
  }
  return enter(base, "opening_studio", {}, [
    { type: "navigate", url: studioUrl(job.candidateId), then: "wait_studio_ready", payload: payloadOf(job) }
  ]);
}

function onDownloadStep(state, event) {
  if (state.phase === "opening_studio" && event.step === "studio_ready") {
    return enter(state, "exporting", {}, [{ type: "content", command: "export_full_song", payload: payloadOf(state.job) }]);
  }
  if (state.phase === "exporting" && event.step === "exported") {
    if (!isUuid(event.exportId)) return finish(state, "failed", { reason: "bad_export_id" });
    return enter(state, "checking_export", { exportId: event.exportId }, [{ type: "check_clip", id: event.exportId }]);
  }
  if (state.phase === "opening_song" && event.step === "song_ready") {
    return enter(state, "downloading", {}, [
      { type: "expect_download", episode: state.job.episode, exportId: state.exportId, title: state.job.expectedTitle },
      { type: "content", command: "download_wav", payload: payloadOf(state.job, { exportId: state.exportId }) }
    ]);
  }
  return ignore(state);
}

function onGenerateStep(state, event) {
  if (state.phase === "filling_form" && event.step === "form_ready") {
    const observed = event.observed ?? null;
    const mismatches = Array.isArray(event.mismatches) ? event.mismatches.map(String).slice(0, 20) : ["unknown"];
    if (mismatches.length) return finish(state, "failed", { reason: "form_mismatch", mismatches, observed, dryRun: state.job.dryRun });
    if (state.job.dryRun) return finish(state, "done", { dryRun: true, observed });
    return enter(state, "submitting", { observed }, [{ type: "content", command: "submit_create", payload: payloadOf(state.job) }]);
  }
  if (state.phase === "submitting" && event.step === "submitted") {
    const clipIds = Array.isArray(event.clipIds) ? [...new Set(event.clipIds.filter(isUuid).map((id) => id.toLowerCase()))].slice(0, MAX_CLIPS) : [];
    if (!clipIds.length) return finish(state, "failed", { reason: "no_clip_ids", observed: state.observed, dryRun: false });
    return enter(state, "rendering", { clipIds }, clipIds.map((id) => ({ type: "check_clip", id })));
  }
  return ignore(state);
}

function onMultitrackStep(state, event) {
  if (state.phase === "opening_studio" && event.step === "studio_ready") {
    return enter(state, "exporting_multitrack", {}, [
      { type: "expect_download", episode: state.job.episode, exportId: null, title: state.job.expectedTitle, format: "zip" },
      { type: "content", command: "export_multitrack", payload: payloadOf(state.job) }
    ]);
  }
  return ignore(state); // "multitrack_started": chỉ còn chờ ZIP về
}

/** Tên stem từ content script: chuỗi ngắn, không trùng, tối đa MAX_STEMS. Sai dạng → rỗng (coi như chưa đọc được). */
function stemNames(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name) => typeof name === "string" && name.length > 0 && name.length <= 40))].slice(0, MAX_STEMS);
}

/** Bài đã có stem: bấm Open in Studio (trang tự tải lại), nạp xong thì chờ Studio có đủ bản trộn + mọi stem. */
function openStemsStudio(state, stems, spent) {
  const payload = payloadOf(state.job, { stemCount: stems.length });
  return enter(state, "opening_stems_studio", { stems, spent }, [
    { type: "await_load", then: "wait_stems_studio", payload },
    { type: "content", command: "open_stems_studio", payload }
  ]);
}

/**
 * Vào bước bấm Extract. Tin "extracting" gửi cầu nối TRƯỚC lệnh bấm (khác `enter`): cầu nối ghi đã tiêu credit
 * trước khi cú bấm có thể xảy ra. Mất kết nối giữa chừng thì cầu nối coi job là "unknown" và không tự chạy lại.
 */
function startExtract(state, stems) {
  const next = { ...state, stems, spent: true, phase: "extracting" };
  return {
    state: next,
    actions: [progress(state.job, "extracting"), timeout("extracting"), { type: "content", command: "extract_stems", payload: payloadOf(state.job) }]
  };
}

function onStemsStep(state, event) {
  if (state.phase === "opening_stems" && event.step === "stems_dialog") {
    const stems = stemNames(event.stems);
    const hasStems = event.hasStems === true;
    // Dry-run chỉ xem bài đã tách chưa: không bấm Extract, không mở Studio, không tải gì.
    if (state.job.dryRun) return finish({ ...state, stems }, "done", { dryRun: true, hasStems });
    if (hasStems) return openStemsStudio(state, stems, false); // đã tách từ trước: không tốn credit nữa
    // Một lần trước đã bấm Extract mà giờ không thấy stem: không bao giờ bấm lần hai, gọi người.
    if (state.job.alreadySpent) return finish({ ...state, stems }, "needs_human", { reason: "stems_missing_after_spend" });
    return startExtract(state, stems);
  }
  if (state.phase === "extracting" && event.step === "stems_ready") {
    if (event.hasStems !== true) return finish(state, "needs_human", { reason: "stems_not_listed" });
    return openStemsStudio(state, stemNames(event.stems), true);
  }
  if (state.phase === "opening_stems_studio" && event.step === "studio_ready") {
    return enter(state, "exporting_multitrack", {}, [
      { type: "expect_download", episode: state.job.episode, exportId: null, title: state.job.expectedTitle, format: "zip" },
      { type: "content", command: "export_multitrack", payload: payloadOf(state.job) }
    ]);
  }
  return ignore(state); // "studio_opening" (trang đang tải lại), "multitrack_started" (chỉ còn chờ ZIP về)
}

const STEP_HANDLERS = {
  generate: onGenerateStep,
  multitrack_export: onMultitrackStep,
  stems_split: onStemsStep
};

function onContentDone(state, event) {
  if (!state.job) return ignore(state);
  return (STEP_HANDLERS[state.job.kind] ?? onDownloadStep)(state, event);
}

function onExportStatus(state, event) {
  if (event.status !== "complete" || typeof event.seconds !== "number") {
    return { state, actions: [{ type: "check_clip", id: state.exportId, afterMs: RECHECK_MS }] };
  }
  // Bản export phải mang đúng tiêu đề ứng viên — không bao giờ tải một bài khác.
  if (typeof event.title === "string" && !titleMatches(event.title, state.job.expectedTitle)) {
    return finish(state, "failed", { reason: "export_title_mismatch", exportId: state.exportId });
  }
  if (event.seconds < state.job.minSeconds) {
    return finish(state, "failed", { reason: "short", exportId: state.exportId, seconds: event.seconds });
  }
  return enter(state, "opening_song", { seconds: event.seconds }, [
    { type: "navigate", url: songUrl(state.exportId), then: "wait_song_ready", payload: payloadOf(state.job, { exportId: state.exportId }) }
  ]);
}

function onRenderStatus(state, event) {
  if (event.status === "error") return finish(state, "failed", { reason: "clip_error", observed: state.observed, dryRun: false });
  if (event.status !== "complete" || typeof event.seconds !== "number") {
    return { state, actions: [{ type: "check_clip", id: event.id, afterMs: RENDER_RECHECK_MS }] };
  }
  const seconds = { ...state.seconds, [event.id]: event.seconds };
  if (state.clipIds.every((id) => typeof seconds[id] === "number")) {
    return finish({ ...state, seconds }, "done", { dryRun: false, observed: state.observed, seconds });
  }
  return { state: { ...state, seconds }, actions: [] };
}

function onClipStatus(state, event) {
  if (state.phase === "checking_export" && event.id === state.exportId) return onExportStatus(state, event);
  if (state.phase === "rendering" && state.clipIds.includes(event.id)) return onRenderStatus(state, event);
  return ignore(state);
}

const HANDLERS = {
  job: onJob,
  content_done: onContentDone,
  clip_status: onClipStatus,
  download_complete: (state, event) =>
    state.phase === "downloading" || state.phase === "exporting_multitrack"
      ? finish(state, "done", { exportId: state.exportId, filename: event.filename, path: event.path, seconds: state.seconds })
      : ignore(state),
  download_failed: (state, event) =>
    state.phase === "downloading" || state.phase === "exporting_multitrack"
      ? finish(state, "failed", { reason: `download:${String(event.error ?? "unknown").slice(0, 60)}`, exportId: state.exportId })
      : ignore(state),
  human_needed: (state, event) => {
    if (state.phase === "idle") return ignore(state);
    const reason = String(event.reason ?? "unknown").slice(0, 32);
    const done = finish(state, "needs_human", { reason });
    return { state: done.state, actions: [{ type: "report", message: { type: "alert", kind: reason } }, ...done.actions] };
  },
  timeout: (state, event) => (state.phase !== "idle" && event.phase === state.phase ? finish(state, "failed", { reason: `timeout:${state.phase}` }) : ignore(state)),
  content_error: (state, event) =>
    state.phase !== "idle"
      ? finish(state, "failed", {
          reason: [`content:${String(event.step ?? "unknown").slice(0, 40)}`, event.reason ? String(event.reason).slice(0, 60) : null].filter(Boolean).join(":"),
          ...(event.hint ? { domHint: event.hint } : {})
        })
      : ignore(state),
  cancel: onCancel
};

/** Giai đoạn job gen mà cú bấm Create có thể đã chạy — credit có thể đã tiêu. */
export const AFTER_CREATE = new Set(["submitting", "rendering"]);
/** Giai đoạn đang tiêu credit (Create đã bấm, hoặc Suno đang tách stem): DỪNG NGAY không cắt ngang, chỉ dừng hàng chờ. */
export const AFTER_SPEND = new Set([...AFTER_CREATE, "extracting"]);

function onCancel(state, event) {
  if (state.phase === "idle" || event.jobId !== state.job.id) return ignore(state);
  const stop = { type: "content", command: "stop" };
  if (state.job.kind === "generate" && AFTER_CREATE.has(state.phase)) {
    // Không bao giờ lặng lẽ bỏ job gen đã bấm Create: báo kết quả kèm id đã biết (finish tự gắn).
    const done = finish(state, "needs_human", { reason: "cancelled_after_create", observed: state.observed, dryRun: false });
    return { state: done.state, actions: [stop, ...done.actions] };
  }
  if (state.job.kind === "stems_split" && state.spent) {
    // Đã bấm Extract: báo về kèm spent để cầu nối không bao giờ cho bấm lần hai.
    const done = finish(state, "needs_human", { reason: "cancelled_after_extract" });
    return { state: done.state, actions: [stop, ...done.actions] };
  }
  return { state: IDLE, actions: [stop] };
}

/** Trạng thái cần giữ qua lần service worker khởi động lại: job gen có thể đã tiêu credit. */
export function orphanOf(state) {
  if (state.job?.kind !== "generate" || !AFTER_CREATE.has(state.phase)) return null;
  return { jobId: state.job.id, phase: state.phase, clipIds: state.clipIds ?? [] };
}

export function step(state, event) {
  const handler = HANDLERS[event?.type];
  return handler ? handler(state, event) : ignore(state);
}
