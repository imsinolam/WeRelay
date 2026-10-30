import { expect, test } from "bun:test";
import { CODEX_MOBILE_CSS, CODEX_MOBILE_HTML } from "../../src/daemon/codex-mobile-web.ts";

test("header menus and new-task icon share the larger glyph without resizing other controls", () => {
  expect(CODEX_MOBILE_CSS).toContain([
    ".menu-button svg,",
    ".task-board-menu-button svg,",
    ".settings-menu-button svg,",
    ".new-task-button svg { width: 28px; height: 28px; stroke-width: 1.8; }",
  ].join("\n"));
  expect(CODEX_MOBILE_CSS).toContain(".icon-button svg { width: 18px; height: 18px; }");
  expect(CODEX_MOBILE_CSS).toContain(".new-task-button { width: 34px; height: 34px;");
});

test("larger header icons preserve accessible button names and native SVG geometry", () => {
  for (const id of ["menu-button", "task-board-menu-button", "settings-menu-button", "new-task-button"]) {
    const button = CODEX_MOBILE_HTML.match(new RegExp(`<button[^>]*id="${id}"[\\s\\S]*?<\\/button>`))?.[0];
    expect(button).toContain('type="button"');
    expect(button).toContain(id === "new-task-button" ? 'aria-label="新建任务"' : 'aria-label="打开任务列表"');
    expect(button).toContain('viewBox="0 0 24 24" aria-hidden="true"');
  }
});
