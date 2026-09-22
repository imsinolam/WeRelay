import { expect, test } from "bun:test";
import { CODEX_MOBILE_JS } from "../../src/daemon/codex-mobile-web.ts";

class Element {
  children: Element[] = [];
  className = "";
  textContent = "";
  appendChild(child: Element) { this.children.push(child); }
  setAttribute() {}
  addEventListener() {}
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
}

test("reasoning options have no English subtitle while permission explanations remain", () => {
  const start = CODEX_MOBILE_JS.indexOf("  function appendSessionMenuOption(");
  const end = CODEX_MOBILE_JS.indexOf("  function renderSessionControl(", start);
  const menu = new Element();
  const append = new Function("document", "composerSessionMenu", CODEX_MOBILE_JS.slice(start, end) + ";return appendSessionMenuOption;")({
    createElement: () => new Element(), createElementNS: () => new Element(),
  }, menu);
  append({ description: "Uses more reasoning tokens" }, { kind: "reasoning", label: "高", selected: true });
  append({ description: "项目外操作仍需确认" }, { kind: "permission", label: "项目内读写" });
  expect(menu.children[0]!.all().map(el => el.textContent).filter(Boolean)).toEqual(["高"]);
  expect(menu.children[1]!.all().map(el => el.textContent).filter(Boolean)).toEqual(["项目内读写", "项目外操作仍需确认"]);
});
