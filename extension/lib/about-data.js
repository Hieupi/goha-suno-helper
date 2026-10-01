// Dữ liệu tab "Giới thiệu": người làm extension, 2 đường nhận extension miễn phí, mời cafe, kênh kết nối.
// Nguồn: social-links.data.json trong bộ Social Links dùng chung của Nguyễn Hiếu AI.
// Module THUẦN, không đụng DOM — side panel vẽ (ui/about-panel.js), test kiểm mọi link (tests/about.test.mjs).
// Bản tặng cộng đồng chỉ giữ hotline, YouTube, Group Facebook và website (chủ kênh chọn 01/10).

export const ABOUT = Object.freeze({
  brand: {
    name: "NGUYỄN HIẾU AI",
    badge: "AI / MMO / Automation",
    description: "AI, MMO, automation và cộng đồng thực chiến.",
    phoneDisplay: "0981 228 229",
    phoneHref: "tel:0981228229",
    website: "https://nguyenhieuai.com/",
    websiteLabel: "nguyenhieuai.com"
  },
  // Extension tặng cộng đồng — 2 đường. Link để trống = chưa có, thẻ hiện "Sắp có" và không bấm được.
  gift: {
    title: "Nhận GOHA Suno Helper miễn phí",
    description: "Extension này được tặng cho cộng đồng. Chia sẻ cho bạn bè cùng làm nhạc với Suno nhé.",
    ways: [
      {
        id: "drive",
        title: "Tải bản dùng ngay",
        desc: "Google Drive — giải nén, nạp vào Chrome là chạy",
        href: "https://drive.google.com/drive/folders/1B1P6N31hwHpsXf9rft6C5vbH_WaaoVYf?usp=drive_link",
        icon: "i-down"
      },
      {
        id: "github",
        title: "Mã nguồn trên GitHub",
        desc: "Tặng repo 1 ⭐ để mình có động lực làm tiếp",
        href: "https://github.com/Hieupi/goha-suno-helper",
        icon: "i-star"
      }
    ]
  },
  donate: {
    title: "Mời Nguyễn Hiếu 1 ly cafe",
    description: "Ủng hộ duy trì hệ thống và Website",
    bankName: "Vietinbank",
    bankShort: "VTB",
    accountNumber: "60048899",
    accountHolder: "NGUYEN VAN HIEU",
    transferNote: "SEVQR + lời nhắn",
    qrImage: "qr-vietinbank.png"
  },
  sections: [
    {
      id: "direct-contact",
      title: "Liên hệ trực tiếp",
      items: [{ id: "hotline", title: "Hotline công việc", desc: "Gọi ngay để được tư vấn", href: "tel:0981228229", variant: "phone", mark: "☎" }]
    },
    {
      id: "channels",
      title: "Kênh & Cộng đồng",
      items: [
        { id: "youtube-channel", title: "YouTube - Nông Dân AI", desc: "Video hướng dẫn và tips AI", href: "https://www.youtube.com/@NongDanAI99", variant: "youtube", mark: "▶" },
        { id: "community-mmo-ai", title: "Nông Dân Học AI Kiếm Tiền", desc: "Group Facebook học AI thực chiến, prompt, automation, affiliate và kiếm tiền", href: "https://www.facebook.com/share/g/1Lbczu1WqB/", variant: "community", mark: "G" },
        { id: "website-main", title: "Website chính", desc: "nguyenhieuai.com", href: "https://nguyenhieuai.com/", variant: "website", mark: "W" }
      ]
    }
  ]
});

const SAFE_LINK = /^(https:\/\/[^\s"'<>]+|tel:\+?\d{6,15})$/;

/** Link được phép mở từ side panel: https hoặc tel. Rỗng = chưa có (thẻ hiện mờ, không bấm được). */
export function linkOf(href) {
  return typeof href === "string" && SAFE_LINK.test(href) ? href : null;
}

/** Mọi link trong dữ liệu Giới thiệu (để test kiểm một chỗ). */
export function allLinks(about = ABOUT) {
  return [
    about.brand.phoneHref,
    about.brand.website,
    ...about.gift.ways.map((way) => way.href),
    ...about.sections.flatMap((section) => section.items.map((item) => item.href))
  ];
}
