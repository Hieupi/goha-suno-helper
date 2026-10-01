// Da giao diện Neon ⇄ Cổ điển (+ Sáng/Tối cho Cổ điển) — theo mẫu Goha Flow `extension/skin.js`.
// Script thường (không module), nạp trong <head>: đọc localStorage ĐỒNG BỘ và đặt data-skin/data-theme
// trước khi trang vẽ ⇒ không chớp da. chrome.storage.local là bản chính (đồng bộ side panel ⇄ trang cài đặt).
(() => {
  "use strict";
  const SKINS = ["neon", "classic"];
  const THEMES = ["system", "light", "dark"];
  const root = document.documentElement;

  function read(key, allowed, fallback) {
    try {
      const value = localStorage.getItem(key);
      return allowed.includes(value) ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function resolvedTheme(theme) {
    if (theme !== "system") return theme;
    return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  function paint(skin, theme) {
    root.dataset.skin = SKINS.includes(skin) ? skin : "neon";
    root.dataset.theme = resolvedTheme(THEMES.includes(theme) ? theme : "system");
    root.dataset.themeChoice = THEMES.includes(theme) ? theme : "system";
  }

  paint(read("jrSkin", SKINS, "neon"), read("jrTheme", THEMES, "system"));

  function set({ skin, theme }) {
    const nextSkin = SKINS.includes(skin) ? skin : root.dataset.skin;
    const nextTheme = THEMES.includes(theme) ? theme : root.dataset.themeChoice;
    try {
      localStorage.setItem("jrSkin", nextSkin);
      localStorage.setItem("jrTheme", nextTheme);
    } catch {
      /* localStorage bị chặn: vẫn lưu ở chrome.storage */
    }
    paint(nextSkin, nextTheme);
    chrome.storage?.local.set({ uiSkin: nextSkin, uiTheme: nextTheme });
    document.dispatchEvent(new CustomEvent("jr:skin", { detail: { skin: nextSkin, theme: nextTheme } }));
  }

  // Bản chính có thể khác bản đệm (đổi ở trang khác): vẽ lại cho khớp.
  chrome.storage?.local.get(["uiSkin", "uiTheme"]).then(({ uiSkin, uiTheme }) => {
    if ((uiSkin && uiSkin !== root.dataset.skin) || (uiTheme && uiTheme !== root.dataset.themeChoice)) {
      set({ skin: uiSkin ?? root.dataset.skin, theme: uiTheme ?? root.dataset.themeChoice });
    }
  });
  chrome.storage?.onChanged.addListener((changes, area) => {
    if (area !== "local" || (!changes.uiSkin && !changes.uiTheme)) return;
    const skin = changes.uiSkin?.newValue ?? root.dataset.skin;
    const theme = changes.uiTheme?.newValue ?? root.dataset.themeChoice;
    if (skin !== root.dataset.skin || theme !== root.dataset.themeChoice) paint(skin, theme);
    document.dispatchEvent(new CustomEvent("jr:skin", { detail: { skin, theme } }));
  });
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => paint(root.dataset.skin, root.dataset.themeChoice));

  window.jrSkin = { set, get: () => ({ skin: root.dataset.skin, theme: root.dataset.themeChoice }) };
})();
