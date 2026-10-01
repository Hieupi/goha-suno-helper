// Logic THUẦN của bộ lái UI Suno: không đụng DOM, không đụng chrome.*. Viết dạng script thường
// (không `export`) vì content script MV3 không import được module: manifest nạp file này trước
// lib/suno-dom.js và content.js, cả ba dùng chung globalThis.JrSunoLogic. Test nạp qua node:vm.
//
// Mọi hằng số dưới đây đo trên Suno thật ngày 27/09/2026 (plans/260927-0115-jr-suno-helper-build).
(function attach(root) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SONG_HREF = /^(?:https:\/\/suno\.com)?\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;
  const EPISODE_PREFIX = /^EP\d{3}\.\d{2}\.\s+/;
  const CHROME_COPY = /\s\(\d+\)$/;

  /** Thước trượt ARIA trên form Create: tên → bước của một lần bấm mũi tên. */
  const SLIDER_STEP = Object.freeze({ Duration: 5, Weirdness: 1, "Style Influence": 1, Variety: 1 });
  /** Định dạng trong hộp Download. Chỉ WAV (D035). */
  const FORMATS = Object.freeze(["M4A", "MP3", "WAV", "MP4 video asset"]);

  /** `/song/<uuid>` → uuid, còn lại null. Id bản export đọc từ link "Go to Song". */
  function songIdFromHref(href) {
    const match = SONG_HREF.exec(String(href ?? ""));
    return match ? match[1].toLowerCase() : null;
  }

  /** Tiêu đề so sánh được: bỏ tiền tố `EP###.SS. `, đuôi `.wav`, và " (N)" Chrome thêm khi trùng tên. */
  function normalizeTitle(value) {
    return String(value ?? "")
      .trim()
      .replace(/\.(wav|zip)$/i, "")
      .replace(CHROME_COPY, "")
      .replace(EPISODE_PREFIX, "")
      .normalize("NFC");
  }

  /** Tên file Suno đặt = tiêu đề bài. So khớp CHÍNH XÁC sau khi chuẩn hoá (memory ingest-title-match-exact). */
  function titleMatches(candidate, expectedTitle) {
    const want = normalizeTitle(expectedTitle);
    return want.length > 0 && normalizeTitle(candidate) === want;
  }

  /** Những định dạng phải bấm (bật/tắt) để chỉ còn đúng `wanted` được chọn. */
  function formatsToToggle(selected, wanted = ["WAV"]) {
    const on = new Set(selected);
    const want = new Set(wanted);
    return FORMATS.filter((name) => on.has(name) !== want.has(name));
  }

  /**
   * Số lần bấm mũi tên để thước trượt tới `target`. Âm = ArrowLeft. Null khi target không nằm
   * trong khoảng hoặc không rơi đúng bước (vd Duration 332 s) — bộ lái không làm tròn thay packet.
   */
  function sliderPresses(current, target, step, min, max) {
    if (![current, target, step, min, max].every(Number.isFinite) || step <= 0) return null;
    if (target < min || target > max) return null;
    const presses = (target - current) / step;
    return Number.isInteger(presses) ? presses : null;
  }

  /** Id bài mới xuất hiện trong danh sách sau khi bấm Create (giữ thứ tự hiện trên trang). */
  function newSongIds(before, after) {
    const known = new Set(before);
    const seen = new Set();
    return after.filter((id) => UUID.test(id) && !known.has(id) && !seen.has(id) && seen.add(id));
  }

  /** Studio đã nạp xong audio ứng viên (waveform lấy từ file này): có entry tải xong. */
  function studioAudioLoaded(entries, candidateId) {
    const needle = `/clip/${String(candidateId).toLowerCase()}.`;
    return (entries ?? []).some((entry) => String(entry?.name ?? "").toLowerCase().includes(needle) && Number(entry?.responseEnd) > 0);
  }

  const CLIP_AUDIO = /\/clip\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:m4a|mp3|wav)(?:[?#]|$)/i;

  /**
   * Studio của bài đã tách (đo 01/10): ngoài audio bản gốc còn nạp `/clip/<id stem>.m4a` cho từng stem.
   * Trả số stem KHÁC bản gốc đã nạp xong.
   */
  function studioStemClipsLoaded(entries, candidateId) {
    const own = String(candidateId).toLowerCase();
    const ids = new Set();
    for (const entry of entries ?? []) {
      const match = CLIP_AUDIO.exec(String(entry?.name ?? ""));
      if (match && match[1].toLowerCase() !== own && Number(entry?.responseEnd) > 0) ids.add(match[1].toLowerCase());
    }
    return ids.size;
  }

  /**
   * Hộp Extract Stems hỏi Suno danh sách stem của bài (đo 01/10, đọc được responseStatus):
   *   bài ĐÃ tách  → `/api/clip/<id>/stems/pages` rồi `/stems?page=0`, `?page=1`… (tải từng trang stem)
   *   bài chưa tách → chỉ `/stems/pages`
   * Trả "has_pages" (có trang stem: ĐÃ tách, dù danh sách chưa kịp vẽ), "empty" (pages trả 200, không trang nào),
   * hoặc "unknown" (chưa trả lời / lỗi 401/429/5xx — không chứng minh được gì).
   */
  function stemsListState(entries, candidateId) {
    const base = `/api/clip/${String(candidateId).toLowerCase()}/stems`;
    const done = (entry) => Number(entry?.responseEnd) > 0;
    const named = (entries ?? []).map((entry) => ({ entry, name: String(entry?.name ?? "").toLowerCase() }));
    if (named.some(({ name }) => name.includes(`${base}?page=`))) return "has_pages";
    const pages = named.find(({ entry, name }) => name.includes(`${base}/pages`) && done(entry));
    return pages && pages.entry.responseStatus === 200 ? "empty" : "unknown";
  }

  /** Giá trị form mong đợi từ packet (hợp đồng v2) theo đúng tên khối `generation_panel_observed`. */
  function expectedPanel(packet) {
    return {
      model: packet.model,
      tab: packet.tab,
      title: packet.title,
      lyrics_empty: String(packet.lyrics ?? "") === "",
      styles: packet.styles,
      exclude: packet.exclude,
      duration_seconds: packet.durationSeconds ?? null,
      max_mode: Boolean(packet.maxMode),
      weirdness: packet.weirdness,
      style_influence: packet.styleInfluence,
      variety: packet.variety,
      vocal_gender: packet.vocalGender ?? null,
      my_taste: Boolean(packet.myTaste)
    };
  }

  /** Các trường form đọc lại KHÁC packet. Rỗng = được phép bấm Create. */
  function formMismatches(observed, packet) {
    const want = expectedPanel(packet);
    return Object.keys(want).filter((key) => observed?.[key] !== want[key]);
  }

  /** Khối ghi vào music_test_results.yaml (`generation_panel_observed`): số ký tự, không chép lại văn bản. */
  function panelRecord(observed) {
    const { styles, exclude, ...rest } = observed;
    return { ...rest, styles_char_count: String(styles ?? "").length, exclude_char_count: String(exclude ?? "").length };
  }

  /**
   * Sau khi đã bấm Create, lý do nào được phép cắt ngang việc chờ id bài mới. Tab ẩn chỉ làm Chrome chạy chậm lại;
   * dừng lúc này là mất dấu hai bài vừa tốn credit. CAPTCHA / đăng xuất thì vẫn phải dừng và gọi người.
   */
  function stopsAfterCreate(reason) {
    return reason === "captcha" || reason === "logged_out";
  }

  root.JrSunoLogic = Object.freeze({
    SLIDER_STEP,
    FORMATS,
    songIdFromHref,
    normalizeTitle,
    titleMatches,
    formatsToToggle,
    sliderPresses,
    newSongIds,
    studioAudioLoaded,
    studioStemClipsLoaded,
    stemsListState,
    expectedPanel,
    formMismatches,
    panelRecord,
    stopsAfterCreate
  });
})(globalThis);
