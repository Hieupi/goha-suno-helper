// Job gen (Create theo SUNO INPUT PACKET): bộ máy trạng thái + kiểm tin nhắn đến.
import test from "node:test";
import assert from "node:assert/strict";
import { IDLE, STEP_TIMEOUT_MS, step } from "../lib/runner.js";
import { parseIncoming } from "../lib/protocol.js";

const PACKET = Object.freeze({
  title: "EP012.01. 梅の里の朝",
  styles: "Instrumental Japanese acoustic BGM",
  exclude: "vocals, choir",
  lyrics: "",
  model: "v6",
  tab: "advanced",
  durationSeconds: 330,
  maxMode: true,
  variety: 1,
  weirdness: 30,
  styleInfluence: 85,
  vocalGender: null,
  myTaste: false
});
const JOB = Object.freeze({ id: "EP012.01.B01v2", kind: "generate", episode: "EP012-early-spring-plum-orchard", slot: 1, batchId: "B01v2", dryRun: false, minSeconds: 320, packet: PACKET });
const DRY = Object.freeze({ ...JOB, dryRun: true });
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const OBSERVED = { model: "v6", tab: "advanced", title: PACKET.title, max_mode: true, styles_char_count: 34 };

function run(events, start = IDLE) {
  let state = start;
  const all = [];
  for (const event of events) {
    const out = step(state, event);
    state = out.state;
    all.push(...out.actions);
  }
  return { state, actions: all };
}
const results = (actions) => actions.filter((a) => a.type === "report" && a.message.type === "result").map((a) => a.message);

test("job gen → mở trang Create, lệnh điền form mang packet, hẹn giờ", () => {
  const { state, actions } = step(IDLE, { type: "job", job: JOB });
  assert.equal(state.phase, "filling_form");
  assert.deepEqual(actions[0], { type: "navigate", url: "https://suno.com/create", then: "fill_create_form", payload: { packet: PACKET } });
  assert.deepEqual(actions.find((a) => a.type === "timeout"), { type: "timeout", phase: "filling_form", ms: STEP_TIMEOUT_MS.filling_form });
});

test("dry-run: form khớp → done kèm khối đọc lại, KHÔNG bao giờ ra lệnh submit_create", () => {
  const { state, actions } = run([{ type: "job", job: DRY }, { type: "content_done", step: "form_ready", observed: OBSERVED, mismatches: [] }]);
  assert.equal(state.phase, "idle");
  assert.equal(actions.some((a) => a.type === "content" && a.command === "submit_create"), false);
  assert.deepEqual(results(actions), [{ type: "result", jobId: DRY.id, status: "done", dryRun: true, observed: OBSERVED }]);
});

test("form lệch packet → failed form_mismatch, không bấm Create", () => {
  const { actions } = run([{ type: "job", job: JOB }, { type: "content_done", step: "form_ready", observed: OBSERVED, mismatches: ["max_mode"] }]);
  assert.equal(actions.some((a) => a.command === "submit_create"), false);
  const [result] = results(actions);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "form_mismatch");
  assert.deepEqual(result.mismatches, ["max_mode"]);
});

test("thiếu danh sách lệch → coi như lệch (không bấm Create khi không chắc)", () => {
  const { actions } = run([{ type: "job", job: JOB }, { type: "content_done", step: "form_ready", observed: OBSERVED }]);
  assert.equal(actions.some((a) => a.command === "submit_create"), false);
  assert.equal(results(actions)[0].reason, "form_mismatch");
});

test("thật: form khớp → submit_create → 2 id → chờ render cả hai → done kèm id + thời lượng", () => {
  const { state, actions } = run([
    { type: "job", job: JOB },
    { type: "content_done", step: "form_ready", observed: OBSERVED, mismatches: [] },
    { type: "content_done", step: "submitted", clipIds: [A, B.toUpperCase(), A, "x"] },
    { type: "clip_status", id: A, status: "streaming", seconds: null },
    { type: "clip_status", id: A, status: "complete", seconds: 330 },
    { type: "clip_status", id: B, status: "complete", seconds: 329.5 }
  ]);
  assert.equal(state.phase, "idle");
  assert.deepEqual(actions.filter((a) => a.type === "content").map((a) => a.command), ["submit_create"]);
  assert.deepEqual(actions.filter((a) => a.type === "check_clip").map((a) => [a.id, a.afterMs ?? 0]), [[A, 0], [B, 0], [A, 10_000]]);
  assert.deepEqual(results(actions), [
    { type: "result", jobId: JOB.id, status: "done", clipIds: [A, B], dryRun: false, observed: OBSERVED, seconds: { [A]: 330, [B]: 329.5 } }
  ]);
});

test("đã bấm Create rồi mới hỏng (hết giờ / CAPTCHA / clip lỗi) → kết quả LUÔN mang clipIds", () => {
  const submitted = [
    { type: "job", job: JOB },
    { type: "content_done", step: "form_ready", observed: OBSERVED, mismatches: [] },
    { type: "content_done", step: "submitted", clipIds: [A, B] }
  ];
  for (const last of [
    { type: "timeout", phase: "rendering" },
    { type: "human_needed", reason: "captcha" },
    { type: "clip_status", id: B, status: "error", seconds: null }
  ]) {
    const [result] = results(run([...submitted, last]).actions);
    assert.notEqual(result.status, "done", last.type);
    assert.deepEqual(result.clipIds, [A, B], last.type);
  }
});

test("Create không ra id nào → failed no_clip_ids", () => {
  const { actions } = run([
    { type: "job", job: JOB },
    { type: "content_done", step: "form_ready", observed: OBSERVED, mismatches: [] },
    { type: "content_done", step: "submitted", clipIds: ["not-a-uuid"] }
  ]);
  assert.equal(results(actions)[0].reason, "no_clip_ids");
});

test("sự kiện của job tải không làm lạc job gen và ngược lại", () => {
  const { state } = run([{ type: "job", job: JOB }, { type: "content_done", step: "studio_ready" }, { type: "content_done", step: "exported", exportId: A }]);
  assert.equal(state.phase, "filling_form");
});

test("protocol v2: nhận job gen hợp lệ, từ chối packet ngoài khả năng bộ lái", () => {
  assert.equal(parseIncoming({ type: "job", job: JOB }).ok, true);
  assert.equal(parseIncoming({ type: "job", job: DRY }).ok, true);
  assert.equal(parseIncoming({ type: "job", job: { ...JOB, packet: { ...PACKET, durationSeconds: null } } }).ok, true);
  const bad = [
    { ...JOB, id: "EP012.01.B02" },
    { ...JOB, batchId: "X01" },
    { ...JOB, dryRun: "no" },
    { ...JOB, packet: { ...PACKET, lyrics: "la la" } },
    { ...JOB, packet: { ...PACKET, styles: "x".repeat(1001) } },
    { ...JOB, packet: { ...PACKET, durationSeconds: 332 } },
    { ...JOB, packet: { ...PACKET, durationSeconds: 400 } },
    { ...JOB, packet: { ...PACKET, weirdness: 101 } },
    { ...JOB, packet: { ...PACKET, variety: 5 } },
    { ...JOB, packet: { ...PACKET, tab: "simple" } },
    { ...JOB, packet: { ...PACKET, vocalGender: "robot" } },
    { ...JOB, packet: null },
    { ...JOB, kind: "remix" }
  ];
  for (const job of bad) assert.equal(parseIncoming({ type: "job", job }).ok, false, JSON.stringify(job).slice(0, 80));
});

test("huỷ job gen SAU khi bấm Create → không lặng lẽ bỏ: needs_human kèm clipIds + lệnh stop", () => {
  const rendering = run([
    { type: "job", job: JOB },
    { type: "content_done", step: "form_ready", observed: OBSERVED, mismatches: [] },
    { type: "content_done", step: "submitted", clipIds: [A, B] }
  ]).state;
  const { state, actions } = step(rendering, { type: "cancel", jobId: JOB.id });
  assert.equal(state.phase, "idle");
  assert.deepEqual(actions[0], { type: "content", command: "stop" });
  const [result] = results(actions);
  assert.equal(result.status, "needs_human");
  assert.equal(result.reason, "cancelled_after_create");
  assert.deepEqual(result.clipIds, [A, B]);
});

test("huỷ job gen khi mới điền form (chưa bấm Create) → dừng bình thường, không cần kết quả", () => {
  const filling = step(IDLE, { type: "job", job: JOB }).state;
  const { state, actions } = step(filling, { type: "cancel", jobId: JOB.id });
  assert.equal(state.phase, "idle");
  assert.deepEqual(actions, [{ type: "content", command: "stop" }]);
});
