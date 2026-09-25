import assert from "node:assert/strict";

/** Prevent a false EN/AR visual pass when headless Chromium has no Arabic font.
 * Checking DOM text, direction or document.fonts.check() does NOT prove that
 * glyphs paint: some minimal serverless Fontconfig setups render nothing.
 * Sample the shop's actual Arabic body font stack on a transparent canvas.
 */
export async function assertRenderedArabicFont(page) {
  const ink = await page.evaluate(() => {
    const root = document.querySelector(".store-v2");
    if (!root || root.getAttribute("dir") !== "rtl") return 0;
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 80;
    const context = canvas.getContext("2d");
    if (!context) return 0;
    context.font = `32px ${getComputedStyle(root).fontFamily}`;
    context.fillStyle = "#000";
    context.fillText("مرحباً بالعالم", 4, 48);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 0) painted++;
    }
    return painted;
  });
  assert.ok(ink > 200,
    `Chromium painted only ${ink} Arabic pixels: check the browser's installed fonts/Fontconfig before trusting RTL screenshots`);
}
