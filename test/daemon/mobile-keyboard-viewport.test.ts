import { expect, test } from "bun:test";
import { CODEX_MOBILE_APP_JS, CODEX_MOBILE_CSS } from "../../src/daemon/codex-mobile-web.ts";

function functionSource(name: string): string {
  const start = CODEX_MOBILE_APP_JS.indexOf("  function " + name + "(");
  if (start < 0) throw new Error("Missing " + name);
  const end = CODEX_MOBILE_APP_JS.indexOf("\n  function ", start + 1);
  return CODEX_MOBILE_APP_JS.slice(start, end < 0 ? undefined : end);
}

type Viewport = {
  height: number;
  offsetTop: number;
  scale: number;
  listeners: Record<string, Array<() => void>>;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  emit(type: string): void;
};

function viewport(overrides: Partial<Viewport> = {}): Viewport {
  const listeners: Record<string, Array<() => void>> = Object.create(null);
  const value: Viewport = {
    height: 800,
    offsetTop: 0,
    scale: 1,
    listeners,
    addEventListener(type, listener) {
      (listeners[type] ||= []).push(listener);
    },
    removeEventListener(type, listener) {
      listeners[type] = (listeners[type] || []).filter((entry) => entry !== listener);
    },
    emit(type) {
      for (const listener of listeners[type] || []) listener();
    },
    ...overrides,
  };
  value.addEventListener = (type, listener) => {
    (listeners[type] ||= []).push(listener);
  };
  value.removeEventListener = (type, listener) => {
    listeners[type] = (listeners[type] || []).filter((entry) => entry !== listener);
  };
  value.emit = (type) => {
    for (const listener of listeners[type] || []) listener();
  };
  return value;
}

function harness(initialViewport: Viewport | null = viewport()) {
  const style: Record<string, string> = Object.create(null);
  const classes = new Set<string>();
  const app = {
    style: { setProperty(name: string, value: string) { style[name] = value; }, removeProperty(name: string) { delete style[name]; } },
    classList: {
      add(name: string) { classes.add(name); },
      remove(name: string) { classes.delete(name); },
      contains(name: string) { return classes.has(name); },
    },
  };
  const inputListeners: Record<string, Array<() => void>> = Object.create(null);
  const input = {
    focused: false,
    isConnected: true,
    addEventListener(type: string, listener: () => void) {
      (inputListeners[type] ||= []).push(listener);
    },
    emit(type: string) {
      for (const listener of inputListeners[type] || []) listener();
    },
  };
  const windowListeners: Record<string, Array<() => void>> = Object.create(null);
  const document = {
    activeElement: null as typeof input | null,
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
  };
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const window = {
    innerHeight: 800,
    visualViewport: initialViewport,
    addEventListener(type: string, listener: () => void) {
      (windowListeners[type] ||= []).push(listener);
    },
    removeEventListener() {},
    emit(type: string) {
      for (const listener of windowListeners[type] || []) listener();
    },
  };
  const runtime = new Function(
    "app",
    "composerInput",
    "document",
    "window",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    `return (function () {
var mobileViewportFrame = null;
${functionSource("clearMobileViewportOverride")}
${functionSource("syncMobileViewportOverride")}
${functionSource("scheduleMobileViewportSync")}
${functionSource("registerMobileViewportListeners")}
registerMobileViewportListeners();
return { clearMobileViewportOverride, syncMobileViewportOverride, scheduleMobileViewportSync, registerMobileViewportListeners };
})();`,
  )(
    app,
    input,
    document,
    window,
    (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      callbacks.set(id, callback);
      return id;
    },
    (id: number) => callbacks.delete(id),
  );
  return {
    runtime,
    app,
    input,
    document,
    window,
    windowListeners,
    style,
    focus() {
      input.focused = true;
      document.activeElement = input;
      input.emit("focus");
    },
    blur() {
      input.focused = false;
      document.activeElement = null;
      input.emit("blur");
    },
    flushFrames() {
      while (callbacks.size) {
        const [id, callback] = callbacks.entries().next().value as [number, FrameRequestCallback];
        callbacks.delete(id);
        callback(16);
      }
    },
    pendingFrames() {
      return callbacks.size;
    },
  };
}

test("mobile CSS reserves a keyboard-aware viewport without changing normal layout", () => {
  expect(CODEX_MOBILE_CSS).toContain(
    ".app-shell { display: grid; grid-template-columns: 260px minmax(0, 1fr); width: 100%; height: var(--mobile-viewport-height, 100dvh); }",
  );
  expect(CODEX_MOBILE_CSS).toContain(
    ".app-shell.mobile-viewport-override { position: relative; top: var(--mobile-viewport-offset, 0px); }",
  );
  expect(CODEX_MOBILE_CSS).toContain(".main-panel {");
  expect(CODEX_MOBILE_CSS).toContain("height: var(--mobile-viewport-height, 100dvh);");
});

test("a shrinking visual viewport with focused composer pins the app to its visible area", () => {
  const visualViewport = viewport({ height: 460, offsetTop: 92 });
  const h = harness(visualViewport);
  h.focus();
  h.runtime.syncMobileViewportOverride();
  expect(h.style["--mobile-viewport-height"]).toBe("460px");
  expect(h.style["--mobile-viewport-offset"]).toBe("92px");
  expect(h.app.classList.contains("mobile-viewport-override")).toBe(true);

  visualViewport.height = 800;
  visualViewport.offsetTop = 0;
  visualViewport.emit("resize");
  expect(h.style["--mobile-viewport-height"]).toBe("460px");
  h.flushFrames();
  expect(h.style["--mobile-viewport-height"]).toBeUndefined();
  expect(h.style["--mobile-viewport-offset"]).toBeUndefined();
  expect(h.app.classList.contains("mobile-viewport-override")).toBe(false);
});

test("closing the keyboard or blurring the composer restores the normal viewport", () => {
  const visualViewport = viewport({ height: 420, offsetTop: 80 });
  const h = harness(visualViewport);
  h.focus();
  h.runtime.syncMobileViewportOverride();
  expect(h.style["--mobile-viewport-height"]).toBe("420px");

  visualViewport.height = 800;
  visualViewport.offsetTop = 0;
  h.runtime.syncMobileViewportOverride();
  expect(h.style["--mobile-viewport-height"]).toBeUndefined();

  visualViewport.height = 430;
  visualViewport.offsetTop = 70;
  h.runtime.syncMobileViewportOverride();
  expect(h.style["--mobile-viewport-height"]).toBe("430px");
  h.blur();
  visualViewport.emit("scroll");
  h.flushFrames();
  expect(h.style["--mobile-viewport-height"]).toBeUndefined();
  expect(h.style["--mobile-viewport-offset"]).toBeUndefined();
});

test("pinch zoom and minor viewport changes never shrink the app shell", () => {
  const visualViewport = viewport({ height: 500, offsetTop: 50, scale: 1.2 });
  const h = harness(visualViewport);
  h.focus();
  h.runtime.syncMobileViewportOverride();
  expect(h.style["--mobile-viewport-height"]).toBeUndefined();
  expect(h.app.classList.contains("mobile-viewport-override")).toBe(false);

  visualViewport.scale = 1;
  visualViewport.height = 764;
  visualViewport.offsetTop = 0;
  h.runtime.syncMobileViewportOverride();
  expect(h.style["--mobile-viewport-height"]).toBeUndefined();
  expect(h.app.classList.contains("mobile-viewport-override")).toBe(false);
});

test("the visible override never extends below the layout viewport", () => {
  const visualViewport = viewport({ height: 740, offsetTop: 180 });
  const h = harness(visualViewport);
  h.focus();
  h.runtime.syncMobileViewportOverride();
  expect(h.style["--mobile-viewport-offset"]).toBe("180px");
  expect(h.style["--mobile-viewport-height"]).toBe("620px");
  expect(180 + Number.parseInt(h.style["--mobile-viewport-height"], 10)).toBe(800);
  expect(h.app.classList.contains("mobile-viewport-override")).toBe(true);
});

test("visualViewport events coalesce through one animation frame", () => {
  const visualViewport = viewport({ height: 450, offsetTop: 100 });
  const h = harness(visualViewport);
  h.focus();
  h.runtime.scheduleMobileViewportSync();
  h.runtime.scheduleMobileViewportSync();
  visualViewport.emit("resize");
  visualViewport.emit("scroll");
  expect(h.pendingFrames()).toBe(1);
  h.flushFrames();
  expect(h.style["--mobile-viewport-height"]).toBe("450px");
  expect(h.style["--mobile-viewport-offset"]).toBe("100px");
});

test("missing visualViewport keeps the normal 100dvh layout", () => {
  const h = harness(null);
  h.focus();
  expect(() => h.runtime.syncMobileViewportOverride()).not.toThrow();
  h.runtime.scheduleMobileViewportSync();
  h.flushFrames();
  expect(h.style["--mobile-viewport-height"]).toBeUndefined();
  expect(h.style["--mobile-viewport-offset"]).toBeUndefined();
});

test("pagehide cancels a pending sync and clears an already-applied override", () => {
  const visualViewport = viewport({ height: 440, offsetTop: 60 });
  const h = harness(visualViewport);
  h.focus();
  h.flushFrames();
  expect(h.style["--mobile-viewport-height"]).toBe("440px");

  h.window.emit("pagehide");
  expect(h.style["--mobile-viewport-height"]).toBeUndefined();
  expect(h.style["--mobile-viewport-offset"]).toBeUndefined();
});


test("a pending frame cannot restore keyboard layout after the document is hidden", () => {
  const h = harness(viewport({height:440,offsetTop:60}));
  h.focus();
  h.document.hidden = true;
  h.flushFrames();
  expect(h.style["--mobile-viewport-height"]).toBeUndefined();
});

test("invalid viewport offsets never produce a negative app height", () => {
  const h = harness(viewport({height:440,offsetTop:900}));
  h.focus(); h.flushFrames();
  expect(h.style["--mobile-viewport-height"]).toBeUndefined();
});
