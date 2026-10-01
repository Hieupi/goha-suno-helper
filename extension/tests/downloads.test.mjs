import test from "node:test";
import assert from "node:assert/strict";
import { downloadBelongsTo, isSunoDownload, isWav, isZip } from "../lib/downloads.js";

test("lượt tải của Suno: CDN, blob:, hoặc trang giới thiệu thuộc Suno", () => {
  assert.equal(isSunoDownload({ url: "https://cdn1.suno.ai/x.wav" }), true);
  assert.equal(isSunoDownload({ url: "blob:https://suno.com/5f0c" }), true);
  assert.equal(isSunoDownload({ url: "https://d2x.cloudfront.net/x.wav", referrer: "https://suno.com/song/a" }), true);
});

test("lượt tải khác không bị đụng", () => {
  assert.equal(isSunoDownload({ url: "https://example.com/a.zip", referrer: "https://example.com/" }), false);
  assert.equal(isSunoDownload({ url: "https://suno.ai.evil.com/x.wav" }), false);
  assert.equal(isSunoDownload({}), false);
});

test("chỉ WAV mới là take", () => {
  assert.equal(isWav("EP006.01. 雨夜の宿口.wav", ""), true);
  assert.equal(isWav("x.bin", "audio/wav"), true);
  assert.equal(isWav("x.mp3", "audio/mpeg"), false);
});

const EXPORT = "22222222-2222-4222-8222-222222222222";
const EXPECTED = { exportId: EXPORT, title: "頁をめくる" };

test("lượt tải thật của Suno (đo 27/09): blob ngẫu nhiên, referrer rỗng → nhận theo tên file khớp tiêu đề", () => {
  const real = { url: "blob:https://suno.com/ff91b3ce-0bec-496c-bf4c-296962ac83f2", referrer: "", filename: "EP008.04. 頁をめくる.wav" };
  assert.equal(downloadBelongsTo(real, EXPECTED), true);
  assert.equal(downloadBelongsTo({ ...real, filename: "C:\\Users\\x\\EP008.04. 頁をめくる (1).wav" }, EXPECTED), true, "Chrome thêm (1) khi trùng tên");
});

test("bài Suno khác tải tay cùng lúc (tiêu đề khác) không bị gán cho job", () => {
  assert.equal(downloadBelongsTo({ url: "blob:https://suno.com/x", filename: "EP008.05. 墨と炭の香.wav" }, EXPECTED), false);
  assert.equal(downloadBelongsTo({ url: "blob:https://suno.com/x", filename: "EP008.04. 頁をめくる_.wav" }, EXPECTED), false);
});

test("URL mang id bản export vẫn được nhận; nguồn ngoài Suno thì không, dù trùng tên", () => {
  assert.equal(downloadBelongsTo({ url: `https://cdn1.suno.ai/${EXPORT}.wav`, filename: "x.wav" }, EXPECTED), true);
  assert.equal(downloadBelongsTo({ url: "https://evil.com/a.wav", filename: "EP008.04. 頁をめくる.wav" }, EXPECTED), false);
  assert.equal(downloadBelongsTo({ url: "blob:https://suno.com/x", filename: "EP008.04. 頁をめくる.wav" }, null), false);
  assert.equal(downloadBelongsTo({ url: "blob:https://suno.com/x", filename: "EP008.04. 頁をめくる.wav" }, { exportId: EXPORT }), false, "thiếu tiêu đề thì không đoán");
});

// Studio → Export → Multitrack (đo 28/09): blob của Suno, tên `<tiêu đề bài>.zip`, không có id bản export.
const ZIP_EXPECTED = { format: "zip", title: "墨と炭の香" };

test("ZIP Multitrack của đúng bài được nhận theo tên", () => {
  const zip = { url: "blob:https://suno.com/0b1c", referrer: "", filename: "EP008.05. 墨と炭の香.zip" };
  assert.equal(downloadBelongsTo(zip, ZIP_EXPECTED), true);
  assert.equal(downloadBelongsTo({ ...zip, filename: "EP008.05. 墨と炭の香 (1).zip" }, ZIP_EXPECTED), true);
});

test("job Multitrack không nhận WAV, bài khác, hay ZIP ngoài Suno", () => {
  const zip = { url: "blob:https://suno.com/0b1c", referrer: "", filename: "EP008.05. 墨と炭の香.zip" };
  assert.equal(downloadBelongsTo({ ...zip, filename: "EP008.05. 墨と炭の香.wav" }, ZIP_EXPECTED), false);
  assert.equal(downloadBelongsTo({ ...zip, filename: "EP008.06. 障子.zip" }, ZIP_EXPECTED), false);
  assert.equal(downloadBelongsTo({ ...zip, url: "https://example.com/a.zip" }, ZIP_EXPECTED), false);
});

test("ZIP là ZIP", () => {
  assert.equal(isZip("a.zip", ""), true);
  assert.equal(isZip("a.bin", "application/zip"), true);
  assert.equal(isZip("a.wav", "audio/wav"), false);
});

test("job tải WAV không nhận ZIP cùng tên bài (take 1/2 chung tiêu đề với job 32-bit)", () => {
  const zip = { url: "blob:https://suno.com/abc", referrer: "", filename: "EP008.04. 頁をめくる.zip" };
  assert.equal(downloadBelongsTo(zip, EXPECTED), false);
  assert.equal(downloadBelongsTo({ ...zip, filename: "EP008.04. 頁をめくる.wav" }, EXPECTED), true);
});
