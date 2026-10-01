// Bộ lái UI Suno — phần CHẠM DOM (isolated world, không tiêm MAIN world). Script thường, gắn vào
// globalThis.JrSunoDrivers; dùng quyết định thuần của lib/suno-logic.js (nạp trước trong manifest).
//
// Mỗi selector/cách bấm dưới đây đã đo trên Suno thật 27/09/2026 (bằng chứng: plans/260927-0115-
// jr-suno-helper-build/plan.md). Không đoán: không thấy đúng nút → ném lỗi có tên, KHÔNG bấm bừa.
// Chờ theo trạng thái trang (thăm dò 250 ms + hạn giờ), không chờ cứng.
(function attach(root) {
  const L = root.JrSunoLogic;
  const POLL_MS = 250;
  const SELECTED = "hxc-btn-variant-standard-legacy"; // nút đang chọn trong cặp Off/On, Male/Female, Custom/Auto
  const CAPTCHA_FRAME = /challenges\.cloudflare\.com|hcaptcha\.com|recaptcha/i;
  const LOGIN_TEXT = /^(log in|sign in)$/i;

  class StepError extends Error {}
  class HumanNeeded extends Error {
    constructor(reason) {
      super(reason);
      this.reason = reason;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function visible(element) {
    if (!element?.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
  }

  /** CAPTCHA / đăng xuất → dừng, gọi chủ kênh. Không bao giờ chạm vào widget. Tab ẩn không dừng: xem waitWhileHidden. */
  function humanNeeded() {
    if ([...document.querySelectorAll("iframe")].some((frame) => CAPTCHA_FRAME.test(frame.src) && visible(frame))) return "captcha";
    if ([...document.querySelectorAll("a, button")].some((el) => LOGIN_TEXT.test(el.textContent.trim()) && visible(el))) return "logged_out";
    return null;
  }

  /**
   * Ảnh gọn của trang lúc bộ lái lỗi: đường dẫn + tối đa 40 nhãn nút/liên kết/mục menu ĐANG HIỆN (aria-label hoặc chữ).
   * Đủ để thấy Suno đổi tên nút nào mà không phải ghi lại cả phiên. Không lấy ô nhập, không lấy nội dung trang khác.
   */
  function pageHint() {
    const labels = new Set();
    for (const el of document.querySelectorAll('button, a, [role="menuitem"], [role="tab"], [role="option"]')) {
      if (!visible(el)) continue;
      const label = String(el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (label) labels.add(label);
      if (labels.size >= 40) break;
    }
    return { path: String(location.pathname).slice(0, 80), labels: [...labels] };
  }

  // content.js gắn hàm báo "đang bị che / đã hiện lại" cho service worker (treo hẹn giờ của bước).
  let onHiddenChange = () => {};
  function setHiddenListener(fn) {
    onHiddenChange = typeof fn === "function" ? fn : () => {};
  }

  /**
   * Tab Suno bị che (cửa sổ khác đè lên, thu nhỏ): đứng yên, KHÔNG làm gì trên trang, chờ sự kiện
   * visibilitychange rồi mới đi tiếp. Trả về số ms đã chờ để bước đang chạy cộng vào hạn giờ của nó.
   */
  function waitWhileHidden(stopped) {
    if (!document.hidden) return Promise.resolve(0);
    const since = Date.now();
    onHiddenChange(true);
    return new Promise((resolve) => {
      const done = () => {
        if (document.hidden && !stopped()) return;
        document.removeEventListener("visibilitychange", done);
        clearInterval(watch);
        onHiddenChange(false);
        resolve(Date.now() - since);
      };
      document.addEventListener("visibilitychange", done);
      const watch = setInterval(done, 1000); // để nhận lệnh dừng trong lúc chờ
    });
  }

  /** Thăm dò tới khi `probe()` trả giá trị truthy; mỗi nhịp kiểm CAPTCHA/đăng xuất và lệnh dừng. */
  async function waitFor(label, probe, timeoutMs, stopped) {
    let deadline = Date.now() + timeoutMs;
    for (;;) {
      if (stopped()) throw new StepError("stopped");
      const reason = humanNeeded();
      if (reason) throw new HumanNeeded(reason);
      if (document.hidden) {
        deadline += await waitWhileHidden(stopped);
        continue;
      }
      const value = probe();
      if (value) return value;
      if (Date.now() >= deadline) throw new StepError(`timeout:${label}`);
      await sleep(POLL_MS);
    }
  }

  const allButtons = (scope = document) => [...scope.querySelectorAll("button")];
  const byLabel = (label, scope) => allButtons(scope).find((b) => b.getAttribute("aria-label") === label && visible(b));
  const byText = (text, scope) => allButtons(scope).find((b) => b.textContent.trim() === text && visible(b));

  // Mục trong menu ··· / Export. Đo 29/09 01:00: Suno đổi mục Download trang bài từ <button> sang
  // <div role="menuitem"> — nhận cả hai, theo aria-label hoặc chữ, để lần đổi sau không gãy cả lô.
  const MENU_ITEMS = 'button, [role="menuitem"]';
  const menuItems = (name) =>
    [...document.querySelectorAll(MENU_ITEMS)].filter((el) => el.getAttribute("aria-label") === name || el.textContent.trim() === name);
  const menuItem = (name) => menuItems(name).find(visible);

  /**
   * Mở menu kiểu Radix: menu ··· trang bài mở bằng `mousedown` (click/pointerdown không mở — đo
   * 27/09). Chưa thấy mục cần thì thử `click` đúng một lần (Studio từng "nuốt" cú bấm đầu).
   */
  async function openMenu(trigger, findItem, stopped) {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
    trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    try {
      return await waitFor("menu", findItem, 1500, stopped);
    } catch (error) {
      if (!(error instanceof StepError) || error.message !== "timeout:menu") throw error;
    }
    trigger.click();
    return waitFor("menu_retry", findItem, 2500, stopped);
  }

  /** Điền ô input/textarea do React quản: dùng setter gốc rồi phát `input` để React nhận onChange. */
  function setNativeValue(element, value) {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ── Studio: nạp ứng viên → Export → Full Song → "Song Saved!" ─────────────────────────────

  async function waitStudioReady(job, stopped) {
    // Studio hỏi Single/Multi-track khi mở từ menu Edit; Multi-track tốn 50 credit → chỉ nhận Single.
    const single = byText("Single-track");
    if (single) single.click();
    await waitFor(
      "studio_audio",
      () => L.studioAudioLoaded(performance.getEntriesByType("resource"), job.candidateId) && byLabel("Export menu"),
      110_000,
      stopped
    );
    await sleep(1500); // cho waveform vẽ nốt sau khi audio về
    return { step: "studio_ready" };
  }

  async function exportFullSong(job, stopped) {
    const trigger = await waitFor("export_button", () => byLabel("Export menu"), 10_000, stopped);
    const fullSong = await openMenu(trigger, () => menuItem("Full Song"), stopped);
    // Chỉ nhận link "Go to Song" XUẤT HIỆN SAU cú bấm này — không lấy nhầm toast/link có sẵn trên trang.
    const goToSong = () => [...document.querySelectorAll("a")].filter((a) => a.textContent.trim() === "Go to Song" && L.songIdFromHref(a.getAttribute("href")));
    const before = new Set(goToSong());
    fullSong.click();
    const link = await waitFor("song_saved", () => goToSong().find((a) => !before.has(a)), 170_000, stopped);
    return { step: "exported", exportId: L.songIdFromHref(link.getAttribute("href")) };
  }

  // ── Studio: Export → Multitrack (đo 28/09: tải ZIP ngay, không hộp thoại, 0 credit khi chưa tách stem) ──

  async function exportMultitrack(job, stopped) {
    const trigger = await waitFor("export_button", () => byLabel("Export menu"), 10_000, stopped);
    const item = await openMenu(trigger, () => menuItem("Multitrack"), stopped);
    item.click();
    return { step: "multitrack_started" };
  }

  // ── Tách stem (đo 01/10 trên bài thật): trang bài → ··· → Edit → Get Stems / MIDI → hộp "Extract Stems and MIDI" ──

  const STEMS_HEADING = "Extract Stems and MIDI";
  const PRIMARY = "hxc-btn-variant-primary"; // chế độ tách đang chọn (Auto split / Split from mix / Advanced split)
  // Tên làn stem Suno hiện (Auto split, 12 nhạc cụ). Chỉ để ghi lại; có stem hay chưa xét bằng nút Open in Studio.
  const STEM_NAME = /^(Lead Vocals?|Backing Vocals|Vocals|Bass|Guitar|Keyboards?|Percussion|Drums|Strings|Synth|Brass|Woodwinds|FX|Other)$/;
  const STEMS_SETTLE_MS = 3000; // danh sách stem vẽ ra sau khi API trả (đo 01/10: ~0,5 s); chờ thêm cho chắc

  function stemsDialog() {
    return [...document.querySelectorAll('[role="dialog"]')].find(
      (dialog) => visible(dialog) && [...dialog.querySelectorAll("h1, h2, h3")].some((h) => h.textContent.trim() === STEMS_HEADING)
    ) ?? null;
  }

  const openInStudio = (dialog) => byText("Open in Studio", dialog);
  const stemLabels = (dialog) =>
    [...new Set([...dialog.querySelectorAll("*")].filter((el) => el.children.length === 0 && STEM_NAME.test(el.textContent.trim())).map((el) => el.textContent.trim()))];
  // Làn đang tách hiện vòng xoay; xong thì mỗi làn có waveform (canvas).
  const stemsSettled = (dialog) => !dialog.querySelector('[class*="animate-spin"]') && dialog.querySelectorAll("canvas").length >= stemLabels(dialog).length;

  /** Hộp phải là của ĐÚNG bài: một dòng chữ trong hộp khớp chính xác tiêu đề. */
  function dialogOfSong(dialog, expectedTitle) {
    return String(dialog.innerText ?? dialog.textContent).split("\n").some((line) => L.titleMatches(line, expectedTitle));
  }

  /**
   * ··· → Edit (menu con mở bằng click) → mục "Get Stems / MIDI". Đo thật 01/10: menu ··· có lúc mở chậm, cú click dự phòng
   * của openMenu đóng nó lại và "Edit" bấm vào menu đang đóng → không có menu con. Thử lại cả chuỗi một lần sau Escape.
   */
  async function openGetStemsItem(more, stopped) {
    const editItem = () => [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim() === "Edit" && el.getAttribute("aria-haspopup") === "menu" && visible(el));
    const stemsItem = () => [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim().startsWith("Get Stems / MIDI") && visible(el));
    for (let attempt = 1; ; attempt += 1) {
      try {
        const edit = await openMenu(more, editItem, stopped);
        edit.click();
        return await waitFor("get_stems_item", stemsItem, 4000, stopped);
      } catch (error) {
        if (attempt >= 2 || !(error instanceof StepError) || error.message === "stopped") throw error;
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(800);
      }
    }
  }

  let stemsDialogOpenedAt = Infinity;
  /** Trạng thái danh sách stem chỉ từ các request bắt đầu sau khi mở hộp tách lần này. */
  function stemsListNow(job) {
    const fresh = performance.getEntriesByType("resource").filter((entry) => entry.startTime >= stemsDialogOpenedAt);
    return L.stemsListState(fresh, job.candidateId);
  }

  async function openStemsDialog(job, stopped) {
    if (location.pathname !== `/song/${job.candidateId}`) throw new StepError("wrong_page");
    const more = await waitFor("more_options", () => headerMoreButton(job.expectedTitle), 30_000, stopped);
    const getStems = await openGetStemsItem(more, stopped);
    // Chỉ tin request của LẦN MỞ HỘP NÀY: xoá dòng thời gian cũ (lần xem trước, lượt dry-run) và nới bộ đệm để
    // `/stems?page=` không bao giờ bị rơi mất vì đầy.
    performance.setResourceTimingBufferSize(2000);
    performance.clearResourceTimings();
    stemsDialogOpenedAt = performance.now();
    getStems.click();
    const dialog = await waitFor("stems_dialog", stemsDialog, 15_000, stopped);
    if (!dialogOfSong(dialog, job.expectedTitle)) throw new StepError("stems_dialog_title");
    // Có stem = Suno tải trang stem (`/stems?page=`) hoặc đã thấy nút Open in Studio. Chưa có = `/stems/pages` trả 200,
    // KHÔNG có trang stem nào, và sau STEMS_SETTLE_MS vẫn vậy. Không chứng minh được bên nào → hết giờ, KHÔNG bấm gì
    // (thà dừng còn hơn tách lần hai mất 50 credit). Đo thật 01/10: danh sách bài đã tách có lúc vẽ chậm hơn 3 s.
    // Tên làn chỉ để ghi lại: Suno có thể đặt tên làn mới.
    const listState = () => stemsListNow(job);
    let emptySince = null;
    await waitFor("stems_list", () => {
      if (openInStudio(dialog)) return true;
      if (listState() !== "empty") {
        emptySince = null;
        return false; // "has_pages": chờ nút hiện ra; "unknown": chờ Suno trả lời
      }
      emptySince ??= Date.now();
      return Date.now() - emptySince >= STEMS_SETTLE_MS;
    }, 30_000, stopped);
    const hasStems = Boolean(openInStudio(dialog));
    if (!hasStems && listState() !== "empty") throw new StepError("stems_list_unclear");
    return { step: "stems_dialog", hasStems, stems: hasStems ? stemLabels(dialog) : [] };
  }

  /** Bấm Extract (Auto split, 50 credit) rồi chờ Suno tách xong. Chỉ chạy khi hộp chắc chắn chưa có stem. */
  async function extractStems(job, stopped) {
    const dialog = stemsDialog();
    if (!dialog || !dialogOfSong(dialog, job.expectedTitle)) throw new StepError("stems_dialog_gone");
    if (openInStudio(dialog)) throw new StepError("stems_already_listed"); // stem vừa hiện ra: không bấm, dừng job (chạy lại sẽ thấy stem và chỉ tải)
    const auto = byText("Auto split", dialog);
    if (!auto) throw new StepError("auto_split");
    if (!auto.classList.contains(PRIMARY)) {
      auto.click();
      await waitFor("auto_split_selected", () => auto.classList.contains(PRIMARY), 3000, stopped);
    }
    const extract = byText("Extract", dialog);
    if (!extract || extract.disabled) throw new StepError("extract_disabled");
    // Chốt cuối ngay trước cú bấm tốn credit: Suno vẫn chưa tải trang stem nào của bài này.
    if (stemsListNow(job) !== "empty" || openInStudio(dialog)) {
      throw new StepError("stems_list_unclear");
    }
    extract.click();
    await waitFor("stems_ready", () => openInStudio(dialog) && stemsSettled(dialog), 300_000, stopped);
    await sleep(STEMS_SETTLE_MS); // làn rỗng (vd vocal của bài không lời) tự biến mất ngay sau khi tách xong
    return { step: "stems_ready", hasStems: true, stems: stemLabels(dialog) };
  }

  /** Open in Studio TẢI LẠI cả trang (đo 01/10): báo trước, bấm sau — background chờ trang mới nạp xong. */
  async function openStemsStudio(job, stopped) {
    const dialog = stemsDialog();
    const button = dialog && openInStudio(dialog);
    if (!button) throw new StepError("open_in_studio");
    if (stopped()) throw new StepError("stopped");
    setTimeout(() => {
      if (!stopped()) button.click();
    }, 300);
    return { step: "studio_opening" };
  }

  /**
   * Studio project của bài đã tách: nút Export + audio bản gốc + audio đủ số stem hộp tách đã liệt kê. Làn rỗng có thể
   * biến mất ngay sau khi tách (đo 01/10: 11 làn → 8 stem), nên số stem đã nạp đứng yên STUDIO_STEMS_STABLE_MS cũng đủ.
   */
  const STUDIO_STEMS_STABLE_MS = 5000;
  async function waitStemsStudio(job, stopped) {
    const want = Math.max(1, Number(job.stemCount) || 0);
    let seen = 0;
    let since = Date.now();
    await waitFor(
      "studio_stems_audio",
      () => {
        const entries = performance.getEntriesByType("resource");
        if (!byLabel("Export menu") || !L.studioAudioLoaded(entries, job.candidateId)) return false;
        const loaded = L.studioStemClipsLoaded(entries, job.candidateId);
        if (loaded !== seen) [seen, since] = [loaded, Date.now()];
        return loaded >= want || (loaded > 0 && Date.now() - since >= STUDIO_STEMS_STABLE_MS);
      },
      110_000,
      stopped
    );
    await sleep(1500); // cho waveform vẽ nốt sau khi audio về
    return { step: "studio_ready" };
  }

  // ── Trang bài bản export: ··· → Download → chỉ WAV → Download ────────────────────────────

  /** Ô tiêu đề của bài (input). Trang còn nhiều bài khác ở cột phải — đi từ tiêu đề mới đúng bài. */
  function titleInput(expectedTitle) {
    return [...document.querySelectorAll("input")].find((input) => visible(input) && L.titleMatches(input.value, expectedTitle));
  }

  /** Nút ··· của CHÍNH bài: tổ tiên gần nhất của ô tiêu đề có chứa nút "More options". */
  function headerMoreButton(expectedTitle) {
    let node = titleInput(expectedTitle);
    while (node && !node.querySelector?.('button[aria-label="More options"]')) node = node.parentElement;
    return node ? node.querySelector('button[aria-label="More options"]') : null;
  }

  /** Chỉ làm việc trên ĐÚNG trang của bản export (tiêu đề có thể trùng với take cũ cùng slot). */
  function onExportPage(job) {
    if (job.exportId && location.pathname !== `/song/${job.exportId}`) throw new StepError("wrong_page");
  }

  async function waitSongReady(job, stopped) {
    onExportPage(job);
    await waitFor("song_page", () => headerMoreButton(job.expectedTitle), 60_000, stopped);
    return { step: "song_ready" };
  }

  function downloadDialog() {
    const wav = byText("WAV");
    return wav?.closest('[role="dialog"]') ?? null;
  }

  const selectedFormats = (dialog) => L.FORMATS.filter((name) => byText(name, dialog)?.querySelector("svg"));

  async function downloadWav(job, stopped) {
    onExportPage(job);
    const more = await waitFor("more_options", () => headerMoreButton(job.expectedTitle), 20_000, stopped);
    const before = new Set(menuItems("Download"));
    const item = await openMenu(more, () => menuItems("Download").find((el) => !before.has(el) && visible(el)), stopped);
    item.click();
    const dialog = await waitFor("download_dialog", downloadDialog, 15_000, stopped);
    // "You've unlocked this song" = bản export đã mở khoá, tải không trừ hạn mức. Không thấy → dừng.
    if (!/unlocked this song/i.test(dialog.textContent)) throw new HumanNeeded("quota_prompt");
    for (const name of L.formatsToToggle(selectedFormats(dialog))) {
      byText(name, dialog)?.click();
      await sleep(300);
    }
    const chosen = selectedFormats(dialog);
    if (chosen.length !== 1 || chosen[0] !== "WAV") throw new StepError(`formats:${chosen.join("+") || "none"}`);
    const submit = allButtons(dialog).find((b) => b.textContent.trim() === "Download" && visible(b));
    if (!submit) throw new StepError("download_button");
    submit.click();
    await waitFor("preparing", () => /Preparing/i.test(dialog.textContent) || !dialog.isConnected, 15_000, stopped);
    return { step: "download_started" };
  }

  // ── Create (tab Advanced): điền theo packet, đọc lại, rồi mới bấm Create ─────────────────

  /** Nút của một hàng (Max Mode, Duration, …): tổ tiên gần nhất của nhãn có chứa một trong các nút. */
  /**
   * Khung form Create: tổ tiên gần nhất của nút "Create song" có chứa ô Styles. Đo 27/09: khung này
   * chứa mọi hàng cần dùng và KHÔNG chứa danh sách bài của workspace — tìm nhãn trong khung, không
   * tìm cả trang (tránh trùng chữ ở chỗ khác).
   */
  function formRoot() {
    const create = byLabel("Create song");
    const styles = [...document.querySelectorAll('textarea[maxlength="1000"]')].find(visible);
    let node = create;
    while (node && styles && !node.contains(styles)) node = node.parentElement;
    return node && styles ? node : null;
  }

  function rowButtons(label, names) {
    const root = formRoot();
    if (!root) return [];
    const labelEl = [...root.querySelectorAll("div, span, label, p")].find((el) => el.textContent.trim() === label && el.children.length <= 1 && visible(el));
    let node = labelEl;
    while (node && node !== root.parentElement && !allButtons(node).some((b) => names.includes(b.textContent.trim()))) node = node.parentElement;
    return node && root.contains(node) ? allButtons(node).filter((b) => names.includes(b.textContent.trim()) && visible(b)) : [];
  }

  function selectedIn(label, names) {
    const chosen = rowButtons(label, names).filter((b) => b.classList.contains(SELECTED));
    return chosen.length === 1 ? chosen[0].textContent.trim() : null;
  }

  const inForm = (selector) => [...(formRoot()?.querySelectorAll(selector) ?? [])].find(visible);
  const slider = (label) => [...(formRoot()?.querySelectorAll('[role="slider"]') ?? [])].find((s) => s.getAttribute("aria-label") === label && visible(s));
  const stylesBox = () => [...document.querySelectorAll('textarea[maxlength="1000"]')].find(visible);
  const excludeBox = () => inForm('input[placeholder="Exclude styles"]');
  const songTitleBox = () => inForm('input[placeholder="Song Title (Optional)"]');
  const lyricsBox = () => inForm('[aria-label="Lyrics editor"]');

  function readForm() {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => t.getAttribute("aria-selected") === "true");
    const model = allButtons().find((b) => b.getAttribute("aria-haspopup") === "menu" && /^v\d/.test(b.textContent.trim()) && visible(b));
    const number = (label) => {
      const value = Number(slider(label)?.getAttribute("aria-valuenow"));
      return slider(label) && Number.isFinite(value) ? value : null;
    };
    const gender = selectedIn("Vocal Gender", ["Male", "Female"]);
    return {
      model: model?.textContent.trim() ?? null,
      tab: tab?.textContent.trim().toLowerCase() ?? null,
      title: songTitleBox()?.value ?? null,
      lyrics_empty: (lyricsBox()?.textContent ?? "x").trim() === "",
      styles: stylesBox()?.value ?? null,
      exclude: excludeBox()?.value ?? null,
      duration_seconds: slider("Duration") ? number("Duration") : null,
      max_mode: selectedIn("Max Mode", ["Off", "On"]) === "On",
      weirdness: number("Weirdness"),
      style_influence: number("Style Influence"),
      variety: number("Variety"),
      vocal_gender: gender ? gender.toLowerCase() : null,
      my_taste: selectedIn("Personalize", ["Off", "On"]) === "On"
    };
  }

  async function setSlider(label, target, stopped) {
    const element = await waitFor(`slider:${label}`, () => slider(label), 5000, stopped);
    const read = () => Number(element.getAttribute("aria-valuenow"));
    const presses = L.sliderPresses(read(), target, L.SLIDER_STEP[label], Number(element.getAttribute("aria-valuemin")), Number(element.getAttribute("aria-valuemax")));
    if (presses === null) throw new StepError(`slider_target:${label}`);
    element.focus();
    const key = presses > 0 ? "ArrowRight" : "ArrowLeft";
    for (let i = 0; i < Math.abs(presses); i += 1) {
      element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await sleep(40);
    }
    await waitFor(`slider_value:${label}`, () => read() === target, 3000, stopped);
  }

  async function chooseInRow(label, names, wanted, stopped) {
    if (selectedIn(label, names) === wanted) return;
    const button = rowButtons(label, names).find((b) => b.textContent.trim() === wanted);
    if (!button) throw new StepError(`row:${label}`);
    button.click();
    await waitFor(`row_value:${label}`, () => selectedIn(label, names) === wanted, 3000, stopped);
  }

  async function ensureMoreOptions(stopped) {
    if (excludeBox()) return;
    const header = [...(formRoot()?.querySelectorAll("button, div[role='button']") ?? [])].find((el) => el.textContent.trim() === "More Options" && visible(el));
    if (!header) throw new StepError("more_options");
    header.click();
    await waitFor("more_options_open", excludeBox, 3000, stopped);
  }

  async function fillCreateForm(job, stopped) {
    const packet = job.packet;
    await waitFor("create_form", () => stylesBox() && byLabel("Create song"), 30_000, stopped);
    const advanced = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim().toLowerCase() === packet.tab);
    if (advanced && advanced.getAttribute("aria-selected") !== "true") {
      advanced.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      advanced.click();
      await waitFor("tab", () => advanced.getAttribute("aria-selected") === "true", 3000, stopped);
    }
    if (packet.lyrics === "" && !readForm().lyrics_empty) throw new StepError("lyrics_not_empty");
    setNativeValue(stylesBox(), packet.styles);
    await ensureMoreOptions(stopped);
    setNativeValue(excludeBox(), packet.exclude);
    if (packet.vocalGender === null && selectedIn("Vocal Gender", ["Male", "Female"])) throw new StepError("vocal_gender_selected");
    if (packet.durationSeconds === null) {
      if (slider("Duration")) throw new StepError("duration_custom_set");
    } else {
      if (!slider("Duration")) {
        // Bấm Custom thì hàng Custom/Auto biến thành thước trượt — chờ thước trượt, không chờ nút.
        const custom = rowButtons("Duration", ["Custom", "Auto"]).find((b) => b.textContent.trim() === "Custom");
        if (!custom) throw new StepError("row:Duration");
        custom.click();
        await waitFor("duration_slider", () => slider("Duration"), 3000, stopped);
      }
      await setSlider("Duration", packet.durationSeconds, stopped);
    }
    await chooseInRow("Max Mode", ["Off", "On"], packet.maxMode ? "On" : "Off", stopped);
    await setSlider("Weirdness", packet.weirdness, stopped);
    await setSlider("Style Influence", packet.styleInfluence, stopped);
    await setSlider("Variety", packet.variety, stopped);
    await chooseInRow("Personalize", ["Off", "On"], packet.myTaste ? "On" : "Off", stopped);
    setNativeValue(songTitleBox(), packet.title);
    await sleep(300);
    const observed = readForm();
    return { step: "form_ready", observed: L.panelRecord(observed), mismatches: L.formMismatches(observed, packet) };
  }

  /** Id + tiêu đề các bài trong danh sách workspace (cột phải của trang Create). */
  function listedSongs() {
    return [...document.querySelectorAll('a[href^="/song/"]')]
      .map((a) => ({ id: L.songIdFromHref(a.getAttribute("href")), title: a.textContent.trim() }))
      .filter((song) => song.id);
  }

  async function submitCreate(job, stopped) {
    const packet = job.packet;
    const mismatches = L.formMismatches(readForm(), packet);
    if (mismatches.length) throw new StepError(`form_changed:${mismatches.join(",")}`);
    const create = byLabel("Create song");
    if (!create || create.disabled) throw new StepError("create_disabled");
    const before = listedSongs().map((song) => song.id);
    create.click();
    let deadline = Date.now() + 90_000;
    let ids = [];
    while (Date.now() < deadline) {
      const reason = humanNeeded();
      if (L.stopsAfterCreate(reason)) throw new HumanNeeded(reason);
      if (stopped()) break;
      if (document.hidden) deadline += await waitWhileHidden(stopped);
      const fresh = L.newSongIds(before, listedSongs().filter((song) => L.titleMatches(song.title, packet.title)).map((song) => song.id));
      ids = fresh;
      if (ids.length >= 2) break;
      await sleep(POLL_MS * 2);
    }
    // Không thấy bài mới không chứng minh Create chưa chạy (tab ẩn làm danh sách chậm cập nhật): tên lỗi nói đúng
    // điều đó, và cầu nối chặn gen lại slot này vì bước cuối là "submitting".
    if (!ids.length) throw new StepError("create_unconfirmed");
    return { step: "submitted", clipIds: ids };
  }

  root.JrSunoDrivers = Object.freeze({
    StepError,
    HumanNeeded,
    humanNeeded,
    pageHint,
    waitWhileHidden,
    setHiddenListener,
    menuItem,
    readForm,
    commands: Object.freeze({
      wait_studio_ready: waitStudioReady,
      export_full_song: exportFullSong,
      export_multitrack: exportMultitrack,
      open_stems_dialog: openStemsDialog,
      extract_stems: extractStems,
      open_stems_studio: openStemsStudio,
      wait_stems_studio: waitStemsStudio,
      wait_song_ready: waitSongReady,
      download_wav: downloadWav,
      fill_create_form: fillCreateForm,
      submit_create: submitCreate
    })
  });
})(globalThis);
