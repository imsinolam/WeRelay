import { expect, test } from "bun:test";
import { composerHarness } from "./helpers/chat-components.ts";

test("reasoning options have no English subtitle while permission explanations remain", () => {
  const { view, part } = composerHarness();
  view.renderSession({ visible: true, open: true, canChange: true, label: "高 · 项目内读写", groups: [
    { kind: "reasoning", label: "推理强度", value: "high", options: [{ id: "high", label: "高", description: "Uses more reasoning tokens" }] },
    { kind: "permission", label: "访问权限", value: "write", options: [{ id: "write", label: "项目内读写", description: "项目外操作仍需确认" }] },
  ] });
  const strings = part("composer-session-menu").all().map(el => el.textContent).filter(Boolean);
  expect(strings).toEqual(["推理强度", "高", "访问权限", "项目内读写", "项目外操作仍需确认"]);
  view.destroy();
});
