import { expect, test } from "bun:test";
import { normalizeMobileMessageText } from "../../src/daemon/mobile-message-text.ts";
import { CODEX_MOBILE_JS } from "../../src/daemon/codex-mobile-web.ts";

test("browser and outbox share executable image-wrapper normalization", () => {
  const browser = new Function(`return (${normalizeMobileMessageText.toString()});`)() as typeof normalizeMobileMessageText;
  const wrapped = '<system-reminder><image_resize_notice>resized</image_resize_notice></system-reminder>\n图片：png1 png2\r\n请求正文\n<image name="[Image #1]" path="/tmp/input.png">\n[image]\n</image>';
  expect(normalizeMobileMessageText(wrapped, true)).toBe("请求正文");
  expect(browser(wrapped, true)).toBe(normalizeMobileMessageText(wrapped, true));
  expect(normalizeMobileMessageText("示例中的 [image] 不应消失", true)).toBe("示例中的 [image] 不应消失");
  expect(normalizeMobileMessageText("纯文字\n</image>")).toBe("纯文字\n</image>");
  expect(() => new Function(CODEX_MOBILE_JS)).not.toThrow();
});
