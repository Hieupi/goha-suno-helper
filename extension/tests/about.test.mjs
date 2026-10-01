import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { ABOUT, allLinks, linkOf } from "../lib/about-data.js";

// Tab Giới thiệu: dữ liệu lấy từ bộ Social Links của Nguyễn Hiếu AI; side panel chỉ mở link https hoặc tel.

test("mọi link có trong dữ liệu đều là https hoặc tel; link rỗng nghĩa là chưa có", () => {
  for (const href of allLinks()) {
    if (href === "") continue;
    assert.ok(linkOf(href), `link không hợp lệ: ${href}`);
  }
});

test("link lạ không bao giờ được mở: javascript:, http thường, data:, có dấu nháy", () => {
  for (const bad of ["javascript:alert(1)", "http://gohaaff.click/", "data:text/html,x", 'https://x.y/"onmouseover=', "#", "", null]) {
    assert.equal(linkOf(bad), null, String(bad));
  }
  assert.equal(linkOf("tel:0981228229"), "tel:0981228229");
});

test("hai đường nhận extension: Drive (dùng luôn) và GitHub (xin sao)", () => {
  assert.deepEqual(ABOUT.gift.ways.map((way) => way.id), ["drive", "github"]);
});

test("mời cafe: đúng tài khoản Vietinbank trong bộ Social Links, ảnh QR có trong extension", () => {
  assert.deepEqual([ABOUT.donate.bankName, ABOUT.donate.accountNumber, ABOUT.donate.accountHolder], ["Vietinbank", "60048899", "NGUYEN VAN HIEU"]);
  assert.ok(existsSync(new URL(`../ui/about/${ABOUT.donate.qrImage}`, import.meta.url)));
  assert.ok(existsSync(new URL("../ui/about/avatar.png", import.meta.url)));
});

test("bản tặng cộng đồng: website nguyenhieuai.com, chỉ hotline + YouTube + Group Facebook + website; không khoá học", () => {
  assert.equal(ABOUT.brand.website, "https://nguyenhieuai.com/");
  assert.deepEqual(ABOUT.sections.flatMap((s) => s.items.map((item) => item.id)), ["hotline", "youtube-channel", "community-mmo-ai", "website-main"]);
  assert.equal("course" in ABOUT, false);
});

test("thẻ Drive mở đúng thư mục chia sẻ của chủ kênh", () => {
  const drive = ABOUT.gift.ways.find((way) => way.id === "drive");
  assert.equal(linkOf(drive.href), "https://drive.google.com/drive/folders/1B1P6N31hwHpsXf9rft6C5vbH_WaaoVYf?usp=drive_link");
});

test("thẻ GitHub mở repo Hieupi/goha-suno-helper", () => {
  assert.equal(linkOf(ABOUT.gift.ways.find((way) => way.id === "github").href), "https://github.com/Hieupi/goha-suno-helper");
});
