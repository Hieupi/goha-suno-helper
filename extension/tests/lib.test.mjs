import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BRIDGE_URL,
  PROTOCOL_VERSION,
  bridgeProofInput,
  extensionProofInput,
  helloMessage,
  hmacHex,
  parseIncoming,
  randomNonce,
  sameHex
} from "../lib/protocol.js";
import { basename, downloadTarget, episodeShort, songUrl, studioUrl } from "../lib/naming.js";
import { reconnectDelayMs } from "../lib/backoff.js";

const ID = "11111111-1111-4111-8111-111111111111";
const JOB = {
  id: `EP006.01.${ID}`,
  kind: "export_download",
  episode: "EP006-deep-autumn-post-town-inn",
  slot: 1,
  candidateId: ID,
  expectedTitle: "雨夜の宿口",
  minSeconds: 320
};

test("cầu nối chỉ ở 127.0.0.1, cùng phiên bản giao thức với Python", () => {
  assert.equal(DEFAULT_BRIDGE_URL, "ws://127.0.0.1:47831");
  assert.deepEqual(helloMessage("ab", "0.1.0"), { type: "hello", protocol: PROTOCOL_VERSION, version: "0.1.0", nonce: "ab" });
});

test("bắt tay HMAC: trùng khớp từng byte với Python (hmac.new(token, msg, sha256).hexdigest())", async () => {
  const client = "11".repeat(32);
  const server = "22".repeat(32);
  assert.equal(await hmacHex("tok", bridgeProofInput(client, server)), "686095d0be8e016702facf98d724f0aca371554e383b73c631fa47ae54bf951a");
  assert.equal(await hmacHex("tok", extensionProofInput(server, client)), "0a003b17248d87c1542ec3d855b14c15a57390aa4053c913a25843eb5f9a1f70");
});

test("nonce 32 byte hex, mỗi lần khác nhau; so hex không dừng sớm", () => {
  const a = randomNonce();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, randomNonce());
  assert.equal(sameHex("abcd", "abcd"), true);
  assert.equal(sameHex("abcd", "abce"), false);
  assert.equal(sameHex("abcd", "abc"), false);
  assert.equal(sameHex(undefined, "abcd"), false);
});

test("challenge sai dạng bị từ chối", () => {
  assert.equal(parseIncoming({ type: "challenge", nonce: "11".repeat(32), proof: "zz" }).ok, false);
  assert.equal(parseIncoming({ type: "challenge", nonce: "11".repeat(32), proof: "22".repeat(32) }).ok, true);
});

test("job hợp lệ được nhận", () => {
  assert.deepEqual(parseIncoming(JSON.stringify({ type: "job", job: JOB })), { ok: true, message: { type: "job", job: JOB } });
});

test("job thiếu/sai trường bị từ chối", () => {
  for (const bad of [
    { ...JOB, candidateId: "../../x" },
    { ...JOB, kind: "create" },
    { ...JOB, episode: "javascript:alert(1)" },
    { ...JOB, minSeconds: 0 },
    { ...JOB, slot: -1 },
    { ...JOB, expectedTitle: "" },
    { ...JOB, id: "rm -rf" }
  ]) {
    assert.equal(parseIncoming({ type: "job", job: bad }).ok, false, JSON.stringify(bad));
  }
});

test("tin nhắn rác / loại lạ bị từ chối, lỗi được cắt ngắn", () => {
  assert.equal(parseIncoming("not json").ok, false);
  assert.equal(parseIncoming({ type: "eval", code: "x" }).ok, false);
  assert.equal(parseIncoming({ type: "cancel", jobId: "x" }).ok, false);
  assert.equal(parseIncoming({ type: "error", message: "x".repeat(1000) }).message.message.length, 300);
});

test("URL Studio / trang bài chỉ nhận uuid", () => {
  assert.equal(studioUrl(ID), `https://suno.com/studio?for_clip_id=${ID}&create_new=1`);
  assert.equal(songUrl(ID), `https://suno.com/song/${ID}`);
  assert.throws(() => studioUrl("x&evil=1"));
  assert.throws(() => songUrl("../"));
});

test("file tải: GIỮ NGUYÊN tên Suno (dấu cách, tiếng Nhật), chỉ thêm thư mục con theo tập", () => {
  assert.equal(episodeShort("EP006-deep-autumn"), "EP006");
  assert.equal(downloadTarget("EP006-deep-autumn", "EP006.01. 雨夜の宿口.wav"), "JR-Suno/EP006/EP006.01. 雨夜の宿口.wav");
  assert.equal(downloadTarget("EP006", "C:\\evil\\..\\x.wav"), "JR-Suno/EP006/x.wav");
  assert.throws(() => downloadTarget("EP006", ".."));
  // Dự án bản cộng đồng: Tải xuống/GOHA-Suno/<dự án>/; tên có thể thoát thư mục thì từ chối.
  assert.equal(downloadTarget("lofi-album", "Rain Tea.wav"), "GOHA-Suno/lofi-album/Rain Tea.wav");
  for (const bad of ["../x", "a/b", "a\b", "", ".hidden"]) assert.throws(() => downloadTarget(bad, "a.wav"), bad);
  assert.equal(basename("C:\\Users\\x\\a b.wav"), "a b.wav");
});

test("nối lại: nhanh lúc đầu, trần 60 s", () => {
  // 10 phút đầu: thử lại ≤ 5 s (mỗi lần thử gọi API extension nên service worker không ngủ) → cầu nối mở là nối trong vài giây.
  assert.deepEqual([0, 1, 2, 3, 4, 50, 119].map(reconnectDelayMs), [500, 1000, 2000, 3000, 5000, 5000, 5000]);
  // Lâu không thấy cầu nối (không ai mở trợ lý AI): thưa ra 30 s cho nhẹ máy.
  assert.equal(reconnectDelayMs(200), 30000);
  assert.equal(reconnectDelayMs(-3), 500);
});

const QUEUE = {
  type: "queue",
  paused: false,
  episodes: [{
    episode: "EP008-winter-edo-reading-room",
    jobs: [
      { id: `EP008.05.${ID}`, kind: "export_download", slot: 5, status: "done", step: "downloading", reason: null, title: "墨と炭の香", at: "2026-09-27T17:38:22Z" },
      { id: "EP008.06.B06v2", kind: "generate", slot: 6, status: "needs_human", step: "filling_form", reason: "tab_hidden", title: "障子", at: "2026-09-27T17:45:15Z" }
    ]
  }]
};

test("ảnh hàng chờ hợp lệ được nhận, giữ đúng các trường", () => {
  const parsed = parseIncoming(QUEUE);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.message, QUEUE);
});

test("ảnh hàng chờ sai dạng bị từ chối cả khối, chữ dài bị cắt", () => {
  const withJob = (patch) => ({ ...QUEUE, episodes: [{ ...QUEUE.episodes[0], jobs: [{ ...QUEUE.episodes[0].jobs[0], ...patch }] }] });
  assert.equal(parseIncoming(withJob({ status: "hacked" })).ok, false);
  assert.equal(parseIncoming(withJob({ id: "rm -rf" })).ok, false);
  assert.equal(parseIncoming(withJob({ slot: 0 })).ok, false);
  assert.equal(parseIncoming(withJob({ kind: "eval" })).ok, false);
  assert.equal(parseIncoming({ ...QUEUE, episodes: [{ episode: "../x", jobs: [] }] }).ok, false);
  assert.equal(parseIncoming({ ...QUEUE, episodes: "x" }).ok, false);
  const long = parseIncoming(withJob({ title: "字".repeat(900), step: "s".repeat(90) }));
  assert.equal(long.ok, true);
  assert.equal(long.message.episodes[0].jobs[0].title.length, 300);
  assert.equal(long.message.episodes[0].jobs[0].step.length, 32);
  const many = { ...QUEUE, episodes: [{ ...QUEUE.episodes[0], jobs: Array(401).fill(QUEUE.episodes[0].jobs[0]) }] };
  assert.equal(parseIncoming(many).ok, false, "quá 400 job: cầu nối không bao giờ gửi vậy");
});

test("job 32-bit hợp lệ được nhận; sai take bị từ chối", () => {
  const mt = { id: "EP008.05.MT1", kind: "multitrack_export", episode: "EP008-winter-edo-reading-room", slot: 5, take: 1,
    candidateId: ID, expectedTitle: "墨と炭の香", minSeconds: 320 };
  assert.equal(parseIncoming({ type: "job", job: mt }).ok, true);
  assert.equal(parseIncoming({ type: "job", job: { ...mt, take: 0 } }).ok, false);
  assert.equal(parseIncoming({ type: "job", job: { ...mt, id: "EP008.05.MTx" } }).ok, false);
});

test("welcome mang phiên bản cầu nối (chân trang side panel); sai dạng thì bỏ", () => {
  assert.equal(parseIncoming({ type: "welcome", bridgeVersion: "0.3.2" }).message.bridgeVersion, "0.3.2");
  assert.equal(parseIncoming({ type: "welcome", bridgeVersion: "<script>" }).message.bridgeVersion, undefined);
});

test("lệnh nạp lại từ cầu nối được nhận (không mang dữ liệu gì)", () => {
  assert.deepEqual(parseIncoming({ type: "reload", extra: "x" }), { ok: true, message: { type: "reload" } });
});

test("job tách stem hợp lệ được nhận; thiếu dryRun, sai take, alreadySpent sai kiểu bị từ chối", () => {
  const st = { id: "EP008.05.ST1", kind: "stems_split", episode: "EP008-winter-edo-reading-room", slot: 5, take: 1,
    candidateId: ID, expectedTitle: "墨と炭の香", minSeconds: 320, dryRun: false };
  assert.equal(parseIncoming({ type: "job", job: st }).ok, true);
  assert.equal(parseIncoming({ type: "job", job: { ...st, alreadySpent: true } }).ok, true);
  const { dryRun, ...noDry } = st;
  assert.equal(parseIncoming({ type: "job", job: noDry }).ok, false, "dryRun phải nói rõ");
  assert.equal(parseIncoming({ type: "job", job: { ...st, dryRun: "false" } }).ok, false);
  assert.equal(parseIncoming({ type: "job", job: { ...st, id: "EP008.05.ST2" } }).ok, false);
  assert.equal(parseIncoming({ type: "job", job: { ...st, alreadySpent: "yes" } }).ok, false);
});

test("bản cộng đồng: dự án và mã job tổng quát được nhận; tên có dấu chấm/gạch chéo bị từ chối", () => {
  const job = { id: `lofi-album.01.${ID}`, kind: "export_download", episode: "lofi-album", slot: 1, candidateId: ID, expectedTitle: "Rain", minSeconds: 100 };
  assert.equal(parseIncoming({ type: "job", job }).ok, true);
  assert.equal(parseIncoming({ type: "job", job: { ...job, id: `lofi.album.01.${ID}` } }).ok, false);
  assert.equal(parseIncoming({ type: "job", job: { ...job, episode: "../x" } }).ok, false);
  const gen = { id: "lofi.120.B120", kind: "generate", episode: "lofi", slot: 120, batchId: "B120", dryRun: true, minSeconds: 1,
    packet: { title: "t", styles: "s", exclude: "", lyrics: "", model: "v6", tab: "advanced", durationSeconds: null, maxMode: false,
      variety: 2, weirdness: 50, styleInfluence: 50, vocalGender: null, myTaste: false } };
  assert.equal(parseIncoming({ type: "job", job: gen }).ok, true, "ô > 99 vẫn nhận");
});

test("tên giống tập mà không phải tập (EP123abc) là dự án, tải về GOHA-Suno", () => {
  assert.equal(downloadTarget("EP123abc", "a.wav"), "GOHA-Suno/EP123abc/a.wav");
  assert.equal(downloadTarget("EP123", "a.wav"), "JR-Suno/EP123/a.wav");
});
