// lib/suno-logic.js là script thường (content script không import module được) → nạp qua node:vm.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const sandbox = {};
vm.runInNewContext(readFileSync(new URL("../lib/suno-logic.js", import.meta.url), "utf8"), sandbox);
const L = sandbox.JrSunoLogic;

const EXPORT = "ab411a6f-83ca-4460-b20e-df8731668102";
const PACKET = {
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
};

test("id bản export đọc từ href của link Go to Song (đo 27/09)", () => {
  assert.equal(L.songIdFromHref(`/song/${EXPORT}`), EXPORT);
  assert.equal(L.songIdFromHref(`https://suno.com/song/${EXPORT.toUpperCase()}?sh=x`), EXPORT);
  assert.equal(L.songIdFromHref("/song/not-a-uuid"), null);
  assert.equal(L.songIdFromHref(`/playlist/${EXPORT}`), null);
  assert.equal(L.songIdFromHref(undefined), null);
});

test("tên file khớp tiêu đề: bỏ tiền tố EP###.SS., .wav và (N) của Chrome — còn lại phải trùng hẳn", () => {
  assert.equal(L.titleMatches("EP008.04. 頁をめくる.wav", "頁をめくる"), true);
  assert.equal(L.titleMatches("EP008.04. 頁をめくる (1).wav", "EP008.04. 頁をめくる"), true);
  assert.equal(L.titleMatches("EP008.04. 頁をめくる_.wav", "頁をめくる"), false);
  assert.equal(L.titleMatches("EP008.05. 墨と炭の香.wav", "頁をめくる"), false);
  assert.equal(L.titleMatches("anything.wav", ""), false);
});

test("hộp Download: mặc định MP3 → bấm WAV rồi bấm MP3 (đúng thứ tự đo được)", () => {
  assert.deepEqual([...L.formatsToToggle(["MP3"])], ["MP3", "WAV"]);
  assert.deepEqual([...L.formatsToToggle(["WAV"])], []);
  assert.deepEqual([...L.formatsToToggle(["M4A", "WAV", "MP4 video asset"])], ["M4A", "MP4 video asset"]);
  assert.deepEqual([...L.formatsToToggle([])], ["WAV"]);
});

test("thước trượt: số lần bấm mũi tên, không làm tròn thay packet", () => {
  assert.equal(L.sliderPresses(180, 330, 5, 10, 360), 30);
  assert.equal(L.sliderPresses(50, 30, 1, 0, 100), -20);
  assert.equal(L.sliderPresses(1, 1, 1, 0, 4), 0);
  assert.equal(L.sliderPresses(180, 332, 5, 10, 360), null);
  assert.equal(L.sliderPresses(180, 400, 5, 10, 360), null);
  assert.equal(L.sliderPresses(NaN, 30, 1, 0, 100), null);
});

test("id bài mới sau Create: chỉ id mới, không trùng, giữ thứ tự", () => {
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  const c = "33333333-3333-4333-8333-333333333333";
  assert.deepEqual([...L.newSongIds([a], [b, c, a, b, "x"])], [b, c]);
  assert.deepEqual([...L.newSongIds([a, b], [a, b])], []);
});

test("Studio sẵn sàng khi file audio của ĐÚNG ứng viên đã tải xong", () => {
  const id = "9bcb270a-71e6-4e79-94ed-1216a08634a3";
  const url = `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${id}.m4a`;
  assert.equal(L.studioAudioLoaded([{ name: url, responseEnd: 1234 }], id), true);
  assert.equal(L.studioAudioLoaded([{ name: url, responseEnd: 0 }], id), false);
  assert.equal(L.studioAudioLoaded([{ name: url.replace(id, "3b98a9df-cbd7-4469-af65-eb56a7a4b6dd"), responseEnd: 9 }], id), false);
  assert.equal(L.studioAudioLoaded(undefined, id), false);
});

test("form đọc lại khớp packet → không lệch; sai một trường → chỉ ra đúng trường đó", () => {
  const observed = { ...L.expectedPanel(PACKET) };
  assert.deepEqual([...L.formMismatches(observed, PACKET)], []);
  assert.deepEqual([...L.formMismatches({ ...observed, max_mode: false, weirdness: 50 }, PACKET)], ["max_mode", "weirdness"]);
  assert.deepEqual([...L.formMismatches({ ...observed, duration_seconds: null }, { ...PACKET })], ["duration_seconds"]);
  assert.deepEqual([...L.formMismatches({ ...observed, duration_seconds: null }, { ...PACKET, durationSeconds: null })], []);
  assert.ok(L.formMismatches(undefined, PACKET).length > 0);
});

test("khối generation_panel_observed chỉ ghi số ký tự, không chép văn bản Styles/Exclude", () => {
  const record = L.panelRecord(L.expectedPanel(PACKET));
  assert.equal(record.styles_char_count, PACKET.styles.length);
  assert.equal(record.exclude_char_count, PACKET.exclude.length);
  assert.equal("styles" in record || "exclude" in record, false);
  assert.equal(record.max_mode, true);
});

test("sau khi bấm Create: chỉ CAPTCHA / đăng xuất mới cắt ngang, tab ẩn thì chờ tiếp (không mất dấu bài đã tốn credit)", () => {
  assert.equal(L.stopsAfterCreate("captcha"), true);
  assert.equal(L.stopsAfterCreate("logged_out"), true);
  assert.equal(L.stopsAfterCreate("tab_hidden"), false);
  assert.equal(L.stopsAfterCreate(null), false);
});

test("Studio của bài đã tách: đếm audio stem KHÁC bản gốc đã nạp xong (đo 01/10)", () => {
  const own = "e833996d-cd17-47e3-be97-eb56e1380806";
  const stem = (id, end = 10) => ({ name: `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${id}.m4a`, responseEnd: end });
  const entries = [
    stem(own),
    stem("dfcb2e06-8443-44de-9129-4a7e4cba3d07"),
    stem("dfcb2e06-8443-44de-9129-4a7e4cba3d07"),
    stem("b04530dd-5e15-47d1-b358-cbab0e16589f"),
    stem("918b92e1-b016-45ad-9cfa-4209138c4e36", 0),
    { name: `https://studio-api-prod.suno.com/api/clip/${own}/stems/pages`, responseEnd: 5 }
  ];
  assert.equal(L.studioStemClipsLoaded(entries, own), 2, "bản gốc, lần trùng và file chưa về không tính");
  assert.equal(L.studioStemClipsLoaded([], own), 0);
});

test("hộp Extract Stems: bài đã tách = có trang stem (?page=), chưa tách = chỉ /pages trả 200 (đo 01/10)", () => {
  const own = "e833996d-cd17-47e3-be97-eb56e1380806";
  const api = (path, end, status = 200, id = own) => ({ name: `https://studio-api-prod.suno.com/api/clip/${id}/stems${path}`, responseEnd: end, responseStatus: status });
  assert.equal(L.stemsListState([api("/pages", 22360)], own), "empty");
  assert.equal(L.stemsListState([api("/pages", 22360), api("?page=0", 0)], own), "has_pages", "trang stem đang tải = ĐÃ tách");
  assert.equal(L.stemsListState([api("/pages", 0)], own), "unknown", "chưa trả lời");
  assert.equal(L.stemsListState([api("/pages", 900, 429)], own), "unknown", "Suno trả lỗi: không chứng minh bài chưa tách");
  assert.equal(L.stemsListState([api("/pages", 900, 0)], own), "unknown", "không đọc được mã trả lời");
  assert.equal(L.stemsListState([api("/pages", 9, 200, "dfcb2e06-8443-44de-9129-4a7e4cba3d07")], own), "unknown", "bài khác");
});
