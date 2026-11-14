import { CHAT_COMPONENTS_JS } from "../../../src/web/chat-components/index.ts";

export function chatUI() {
  return new Function(CHAT_COMPONENTS_JS + ";return WeRelayChatUI;")();
}

export class ChatElement {
  children: ChatElement[] = [];
  className = "";
  textContent = "";
  hidden = false;
  disabled = false;
  value = "";
  title = "";
  id = "";
  style: Record<string, string>;
  styleHistory: Record<string, string>[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners = new Map<string, Set<(event: any) => void>>();
  ownerDocument: any;
  offsetHeight = 100;
  contentHeight = 30;
  scrollTop = 0;
  selectionStart = 0;
  selectionEnd = 0;
  isConnected = true;
  html = "";
  classList = {
    add: (name: string) => { if (!this.classList.contains(name)) this.className += " " + name; },
    contains: (name: string) => this.className.split(" ").includes(name),
    toggle: (name: string, enabled: boolean) => {
      this.className = this.className.split(" ").filter(item => item !== name).join(" ");
      if (enabled) this.classList.add(name);
    },
  };
  set innerHTML(value: string) { this.html = value; this.children = []; }
  get innerHTML() { return this.html; }
  appendChild(child: ChatElement) { this.children.push(child); return child; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  getAttribute(key: string) { return this.attributes[key]; }
  toggleAttribute(key: string, enabled: boolean) { if (enabled) this.attributes[key] = ""; else delete this.attributes[key]; }
  addEventListener(name: string, fn: (event: any) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }
  removeEventListener(name: string, fn: (event: any) => void) { this.listeners.get(name)?.delete(fn); }
  emit(name: string, event: any = {}) {
    event.preventDefault ||= () => { event.defaultPrevented = true; };
    this.listeners.get(name)?.forEach(fn => fn(event));
  }
  contains(child: ChatElement) { return this.all().includes(child); }
  querySelector(_selector: string): ChatElement | null { return null; }
  querySelectorAll(_selector: string): ChatElement[] { return []; }
  getClientRects() { return [{}]; }
  remove() { this.isConnected = false; }
  get clientHeight() {
    const height = Number.parseFloat(this.style.height);
    return Number.isFinite(height) ? height : this.offsetHeight;
  }
  get computedHeight() {
    const height = Number.parseFloat(this.style.height);
    return Number.isFinite(height) ? this.style.height : "auto";
  }
  get scrollHeight() {
    return this.contentHeight;
  }
  set scrollHeight(value: number) {
    this.contentHeight = value;
  }
  all(): ChatElement[] { return [this, ...this.children.flatMap(child => child.all())]; }
  requestSubmit() { this.emit("submit"); }

  constructor() {
    this.style = new Proxy({}, {
      set: (target, key, value) => {
        target[String(key)] = String(value);
        this.styleHistory.push({ [String(key)]: String(value) });
        return true;
      },
      deleteProperty: (target, key) => {
        delete target[String(key)];
        this.styleHistory.push({ [String(key)]: "" });
        return true;
      },
    });
  }
}

export function composerHarness(actions: Record<string, unknown> = {}, nativeSizing = false) {
  const document = new ChatElement();
  const frames = new Map<number, () => void>();
  const measurements: string[] = [];
  let frameId = 0;
  const window = {
    CSS: { supports: () => nativeSizing },
    performance: { now: () => 0 },
    matchMedia: () => ({ matches: true }),
    getComputedStyle: (element: ChatElement | null) => {
      const result = {
        boxSizing: "border-box", width: "360px", lineHeight: "24px", paddingTop: "6px", paddingBottom: "6px",
        borderTopWidth: "0px", borderBottomWidth: "0px", minHeight: "36px", maxHeight: "164px",
        height: element?.computedHeight || "auto",
      };
      if (element) measurements.push(result.height);
      return result;
    },
    requestAnimationFrame: (fn: () => void) => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  };
  const doc = Object.assign(document, {
    defaultView: window,
    createElement: (tag: string) => {
      const element = new ChatElement();
      if (tag === "textarea") Object.defineProperty(element, "scrollHeight", { get: () => parts.get('[data-chat-part="composer-input"]')?.contentHeight || 36 });
      return element;
    }, createElementNS: () => new ChatElement(),
  });
  const root = new ChatElement();
  root.ownerDocument = doc;
  const parts = new Map<string, ChatElement>();
  root.querySelector = (selector: string) => {
    if (!parts.has(selector)) parts.set(selector, new ChatElement());
    return parts.get(selector)!;
  };
  const view = chatUI().createComposer(root, { actions });
  return { view, root, document: doc, frames, measurements, part: (name: string): ChatElement => view.part(name) };
}
