import { describe, expect, test } from "bun:test";
import { CODEX_MOBILE_APP_JS, CODEX_MOBILE_HTML, CODEX_MOBILE_CSS } from "../../src/daemon/codex-mobile-web.ts";
import { AGENT_BRAND_ICON_DATA } from "../../src/daemon/agent-brand-icons.ts";
import { ChatElement } from "./helpers/chat-components.ts";

class StripElement extends ChatElement {
  parent: StripElement | null = null;
  scrollLeft = 0;
  clientWidth = 206;
  scrollWidth = 276;
  offsetLeft = 0;
  offsetWidth = 66;
  focused = false;
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  insertBefore(child: StripElement, before: StripElement | null) {
    child.remove();
    child.parent = this;
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child);
    this.children.forEach((node, index) => { (node as StripElement).offsetLeft = index * 70; });
  }
  querySelector(selector: string): StripElement | null {
    return this.all().slice(1).find(node => node.classList.contains(selector.slice(1))) as StripElement || null;
  }
  focus() { this.focused = true; }
}

function stripHarness() {
  const state = {
    adapters: [
      { id: "codex", label: "Codex", status: "busy" },
      { id: "claude", label: "Claude Code", status: "idle" },
      { id: "deepseek", label: "DeepSeek Harness", status: "awaiting_approval" },
      { id: "pi", label: "Pi", status: "idle" },
    ],
    currentAdapter: "codex", switchingAdapter: false, switchingAdapterId: "", switchingFromAdapterId: "", creatingTask: false,
  };
  const adapterMenu = new StripElement();
  const document = { activeElement: null as StripElement | null, createElement: () => new StripElement() };
  const switched: string[] = [];
  const frames: Array<() => void> = [];
  const start = CODEX_MOBILE_APP_JS.indexOf("  function renderAdapterMenu()");
  const end = CODEX_MOBILE_APP_JS.indexOf("\n  async function loadAdapters()", start);
  const render = new Function("state", "adapterMenu", "document", "AGENT_BRAND_ICON_DATA", "activeAdapterLabel",
    "workspaceSwitcher", "workspaceSwitchProgress", "updateActiveDocumentTitle", "switchingAdapterName", "currentAdapterName",
    "adapterStateLabel", "switchAdapter", "requestAnimationFrame",
    `${CODEX_MOBILE_APP_JS.slice(start, end)}; return renderAdapterMenu;`)(
    state, adapterMenu, document, AGENT_BRAND_ICON_DATA, {}, { classList: { remove() {} }, setAttribute() {} }, {},
    () => {}, () => "Pi", () => "Codex", (status: string) => status === "awaiting_approval" ? "待审批" : "",
    (id: string) => switched.push(id), (fn: () => void) => frames.push(fn),
  );
  return { state, adapterMenu, document, switched, frames, render };
}

describe("sidebar Agent icon choices", () => {
  test("uses fixed compact choices and keeps only the brand in the sidebar header", () => {
    expect(CODEX_MOBILE_CSS).toContain("flex: 0 0 44px");
    expect(CODEX_MOBILE_CSS).not.toContain("/ 3.5");
    const header = CODEX_MOBILE_HTML.slice(CODEX_MOBILE_HTML.indexOf('<div class="sidebar-head">'), CODEX_MOBILE_HTML.indexOf('<nav class="sidebar-primary-nav"'));
    expect(header).toContain('class="sidebar-brand brand-logo"');
    expect(header).not.toContain("workspace-switcher");
    expect(header).not.toContain("active-adapter-label");
    expect(CODEX_MOBILE_HTML).not.toContain('id="workspace-menu"');
    expect(CODEX_MOBILE_APP_JS).not.toContain("toggleWorkspaceMenu");
    expect(CODEX_MOBILE_HTML).toContain('class="settings-utilities"');
    expect(CODEX_MOBILE_HTML).toContain('id="auth-logout"');
  });

  test("uses icon-only choices with discoverable names and scroll overflow hints", () => {
    expect(CODEX_MOBILE_CSS).toContain(".adapter-menu.has-more");
    expect(CODEX_MOBILE_CSS).toContain("mask-image: linear-gradient(to right");
    const h = stripHarness(); h.render();
    expect(h.adapterMenu.classList.contains("has-more")).toBe(true);
    h.adapterMenu.scrollLeft = 70; h.render();
    expect(h.adapterMenu.classList.contains("has-more")).toBe(false);
    h.adapterMenu.scrollLeft = 0; h.adapterMenu.scrollWidth = 100; h.render();
    expect(h.adapterMenu.classList.contains("has-more")).toBe(false);
    expect(h.adapterMenu.children[2].querySelector(".adapter-menu-label")).toBeNull();
    expect(h.adapterMenu.children[2].attributes["aria-label"]).toBe("DeepSeek Harness · 待审批");
    expect(h.adapterMenu.children.every(button => button.children.length === 1)).toBe(true);
  });

  test("uses stable touch targets and neutral selection without recolouring brand marks", () => {
    const item = CODEX_MOBILE_CSS.match(/\.adapter-menu-item \{([^}]+)\}/)![1];
    expect(item).toContain("min-height: 44px");
    expect(CODEX_MOBILE_CSS).toContain("min-width: 44px");
    const active = CODEX_MOBILE_CSS.match(/\.adapter-menu-item\.is-active \{([^}]+)\}/)![1];
    expect(active).toContain("background: transparent");
    const marker = CODEX_MOBILE_CSS.match(/\.adapter-menu-item\.is-active::before \{([^}]+)\}/)![1];
    expect(marker).toContain("width: 14px");
    expect(marker).toContain("height: 2px");
    expect(marker).toContain("background: var(--muted-strong)");
    expect(active).not.toContain("green");
    expect(CODEX_MOBILE_CSS).not.toContain(".adapter-menu-item.is-active .adapter-menu-icon {");
    expect(CODEX_MOBILE_CSS).toContain(".adapter-menu-item:not(:disabled):hover");
    expect(CODEX_MOBILE_CSS).toContain(".adapter-menu-item:focus-visible");
    expect(CODEX_MOBILE_CSS).toContain(".adapter-menu-item:disabled:not(.is-switching)");
    expect(CODEX_MOBILE_CSS).toContain("prefers-reduced-motion: reduce");
  });

  test("preserves server order, brand logos, accessible names, busy state and existing switch action", () => {
    const h = stripHarness(); h.render();
    expect(h.adapterMenu.children.map(button => button.dataset.adapterId)).toEqual(["codex", "claude", "deepseek", "pi"]);
    expect(h.adapterMenu.children[0].attributes["aria-pressed"]).toBe("true");
    expect(h.adapterMenu.children[1].attributes["aria-pressed"]).toBe("false");
    const codex = h.adapterMenu.children[0] as StripElement;
    expect((codex.querySelector(".adapter-menu-icon")!.children[0] as unknown as { src: string }).src).toBe(AGENT_BRAND_ICON_DATA.codex);
    expect(codex.querySelector(".adapter-menu-running-dot")!.hidden).toBe(false);
    expect((h.adapterMenu.children[1] as StripElement).querySelector(".adapter-menu-running-dot")!.hidden).toBe(true);
    expect(h.adapterMenu.children[2].title).toBe("DeepSeek Harness · 待审批");
    h.adapterMenu.children[3].emit("click");
    expect(h.switched).toEqual(["pi"]);
  });

  test("polling keeps button identity, keyboard focus and user scroll position", () => {
    const h = stripHarness(); h.render(); h.frames.shift()!();
    const button = h.adapterMenu.children[1] as StripElement;
    h.document.activeElement = button;
    h.adapterMenu.scrollLeft = 74;
    h.render();
    expect(h.adapterMenu.children[1]).toBe(button);
    expect(h.document.activeElement).toBe(button);
    expect(h.adapterMenu.scrollLeft).toBe(74);
    expect(h.frames).toHaveLength(0);
    button.emit("click");
    expect(h.switched).toEqual(["claude"]);
  });

  test("reveals a newly selected Agent and disables choices during switch or task creation", () => {
    const h = stripHarness(); h.render(); h.frames.shift()!();
    h.state.currentAdapter = "pi";
    h.state.switchingAdapter = true;
    h.state.switchingAdapterId = "pi";
    h.render(); h.frames.shift()!();
    expect(h.adapterMenu.scrollLeft).toBe(70);
    expect(h.adapterMenu.children.every(button => button.disabled)).toBe(true);
    expect(h.adapterMenu.children[3].attributes["aria-busy"]).toBe("true");
    expect(h.adapterMenu.children[3].title).toBe("Pi · 当前 · 切换中");
    h.state.switchingAdapter = false;
    h.state.creatingTask = true;
    h.render();
    expect(h.adapterMenu.children.every(button => button.disabled)).toBe(true);
    h.state.creatingTask = false;
    h.state.adapters.reverse(); h.state.adapters.pop();
    h.render();
    expect(h.adapterMenu.children.map(button => button.dataset.adapterId)).toEqual(["pi", "deepseek", "claude"]);
    expect(h.adapterMenu.children.every(button => !button.disabled)).toBe(true);
  });

  test("keeps a short-named Agent visible when ordering changes or it sits at the end", () => {
    const h = stripHarness();
    h.render();
    h.frames.shift()!();
    h.state.adapters.push({ id: "workbuddy", label: "WorkBuddy", status: "idle" });
    h.state.currentAdapter = "workbuddy";
    h.adapterMenu.scrollWidth = 346;
    h.render();
    h.frames.shift()!();
    expect(h.adapterMenu.children.at(-1)!.dataset.adapterId).toBe("workbuddy");
    expect(h.adapterMenu.scrollLeft).toBe(140);
    h.adapterMenu.scrollLeft = 0;
    h.state.adapters = [h.state.adapters.at(-1)!, ...h.state.adapters.slice(0, -1)];
    h.render();
    expect(h.frames).toHaveLength(1);
    h.frames.shift()!();
    expect(h.adapterMenu.children[0].dataset.adapterId).toBe("workbuddy");
    expect(h.adapterMenu.scrollLeft).toBe(0);
  });
});

test("switching hides the running pulse, prevents duplicate actions and restores normal state after failure", () => {
  const h = stripHarness(); h.render();
  h.state.switchingAdapter = true; h.state.switchingAdapterId = "codex"; h.render();
  const codex = h.adapterMenu.children[0] as StripElement;
  expect(codex.attributes["aria-busy"]).toBe("true");
  expect(codex.querySelector(".adapter-menu-running-dot")!.hidden).toBe(true);
  codex.emit("click"); expect(h.switched).toEqual([]);
  h.state.switchingAdapter = false; h.state.switchingAdapterId = ""; h.render();
  expect(codex.attributes["aria-busy"]).toBe("false");
  expect(codex.disabled).toBe(false);
  expect(codex.querySelector(".adapter-menu-running-dot")!.hidden).toBe(false);
  codex.emit("click"); expect(h.switched).toEqual(["codex"]);
});

test("switching keeps the underline on the confirmed Agent until the switch succeeds", () => {
  const h = stripHarness(); h.render();
  h.state.switchingFromAdapterId = "codex";
  h.state.switchingAdapter = true;
  h.state.switchingAdapterId = "pi";
  h.state.currentAdapter = "pi"; // target content may be shown from cache optimistically
  h.render();
  expect(h.adapterMenu.children[0].attributes["aria-pressed"]).toBe("true");
  expect(h.adapterMenu.children[3].attributes["aria-pressed"]).toBe("false");
  expect(h.adapterMenu.children[3].attributes["aria-busy"]).toBe("true");
  h.state.switchingAdapter = false;
  h.state.switchingFromAdapterId = "";
  h.render();
  expect(h.adapterMenu.children[3].attributes["aria-pressed"]).toBe("true");
});
