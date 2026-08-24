import { describe, expect, test } from "bun:test";

import { MobileConversationRevisionStore } from "../../src/daemon/mobile-conversation-revisions.ts";

describe("mobile conversation revisions", () => {
  test("keeps adapter + session identity isolated and changes only when touched", () => {
    const store = new MobileConversationRevisionStore({ epoch: "boot" });

    const codexInitial = store.get("codex", "same-session");
    const claudeInitial = store.get("claude", "same-session");
    expect(codexInitial).not.toBe(claudeInitial);
    expect(store.get("codex", "same-session")).toBe(codexInitial);

    const codexChanged = store.touch("codex", "same-session");
    expect(codexChanged).not.toBe(codexInitial);
    expect(store.get("claude", "same-session")).toBe(claudeInitial);
  });

  test("uses a new epoch after daemon restart so stale browser revisions refresh", () => {
    const beforeRestart = new MobileConversationRevisionStore({ epoch: "boot-a" });
    const afterRestart = new MobileConversationRevisionStore({ epoch: "boot-b" });

    expect(beforeRestart.get("codex", "thread-1"))
      .not.toBe(afterRestart.get("codex", "thread-1"));
  });
});
