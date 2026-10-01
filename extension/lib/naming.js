// URL Suno và nơi đặt file tải. Tên file GIỮ NGUYÊN như Suno đặt (tiêu đề bài) — ingest khớp
// tiêu đề CHÍNH XÁC (memory ingest-title-match-exact); chỉ gắn thư mục con theo tập / dự án.
import { isUuid } from "./protocol.js";

export const DOWNLOAD_ROOT = "JR-Suno"; // tập của kênh: Tải xuống/JR-Suno/EP###/
export const PROJECT_ROOT = "GOHA-Suno"; // dự án bản cộng đồng: Tải xuống/GOHA-Suno/<dự án>/
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;
export const CREATE_URL = "https://suno.com/create";

export function studioUrl(candidateId) {
  if (!isUuid(candidateId)) throw new Error("candidate id is not a uuid");
  return `https://suno.com/studio?for_clip_id=${candidateId}&create_new=1`;
}

export function songUrl(exportId) {
  if (!isUuid(exportId)) throw new Error("export id is not a uuid");
  return `https://suno.com/song/${exportId}`;
}

/** `EP006-deep-autumn-post-town-inn` → `EP006`; dự án giữ nguyên tên. Tên lạ (có thể thoát thư mục) → lỗi. */
export function episodeShort(episode) {
  const match = /^(EP\d{3})(?:-|$)/.exec(String(episode));
  if (match) return match[1];
  if (PROJECT.test(String(episode))) return String(episode);
  throw new Error("episode must be EP### or a project name");
}

/**
 * Đường tương đối (trong thư mục Tải xuống của Chrome) cho file của một job: chỉ thêm thư mục con,
 * không đổi tên. Bỏ mọi đường dẫn Chrome gợi ý, chỉ giữ tên file.
 */
export function downloadTarget(episode, suggestedFilename) {
  const name = String(suggestedFilename ?? "").split(/[\\/]/).at(-1).trim();
  if (!name || name === "." || name === "..") throw new Error("empty filename");
  const root = /^EP\d{3}(?:-|$)/.test(String(episode)) ? DOWNLOAD_ROOT : PROJECT_ROOT;
  return `${root}/${episodeShort(episode)}/${name}`;
}

/** Tên file từ đường dẫn đầy đủ (Windows hoặc POSIX). */
export function basename(path) {
  return String(path ?? "").split(/[\\/]/).at(-1);
}
