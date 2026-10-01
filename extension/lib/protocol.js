// Giao thức với cầu nối Python (scripts/suno_bridge_core.py). Mỗi tin nhắn là một object JSON.
// Module THUẦN: kiểm tra chặt mọi tin nhắn đến trước khi background làm theo — cầu nối chỉ nghe
// 127.0.0.1 và đã ghép cặp, nhưng extension vẫn không tin dữ liệu chưa kiểm.

export const PROTOCOL_VERSION = 2;
export const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:47831";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Tập của kênh (EP006-deep-autumn-post-town-inn) hoặc dự án của người dùng bản cộng đồng (lofi-album, my_songs).
const EPISODE = /^(?:EP\d{3}(?:-[a-z0-9-]{1,80})?|[A-Za-z0-9][A-Za-z0-9_-]{0,40})$/;
// Job tải: <tập|dự án>.SS.<uuid bài>. Job gen: ….SS.B<SS> hoặc ….SS.B<SS>v<n>. Job 32-bit: ….SS.MT<take>.
// Job tách stem: ….SS.ST<take>. Tập dùng mã ngắn EP###; dự án dùng nguyên tên (không có dấu chấm).
const JOB_ID = /^(?:EP\d{3}|[A-Za-z0-9][A-Za-z0-9_-]{0,40})\.\d{2,4}\.(?:[0-9a-f-]{36}|B\d{2,4}(?:v\d{1,3})?|MT\d|ST\d)$/i;
const JOB_KINDS = ["export_download", "generate", "multitrack_export", "stems_split"];
const BATCH_ID = /^B\d{2,4}(?:v\d{1,3})?$/;
// Giới hạn của chính Suno (knowledge/suno/09_SUNO_V6_ADAPTER.md), không phải chính sách dự án.
const TEXT_MAX = 1000;

// ── Bắt tay hai chiều (HMAC-SHA256) ────────────────────────────────────────────────────────
// Mã ghép cặp KHÔNG BAO GIỜ đi qua socket. Extension là bên gọi tới 127.0.0.1:47831: một tiến trình
// lạ chiếm cổng trước cầu nối không được nhận mã, cũng không ra lệnh được — nó không làm ra bằng
// chứng của cầu nối. Thứ tự: hello{nonce} → challenge{nonce, proof} → auth{proof} → welcome.
const NONCE = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

export const bridgeProofInput = (clientNonce, serverNonce) => `jr-suno/bridge/${clientNonce}/${serverNonce}`;
export const extensionProofInput = (serverNonce, clientNonce) => `jr-suno/ext/${serverNonce}/${clientNonce}`;

/** 32 byte ngẫu nhiên, hex thường — dùng một lần cho mỗi lần nối. */
export function randomNonce(cryptoImpl = globalThis.crypto) {
  return [...cryptoImpl.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256(key = mã ghép cặp, msg) dạng hex thường. */
export async function hmacHex(token, message, cryptoImpl = globalThis.crypto) {
  const key = await cryptoImpl.subtle.importKey("raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await cryptoImpl.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** So hai chuỗi hex không dừng sớm (không lộ vị trí khác nhau qua thời gian). */
export function sameHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `stopped`: chủ kênh bấm DỪNG NGAY lúc mất kết nối — cầu nối tạm dừng hàng chờ trước khi giao việc. */
export function helloMessage(nonce, version, stopped = false) {
  const hello = { type: "hello", protocol: PROTOCOL_VERSION, version, nonce };
  return stopped ? { ...hello, stopped: true } : hello;
}

export function authMessage(proof) {
  return { type: "auth", proof };
}

const text = (value, max) => typeof value === "string" && value.length <= max;
const intIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function validCommon(job) {
  return (
    job &&
    typeof job === "object" &&
    JOB_ID.test(String(job.id)) &&
    EPISODE.test(String(job.episode)) &&
    Number.isInteger(job.slot) &&
    job.slot > 0 &&
    typeof job.minSeconds === "number" &&
    job.minSeconds > 0
  );
}

function validDownload(job) {
  return (
    UUID.test(String(job.candidateId)) &&
    (job.exportId === undefined || UUID.test(String(job.exportId))) &&
    typeof job.expectedTitle === "string" &&
    job.expectedTitle.length > 0 &&
    job.expectedTitle.length <= 300
  );
}

/** Packet chỉ-nhạc-cụ: bộ lái chưa hỗ trợ lời bài, Inspo, Custom Model — cầu nối đã từ chối trước. */
function validPacket(packet) {
  return (
    packet &&
    typeof packet === "object" &&
    text(packet.title, 300) &&
    packet.title.length > 0 &&
    text(packet.styles, TEXT_MAX) &&
    packet.styles.length > 0 &&
    text(packet.exclude, TEXT_MAX) &&
    packet.lyrics === "" &&
    /^v\d[\w.-]*$/.test(String(packet.model)) &&
    packet.tab === "advanced" &&
    (packet.durationSeconds === null || (intIn(packet.durationSeconds, 10, 360) && packet.durationSeconds % 5 === 0)) &&
    typeof packet.maxMode === "boolean" &&
    intIn(packet.variety, 0, 4) &&
    intIn(packet.weirdness, 0, 100) &&
    intIn(packet.styleInfluence, 0, 100) &&
    [null, "male", "female"].includes(packet.vocalGender) &&
    typeof packet.myTaste === "boolean"
  );
}

function validGenerate(job) {
  return (
    BATCH_ID.test(String(job.batchId)) &&
    String(job.id).endsWith(`.${job.batchId}`) &&
    typeof job.dryRun === "boolean" &&
    validPacket(job.packet)
  );
}

/** Job 32-bit (Studio → Export → Multitrack của một take đã có): như job tải, thêm số take 1–9 khớp mã job. */
function validMultitrack(job) {
  return (
    UUID.test(String(job.candidateId)) &&
    intIn(job.take, 1, 9) &&
    String(job.id).endsWith(`.MT${job.take}`) &&
    typeof job.expectedTitle === "string" &&
    job.expectedTitle.length > 0 &&
    job.expectedTitle.length <= 300
  );
}

/**
 * Job tách stem (Auto split, 50 credit/bài): như job 32-bit, thêm `dryRun` (chỉ xem bài đã tách chưa, không bấm
 * Extract) và `alreadySpent` (một lần trước đã bấm Extract: lần này tuyệt đối không bấm nữa).
 */
function validStems(job) {
  return (
    UUID.test(String(job.candidateId)) &&
    intIn(job.take, 1, 9) &&
    String(job.id).endsWith(`.ST${job.take}`) &&
    typeof job.expectedTitle === "string" &&
    job.expectedTitle.length > 0 &&
    job.expectedTitle.length <= 300 &&
    typeof job.dryRun === "boolean" &&
    (job.alreadySpent === undefined || typeof job.alreadySpent === "boolean")
  );
}

function validJob(job) {
  if (!validCommon(job)) return false;
  if (job.kind === "export_download") return validDownload(job);
  if (job.kind === "multitrack_export") return validMultitrack(job);
  if (job.kind === "stems_split") return validStems(job);
  if (job.kind === "generate") return validGenerate(job);
  return false;
}

// ── Ảnh hàng chờ (cầu nối → side panel) ────────────────────────────────────────────────────
// Chỉ để vẽ tiến độ; extension không làm theo gì trong này. Vẫn kiểm chặt và cắt chữ vì nó được vẽ ra màn hình.
const QUEUE_STATUSES = new Set(["queued", "sent", "running", "done", "failed", "needs_human", "unknown", "cancelled"]);
const QUEUE_MAX_JOBS = 400; // khớp QUEUE_PICTURE_MAX_JOBS phía Python
const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : null);

function queueJob(job) {
  if (!job || typeof job !== "object") return null;
  if (!JOB_ID.test(String(job.id)) || !JOB_KINDS.includes(job.kind)) return null;
  if (!Number.isInteger(job.slot) || job.slot <= 0 || !QUEUE_STATUSES.has(job.status)) return null;
  return {
    id: job.id,
    kind: job.kind,
    slot: job.slot,
    status: job.status,
    step: clip(job.step, 32),
    reason: clip(job.reason, 32),
    title: clip(job.title, 300) ?? "",
    at: ISO_AT.test(String(job.at)) ? job.at : null
  };
}

function parseQueue(message) {
  if (!Array.isArray(message.episodes)) return null;
  let count = 0;
  const episodes = [];
  for (const episode of message.episodes) {
    if (!episode || !EPISODE.test(String(episode.episode)) || !Array.isArray(episode.jobs)) return null;
    count += episode.jobs.length;
    if (count > QUEUE_MAX_JOBS) return null;
    const jobs = episode.jobs.map(queueJob);
    if (jobs.includes(null)) return null;
    episodes.push({ episode: episode.episode, jobs });
  }
  return { type: "queue", paused: message.paused === true, episodes };
}

/** @returns {{ok: true, message: object} | {ok: false, error: string}} */
export function parseIncoming(raw) {
  let message;
  try {
    message = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (!message || typeof message !== "object") return { ok: false, error: "not an object" };
  switch (message.type) {
    case "welcome": {
      // Cầu nối (đã xác thực) cho biết đường dẫn của nó để khung "Copy cấu hình MCP" tự điền.
      const path = message.bridgePath;
      const bridgePath =
        typeof path === "string" && path.length <= 400 && /^[A-Za-z]:[\\/][^"\r\n<>|?*]*\.py$/i.test(path) ? path : undefined;
      // Phiên bản cầu nối cho chân trang ("Ext v… · App v…"); chỉ nhận dạng số x.y.z.
      const bridgeVersion = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(message.bridgeVersion ?? "")) ? message.bridgeVersion : undefined;
      return { ok: true, message: { type: "welcome", ...(bridgePath ? { bridgePath } : {}), ...(bridgeVersion ? { bridgeVersion } : {}) } };
    }
    case "close":
    case "reload": // cầu nối mới hơn: tự nạp lại khi rảnh (controller quyết), không mang dữ liệu gì
      return { ok: true, message: { type: message.type } };
    case "challenge":
      return NONCE.test(String(message.nonce)) && NONCE.test(String(message.proof))
        ? { ok: true, message: { type: "challenge", nonce: message.nonce, proof: message.proof } }
        : { ok: false, error: "malformed challenge" };
    case "error":
      return { ok: true, message: { type: "error", message: String(message.message ?? "").slice(0, 300) } };
    case "cancel":
      return JOB_ID.test(String(message.jobId))
        ? { ok: true, message: { type: "cancel", jobId: message.jobId } }
        : { ok: false, error: "cancel without a valid jobId" };
    case "job":
      return validJob(message.job) ? { ok: true, message: { type: "job", job: message.job } } : { ok: false, error: "invalid job" };
    case "queue": {
      const queue = parseQueue(message);
      return queue ? { ok: true, message: queue } : { ok: false, error: "invalid queue picture" };
    }
    default:
      return { ok: false, error: `unknown type ${String(message.type).slice(0, 40)}` };
  }
}

export function isUuid(value) {
  return UUID.test(String(value));
}
