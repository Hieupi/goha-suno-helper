import test from "node:test";
import assert from "node:assert/strict";
import { IDLE, STEP_TIMEOUT_MS, step } from "../lib/runner.js";

// Bộ máy trạng thái của MỘT job Studio export → tải WAV. Thuần: (state, event) → {state, actions}.
// Background thực thi actions (điều hướng tab, ra lệnh content script, đọc trạng thái clip, báo cầu nối).

const CANDIDATE = "11111111-1111-4111-8111-111111111111";
const EXPORT = "22222222-2222-4222-8222-222222222222";
const JOB = {
  id: `EP006.01.${CANDIDATE}`,
  kind: "export_download",
  episode: "EP006-deep-autumn-post-town-inn",
  slot: 1,
  candidateId: CANDIDATE,
  expectedTitle: "雨夜の宿口",
  minSeconds: 320
};

function run(events) {
  let state = IDLE;
  const all = [];
  for (const event of events) {
    const out = step(state, event);
    state = out.state;
    all.push(...out.actions);
  }
  return { state, actions: all };
}

const types = (actions) => actions.map((action) => action.type);
const reports = (actions) => actions.filter((action) => action.type === "report").map((action) => action.message);

test("job mới → mở Studio của ứng viên, báo tiến độ, hẹn giờ", () => {
  const { state, actions } = step(IDLE, { type: "job", job: JOB });
  assert.equal(state.phase, "opening_studio");
  assert.deepEqual(actions[0], {
    type: "navigate",
    url: `https://suno.com/studio?for_clip_id=${CANDIDATE}&create_new=1`,
    then: "wait_studio_ready",
    payload: { candidateId: CANDIDATE, expectedTitle: JOB.expectedTitle }
  });
  assert.deepEqual(reports(actions), [{ type: "progress", jobId: JOB.id, step: "opening_studio" }]);
  assert.deepEqual(actions.find((a) => a.type === "timeout"), { type: "timeout", phase: "opening_studio", ms: STEP_TIMEOUT_MS.opening_studio });
});

const HAPPY = [
  { type: "job", job: JOB },
  { type: "content_done", step: "studio_ready" },
  { type: "content_done", step: "exported", exportId: EXPORT },
  { type: "clip_status", id: EXPORT, status: "complete", seconds: 327.9, title: "EP006.01. 雨夜の宿口" },
  { type: "content_done", step: "song_ready" },
  { type: "download_complete", filename: "EP006.01. 雨夜の宿口.wav", path: "C:\\Users\\x\\Downloads\\JR-Suno\\EP006\\EP006.01. 雨夜の宿口.wav" }
];

test("đường trơn: Export → kiểm thời lượng bản export → mở trang bài → tải WAV → báo done", () => {
  const { state, actions } = run(HAPPY);
  assert.equal(state.phase, "idle");
  const result = reports(actions).at(-1);
  assert.deepEqual(result, {
    type: "result",
    jobId: JOB.id,
    status: "done",
    exportId: EXPORT,
    filename: "EP006.01. 雨夜の宿口.wav",
    path: "C:\\Users\\x\\Downloads\\JR-Suno\\EP006\\EP006.01. 雨夜の宿口.wav",
    seconds: 327.9
  });
  assert.ok(actions.some((a) => a.type === "content" && a.command === "export_full_song"));
  assert.ok(actions.some((a) => a.type === "check_clip" && a.id === EXPORT));
  assert.ok(actions.some((a) => a.type === "navigate" && a.url === `https://suno.com/song/${EXPORT}` && a.then === "wait_song_ready"));
  assert.ok(actions.some((a) => a.type === "expect_download" && a.episode === JOB.episode && a.exportId === EXPORT));
  assert.ok(actions.some((a) => a.type === "content" && a.command === "download_wav"));
});

test("bản export ngắn hơn ngưỡng → KHÔNG tải, báo failed short kèm số giây", () => {
  const { state, actions } = run([
    ...HAPPY.slice(0, 3),
    { type: "clip_status", id: EXPORT, status: "complete", seconds: 262.1 }
  ]);
  assert.equal(state.phase, "idle");
  assert.deepEqual(reports(actions).at(-1), { type: "result", jobId: JOB.id, status: "failed", reason: "short", exportId: EXPORT, seconds: 262.1 });
  assert.ok(!actions.some((a) => a.type === "content" && a.command === "download_wav"));
});

test("bản export chưa render xong → hẹn đọc lại, không nhảy bước", () => {
  const { state, actions } = run([
    ...HAPPY.slice(0, 3),
    { type: "clip_status", id: EXPORT, status: "streaming", seconds: null }
  ]);
  assert.equal(state.phase, "checking_export");
  assert.deepEqual(actions.at(-1), { type: "check_clip", id: EXPORT, afterMs: 5000 });
});

test("id bản export không phải uuid → failed, không đi tiếp", () => {
  const { state, actions } = run([...HAPPY.slice(0, 2), { type: "content_done", step: "exported", exportId: "../x" }]);
  assert.equal(state.phase, "idle");
  assert.equal(reports(actions).at(-1).reason, "bad_export_id");
});

test("gặp CAPTCHA / đăng xuất ở bất kỳ bước nào → needs_human + alert", () => {
  const { state, actions } = run([...HAPPY.slice(0, 2), { type: "human_needed", reason: "captcha" }]);
  assert.equal(state.phase, "idle");
  const sent = reports(actions);
  assert.deepEqual(sent.at(-2), { type: "alert", kind: "captcha" });
  assert.deepEqual(sent.at(-1), { type: "result", jobId: JOB.id, status: "needs_human", reason: "captcha" });
});

test("hết giờ đúng bước đang làm → failed timeout:<bước>; hẹn giờ của bước cũ bị bỏ qua", () => {
  const stale = run([...HAPPY.slice(0, 2), { type: "timeout", phase: "opening_studio" }]);
  assert.equal(stale.state.phase, "exporting", "timeout của bước đã qua không được làm hỏng job");
  const { state, actions } = run([...HAPPY.slice(0, 2), { type: "timeout", phase: "exporting" }]);
  assert.equal(state.phase, "idle");
  assert.equal(reports(actions).at(-1).reason, "timeout:exporting");
});

test("tải lỗi → failed kèm lý do Chrome", () => {
  const { actions } = run([...HAPPY.slice(0, 5), { type: "download_failed", error: "NETWORK_FAILED" }]);
  assert.deepEqual(reports(actions).at(-1), { type: "result", jobId: JOB.id, status: "failed", reason: "download:NETWORK_FAILED", exportId: EXPORT });
});

test("cầu nối huỷ đúng job đang làm → về idle, dừng content, KHÔNG báo result", () => {
  const { state, actions } = run([...HAPPY.slice(0, 2), { type: "cancel", jobId: JOB.id }]);
  assert.equal(state.phase, "idle");
  assert.ok(actions.some((a) => a.type === "content" && a.command === "stop"));
  assert.ok(!reports(actions).some((m) => m.type === "result"), "cầu nối đã tự ghi cancelled — không báo trùng");
});

test("sự kiện lạc bước (vd tải xong khi đang export) bị bỏ qua", () => {
  const { state, actions } = run([...HAPPY.slice(0, 2), { type: "download_complete", filename: "x.wav", path: "x.wav" }]);
  assert.equal(state.phase, "exporting");
  assert.equal(types(actions).filter((t) => t === "report").length, 2);
});

test("đang bận mà nhận job thứ hai → từ chối job đó, giữ job đang làm", () => {
  const other = { ...JOB, id: `EP006.02.${EXPORT}` };
  const { state, actions } = run([...HAPPY.slice(0, 2), { type: "job", job: other }]);
  assert.equal(state.job.id, JOB.id);
  assert.deepEqual(reports(actions).at(-1), { type: "result", jobId: other.id, status: "failed", reason: "busy" });
});

test("lỗi do content script báo → failed kèm bước", () => {
  const { actions } = run([...HAPPY.slice(0, 2), { type: "content_error", step: "export_full_song", message: "không thấy nút Export" }]);
  assert.deepEqual(reports(actions).at(-1), { type: "result", jobId: JOB.id, status: "failed", reason: "content:export_full_song" });
});

test("bản export mang tiêu đề KHÁC ứng viên → dừng, không mở trang bài, không tải", () => {
  const { state, actions } = run([
    { type: "job", job: JOB },
    { type: "content_done", step: "studio_ready" },
    { type: "content_done", step: "exported", exportId: EXPORT },
    { type: "clip_status", id: EXPORT, status: "complete", seconds: 330, title: "EP006.02. 別の曲" }
  ]);
  assert.equal(state.phase, "idle");
  assert.equal(actions.some((a) => a.type === "navigate" && a.url.includes(EXPORT)), false);
  assert.equal(actions.at(-1).message.reason, "export_title_mismatch");
});

test("đã export: tin tiến độ mang mã bản export để cầu nối nhớ", () => {
  const { actions } = run([{ type: "job", job: JOB }, { type: "content_done", step: "studio_ready" }, { type: "content_done", step: "exported", exportId: EXPORT }]);
  assert.deepEqual(reports(actions).at(-1), { type: "progress", jobId: JOB.id, step: "checking_export", exportId: EXPORT });
});

test("dừng sau khi đã export: kết quả mang mã bản export", () => {
  const { actions } = run([
    { type: "job", job: JOB },
    { type: "content_done", step: "studio_ready" },
    { type: "content_done", step: "exported", exportId: EXPORT },
    { type: "human_needed", reason: "captcha" }
  ]);
  assert.equal(reports(actions).at(-1).exportId, EXPORT);
});

test("job xếp lại có mã bản export: bỏ qua Studio, vào thẳng bước chờ Suno chuẩn bị file", () => {
  const { state, actions } = step(IDLE, { type: "job", job: { ...JOB, exportId: EXPORT } });
  assert.equal(state.phase, "checking_export");
  assert.equal(state.exportId, EXPORT);
  assert.deepEqual(actions[0], { type: "check_clip", id: EXPORT });
  assert.equal(actions.some((a) => a.type === "navigate"), false, "không mở Studio, không export lần hai");
});

test("mã bản export sai dạng khi xếp lại: làm lại từ đầu như job mới", () => {
  const { state } = step(IDLE, { type: "job", job: { ...JOB, exportId: "nope" } });
  assert.equal(state.phase, "opening_studio");
});

test("bộ lái lỗi: kết quả mang ảnh gọn của trang để sửa selector", () => {
  const hint = { path: "/studio", labels: ["Export menu", "Full Song"] };
  const { actions } = run([{ type: "job", job: JOB }, { type: "content_error", step: "export_full_song", reason: "timeout:song_saved", hint }]);
  assert.deepEqual(reports(actions).at(-1).domHint, hint);
});

// ── Xuất 32-bit float: Studio → Export → Multitrack (0 credit) ─────────────────────────────

const MT = { id: "EP008.05.MT1", kind: "multitrack_export", episode: "EP008-winter-edo-reading-room", slot: 5, take: 1,
  candidateId: CANDIDATE, expectedTitle: "墨と炭の香", minSeconds: 320 };

test("job 32-bit: mở Studio của đúng bài, rồi Export → Multitrack và chờ đúng file ZIP", () => {
  const first = step(IDLE, { type: "job", job: MT });
  assert.equal(first.state.phase, "opening_studio");
  assert.equal(first.actions[0].url, `https://suno.com/studio?for_clip_id=${CANDIDATE}&create_new=1`);
  const { state, actions } = step(first.state, { type: "content_done", step: "studio_ready" });
  assert.equal(state.phase, "exporting_multitrack");
  assert.deepEqual(actions.find((a) => a.type === "expect_download"),
    { type: "expect_download", episode: MT.episode, exportId: null, title: MT.expectedTitle, format: "zip" });
  assert.equal(actions.find((a) => a.type === "content").command, "export_multitrack");
});

test("job 32-bit: ZIP về → xong, báo tên file và đường dẫn", () => {
  const { state, actions } = run([
    { type: "job", job: MT },
    { type: "content_done", step: "studio_ready" },
    { type: "content_done", step: "multitrack_started" },
    { type: "download_complete", filename: "EP008.05. 墨と炭の香.zip", path: "C:\\JR-Suno\\EP008\\EP008.05. 墨と炭の香.zip" }
  ]);
  assert.equal(state.phase, "idle");
  const result = reports(actions).at(-1);
  assert.equal(result.status, "done");
  assert.equal(result.filename, "EP008.05. 墨と炭の香.zip");
});

// ── Tách stem (Auto split 50 credit) rồi xuất bản trộn + mọi stem 32-bit (đo 01/10) ─────────────

const ST = { id: "EP008.05.ST1", kind: "stems_split", episode: "EP008-winter-edo-reading-room", slot: 5, take: 1,
  candidateId: CANDIDATE, expectedTitle: "墨と炭の香", minSeconds: 320, dryRun: false };
const STEMS = ["Bass", "Guitar", "Strings", "Woodwinds"];

test("job tách stem: mở trang bài của đúng take rồi mở hộp Extract Stems", () => {
  const { state, actions } = step(IDLE, { type: "job", job: ST });
  assert.equal(state.phase, "opening_stems");
  assert.deepEqual(actions[0], { type: "navigate", url: `https://suno.com/song/${CANDIDATE}`, then: "open_stems_dialog",
    payload: { candidateId: CANDIDATE, expectedTitle: "墨と炭の香" } });
});

test("bài đã tách sẵn: KHÔNG bấm Extract, đi thẳng Open in Studio (0 credit)", () => {
  const { state, actions } = run([{ type: "job", job: ST }, { type: "content_done", step: "stems_dialog", hasStems: true, stems: STEMS }]);
  assert.equal(state.phase, "opening_stems_studio");
  assert.equal(state.spent, false);
  assert.equal(actions.some((a) => a.command === "extract_stems"), false);
  // Chờ trang nạp lại PHẢI đặt trước cú bấm Open in Studio.
  const awaitAt = actions.findIndex((a) => a.type === "await_load");
  const clickAt = actions.findIndex((a) => a.command === "open_stems_studio");
  assert.ok(awaitAt >= 0 && awaitAt < clickAt);
  assert.equal(actions[awaitAt].then, "wait_stems_studio");
  assert.equal(actions[awaitAt].payload.stemCount, 4);
});

test("chưa tách + chạy thật: bấm Extract, báo bước extracting (cầu nối ghi đã tiêu credit)", () => {
  const { state, actions } = run([{ type: "job", job: ST }, { type: "content_done", step: "stems_dialog", stems: [] }]);
  assert.equal(state.phase, "extracting");
  assert.equal(actions.find((a) => a.type === "content").command, "extract_stems");
  assert.equal(reports(actions).at(-1).step, "extracting");
});

test("chưa tách + dry-run: xong ngay, không bấm Extract", () => {
  const { state, actions } = run([{ type: "job", job: { ...ST, dryRun: true } }, { type: "content_done", step: "stems_dialog", stems: [] }]);
  assert.equal(state.phase, "idle");
  assert.equal(actions.some((a) => a.command === "extract_stems"), false);
  const result = reports(actions).at(-1);
  assert.deepEqual([result.status, result.dryRun, result.spent, result.stems], ["done", true, false, []]);
});

test("lần trước đã bấm Extract mà vẫn chưa thấy stem: KHÔNG bấm lần hai, gọi người", () => {
  const { state, actions } = run([{ type: "job", job: { ...ST, alreadySpent: true } }, { type: "content_done", step: "stems_dialog", stems: [] }]);
  assert.equal(state.phase, "idle");
  assert.equal(actions.some((a) => a.command === "extract_stems"), false);
  assert.deepEqual([reports(actions).at(-1).status, reports(actions).at(-1).reason], ["needs_human", "stems_missing_after_spend"]);
});

test("cả luồng tách → Studio → ZIP: kết quả mang tên stem và spent", () => {
  const { state, actions } = run([
    { type: "job", job: ST },
    { type: "content_done", step: "stems_dialog", stems: [] },
    { type: "content_done", step: "stems_ready", hasStems: true, stems: STEMS },
    { type: "content_done", step: "studio_opening" },
    { type: "content_done", step: "studio_ready" },
    { type: "content_done", step: "multitrack_started" },
    { type: "download_complete", filename: "EP008.05. 墨と炭の香.zip", path: "C:\JR-Suno\EP008\EP008.05. 墨と炭の香.zip" }
  ]);
  assert.equal(state.phase, "idle");
  assert.deepEqual(actions.find((a) => a.type === "expect_download"),
    { type: "expect_download", episode: ST.episode, exportId: null, title: ST.expectedTitle, format: "zip" });
  const result = reports(actions).at(-1);
  assert.deepEqual([result.status, result.spent, result.stems, result.filename], ["done", true, STEMS, "EP008.05. 墨と炭の香.zip"]);
});

test("tên stem lạ từ trang bị lọc: chuỗi rỗng, quá dài, trùng, không phải chuỗi", () => {
  const { state } = run([{ type: "job", job: ST }, { type: "content_done", step: "stems_dialog", stems: ["Bass", "Bass", "", "x".repeat(41), 7] }]);
  assert.deepEqual(state.stems, ["Bass"]);
});

test("huỷ khi Suno đang tách: không bỏ lặng lẽ, báo needs_human kèm spent", () => {
  const { actions } = run([
    { type: "job", job: ST },
    { type: "content_done", step: "stems_dialog", stems: [] },
    { type: "cancel", jobId: ST.id }
  ]);
  const result = reports(actions).at(-1);
  assert.deepEqual([result.status, result.reason, result.spent], ["needs_human", "cancelled_after_extract", true]);
});

test("hạn giờ bước tách stem dài hơn mọi lần chờ bên trong bộ lái", () => {
  assert.ok(STEP_TIMEOUT_MS.opening_stems >= 30_000 + 4_000 + 4_000 + 15_000 + 30_000 + 15_000);
  assert.ok(STEP_TIMEOUT_MS.extracting >= 300_000 + 15_000);
  assert.ok(STEP_TIMEOUT_MS.opening_stems_studio >= 110_000 + 15_000);
});

test("bước extracting: tin báo cầu nối đi TRƯỚC lệnh bấm Extract", () => {
  const { actions } = run([{ type: "job", job: ST }, { type: "content_done", step: "stems_dialog", hasStems: false, stems: [] }]);
  const reportAt = actions.findIndex((a) => a.type === "report" && a.message.step === "extracting");
  const clickAt = actions.findIndex((a) => a.command === "extract_stems");
  assert.ok(reportAt >= 0 && reportAt < clickAt);
});

test("có nút Open in Studio mà không đọc được tên làn nào: vẫn là bài ĐÃ tách, không bấm Extract", () => {
  const { state, actions } = run([{ type: "job", job: ST }, { type: "content_done", step: "stems_dialog", hasStems: true, stems: [] }]);
  assert.equal(state.phase, "opening_stems_studio");
  assert.equal(actions.some((a) => a.command === "extract_stems"), false);
});

test("dry-run trên bài đã tách: chỉ báo đã tách, không mở Studio, không tải", () => {
  const { state, actions } = run([{ type: "job", job: { ...ST, dryRun: true } }, { type: "content_done", step: "stems_dialog", hasStems: true, stems: STEMS }]);
  assert.equal(state.phase, "idle");
  assert.equal(actions.some((a) => a.type === "await_load" || a.type === "expect_download"), false);
  const result = reports(actions).at(-1);
  assert.deepEqual([result.status, result.dryRun, result.hasStems, result.stems], ["done", true, true, STEMS]);
});

test("tách xong mà hộp không còn nút Open in Studio: gọi người, không mở Studio", () => {
  const { actions } = run([
    { type: "job", job: ST },
    { type: "content_done", step: "stems_dialog", hasStems: false, stems: [] },
    { type: "content_done", step: "stems_ready", hasStems: false, stems: [] }
  ]);
  assert.deepEqual([reports(actions).at(-1).status, reports(actions).at(-1).reason], ["needs_human", "stems_not_listed"]);
});
