// Nhận ra lượt tải của Suno để chỉ gắn thư mục con cho đúng file của job, không đụng tải khác.
//
// Đo 27/09 (lịch sử tải Chrome): WAV bản export về qua `blob:https://suno.com/<ngẫu nhiên>`,
// referrer RỖNG — id bản export không nằm trong URL nào. Nên lượt tải thuộc job khi: của Suno, và
// hoặc URL mang id bản export, hoặc tên file khớp CHÍNH XÁC tiêu đề bài. Controller chỉ hỏi trong
// lúc job đang ở bước tải; sau đó cầu nối đọc id nhúng trong WAV để xác nhận lần cuối.
import "./suno-logic.js";

const { titleMatches } = globalThis.JrSunoLogic;
const SUNO_ROOTS = ["suno.com", "suno.ai"];

function hostOf(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value);
    return (url.protocol === "blob:" ? new URL(url.pathname) : url).hostname;
  } catch {
    return "";
  }
}

function isSunoHost(host) {
  return SUNO_ROOTS.some((root) => host === root || host.endsWith(`.${root}`));
}

/** Lượt tải này do Suno sinh (URL, URL cuối, blob: hay trang giới thiệu thuộc Suno). */
export function isSunoDownload(item) {
  return [item?.url, item?.finalUrl, item?.referrer].some((value) => isSunoHost(hostOf(value)));
}

/** Tên file của lượt tải (Chrome có thể đưa cả đường dẫn). */
function fileNameOf(item) {
  return String(item?.filename ?? "").split(/[\\/]/).at(-1);
}

/**
 * Lượt tải thuộc bản export của job: của Suno VÀ (URL mang id bản export HOẶC tên file khớp chính
 * xác tiêu đề bài). Một bài Suno khác tải tay cùng lúc mang tiêu đề khác nên không bị gán nhầm.
 */
export function downloadBelongsTo(item, expected) {
  if (expected?.format === "zip") {
    // Multitrack (đo 28/09): blob của Suno, tên `<tiêu đề bài>.zip`, không có id nào trong URL.
    const name = fileNameOf(item);
    return isSunoDownload(item) && /\.zip$/i.test(name) && Boolean(expected.title) && titleMatches(name, expected.title);
  }
  const exportId = expected?.exportId;
  if (!exportId || !isSunoDownload(item)) return false;
  if ([item?.url, item?.finalUrl, item?.referrer].some((value) => String(value ?? "").includes(exportId))) return true;
  // Job WAV chỉ nhận file .wav: job 32-bit cùng ô mang CÙNG tiêu đề nhưng tải .zip.
  const name = fileNameOf(item);
  return Boolean(expected.title) && /\.wav$/i.test(name) && titleMatches(name, expected.title);
}

/** File tải của job 32-bit (Multitrack) là ZIP chứa WAV 32-bit float. */
export function isZip(filename, mime) {
  return /\.zip$/i.test(String(filename ?? "")) || /application\/(x-)?zip/i.test(String(mime ?? ""));
}

/** File tải của job phải là WAV (D035). */
export function isWav(filename, mime) {
  return /\.wav$/i.test(String(filename ?? "")) || /audio\/(x-)?wav/i.test(String(mime ?? ""));
}
