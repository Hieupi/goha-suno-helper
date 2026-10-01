// Tab "Giới thiệu": người làm extension, 2 đường nhận extension miễn phí (Drive / GitHub), mời cafe (QR + STK)
// và kênh kết nối. Dữ liệu ở lib/about-data.js; ở đây chỉ dựng DOM bằng h() (không chèn HTML thô).
// Ảnh nằm trong extension (ui/about/), đường dẫn tính theo file này để trang xem trước dev cũng thấy ảnh.
import { h, icon } from "./dom.js";
import { ABOUT, linkOf } from "../lib/about-data.js";

const asset = (name) => new URL(`./about/${name}`, import.meta.url).href;

/** Thẻ link: mở tab mới (https) hoặc gọi (tel). Chưa có link → thẻ mờ kèm nhãn trạng thái, không bấm được. */
function linkCard({ title, desc, href, variant, mark, iconName, status }) {
  const url = linkOf(href);
  const badge = iconName ? icon(iconName, "i20") : h("span", { "aria-hidden": "true" }, mark);
  const body = [
    h("span", { class: `ab-ico ab-${variant}` }, badge),
    h("span", { class: "ab-txt" }, h("b", {}, title), h("span", {}, desc)),
    url ? h("span", { class: "ab-go", "aria-hidden": "true" }, "→") : h("span", { class: "ab-soon" }, status ?? "Sắp có")
  ];
  if (!url) return h("div", { class: "ab-card off", "aria-disabled": "true" }, body);
  const external = url.startsWith("https://");
  return h("a", { class: "ab-card", href: url, ...(external ? { target: "_blank", rel: "noopener noreferrer" } : {}) }, body);
}

function section(title, ...children) {
  return h("section", { class: "ab-sec" }, h("h3", { class: "ab-h" }, title), children);
}

function hero(brand) {
  return h("header", { class: "card ab-hero" },
    h("img", { class: "ab-avatar", src: asset("avatar.png"), alt: `Avatar ${brand.name}`, width: "88", height: "88" }),
    h("span", { class: "ab-badge" }, brand.badge),
    h("h2", { class: "ab-name" }, brand.name),
    h("p", { class: "ab-desc" }, brand.description),
    h("div", { class: "ab-pills" },
      h("a", { class: "ab-pill", href: linkOf(brand.phoneHref) }, brand.phoneDisplay),
      h("a", { class: "ab-pill", href: linkOf(brand.website), target: "_blank", rel: "noopener noreferrer" }, brand.websiteLabel)));
}

function gift(info) {
  return section(info.title,
    h("p", { class: "note" }, info.description),
    h("div", { class: "ab-grid" }, info.ways.map((way) => linkCard({ ...way, variant: way.id, iconName: way.icon }))));
}

function donate(info, copyText) {
  return section("Ủng hộ & Donate",
    h("div", { class: "card ab-donate" },
      h("div", { class: "ab-donate-head" }, icon("i-coffee", "i20"), h("div", {}, h("b", {}, info.title), h("span", { class: "meta" }, info.description))),
      h("figure", { class: "ab-qr" },
        h("img", { src: asset(info.qrImage), alt: `QR chuyển khoản ${info.bankName} ${info.accountHolder}`, width: "180", height: "180" }),
        h("figcaption", {}, `Quét QR ${info.bankName}`)),
      h("dl", { class: "ab-bank" },
        h("dt", {}, "Ngân hàng"), h("dd", {}, info.bankName),
        h("dt", {}, "Số tài khoản"), h("dd", { class: "ab-stk" }, info.accountNumber),
        h("dt", {}, "Chủ tài khoản"), h("dd", {}, info.accountHolder),
        h("dt", {}, "Nội dung CK"), h("dd", {}, info.transferNote)),
      h("button", { class: "btn primary lg", type: "button", onclick: () => copyText(info.accountNumber, `Đã copy số tài khoản ${info.bankName} ${info.accountNumber}.`) },
        icon("i-copy"), "Copy số tài khoản")));
}

/** Nội dung tab Giới thiệu. `copyText(text, doneMessage)` là hàm sao chép + toast của side panel. */
export function aboutView({ version, copyText }) {
  return [
    hero(ABOUT.brand),
    gift(ABOUT.gift),
    donate(ABOUT.donate, copyText),
    ABOUT.sections.map((group) => section(group.title, h("div", { class: "ab-grid" }, group.items.map(linkCard)))),
    h("p", { class: "note ab-foot" }, `GOHA Suno Helper ${version} · làm bởi ${ABOUT.brand.name} · tặng cộng đồng`)
  ];
}
