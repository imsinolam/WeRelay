import { expect, test } from "bun:test";
import { CHILD_TASK_LINKS_JS } from "../../src/web/child-task-links.ts";
import { ChatElement } from "./helpers/chat-components.ts";
import { CODEX_MOBILE_JS } from "../../src/daemon/codex-mobile-web.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(readChildren: (adapter: string, parent: string) => Promise<unknown>) {
  const opened: unknown[] = [];
  let closes = 0;
  let now = 100;
  const document = { createElement: () => new ChatElement() };
  const create = new Function(CHILD_TASK_LINKS_JS + ";return createChildTaskLinks;")();
  const view = create({ document, readChildren, now: () => now,
    preview: { open: (...args: unknown[]) => { opened.push(args[0]); }, close: () => { closes++; } } });
  return { view, opened, closes: () => closes, tick: () => { now += 16_000; } };
}

test("child links are parent-scoped, read-only and never become top-level navigation", async () => {
  const f = fixture(async () => ({ parentThreadId: "main", tasks: [
    { threadId: "child", parentThreadId: "main", title: "审查 <script> 是普通文本", status: "running" },
    { threadId: "unrelated", parentThreadId: "other", title: "不应显示" },
    { threadId: "main", parentThreadId: "main", title: "不应自引用" },
  ] }));
  await f.view.setTarget("codex", "main");
  expect(f.view.element.hidden).toBe(false);
  const buttons = f.view.element.all().filter((el: ChatElement) => el.className === "child-task-link");
  expect(buttons).toHaveLength(1);
  expect(buttons[0].all().map((el: ChatElement) => el.textContent)).toContain("审查 <script> 是普通文本");
  buttons[0].emit("click");
  expect(f.opened).toEqual([{ adapter: "codex", threadId: "child", taskTitle: "审查 <script> 是普通文本", taskState: "running", contextLabel: "子任务" }]);
  expect(CHILD_TASK_LINKS_JS).not.toMatch(/selectTask\(|switchAdapter\(|location\.|history\.|resumeSession\(/);
});

test("main conversation wires parent links to history-only previews and refreshes separately from the transcript", () => {
  const start = CODEX_MOBILE_JS.indexOf("var childTaskPreview = createTaskConversationPreview");
  const end = CODEX_MOBILE_JS.indexOf("var composerView =", start);
  const wiring = CODEX_MOBILE_JS.slice(start, end);
  expect(wiring).toContain("/messages?limit=30&history=1");
  expect(wiring).toContain('"/children"');
  expect(wiring).not.toMatch(/selectTask\(|switchAdapter\(/);
  expect(CODEX_MOBILE_JS).toContain("childTaskLinks.refresh(),");
  expect(CODEX_MOBILE_JS).toContain('state.authenticated && !state.switchingAdapter ? state.currentThreadId : ""');
  expect(CODEX_MOBILE_JS).toContain("nodes.push(childTaskLinks.element)");
  expect(CODEX_MOBILE_JS).not.toContain("state.tasks.push(child");
  new Function(CODEX_MOBILE_JS);
});

test("late children and previews cannot leak into a different parent; empty relationships stay quiet", async () => {
  const first = deferred<unknown>();
  const f = fixture(async (_adapter, parent) => parent === "first" ? first.promise : { parentThreadId: parent, tasks: [] });
  const read = f.view.setTarget("codex", "first");
  await f.view.setTarget("codex", "second");
  first.resolve({ parentThreadId: "first", tasks: [{ threadId: "late", parentThreadId: "first", title: "迟到子任务" }] });
  await read;
  expect(f.view.element.hidden).toBe(true);
  expect(f.view.element.all().some((el: ChatElement) => el.textContent === "迟到子任务")).toBe(false);
  expect(f.closes()).toBe(2);
  await f.view.setTarget("pi", "fork-parent");
  expect(f.view.element.hidden).toBe(true);
});

test("relationship reads refresh independently of transcript revisions and recover after errors", async () => {
  let reads = 0;
  const f = fixture(async () => {
    reads++;
    if (reads === 1) throw new Error("终端暂时离线");
    return { parentThreadId: "main", tasks: [{ threadId: "child", parentThreadId: "main", title: "审查" }] };
  });
  await f.view.setTarget("deepseek", "main");
  expect(f.view.element.hidden).toBe(false);
  expect(f.view.element.all().some((el: ChatElement) => el.textContent.includes("终端暂时离线"))).toBe(true);
  await f.view.refresh(true);
  expect(reads).toBe(2);
  const details = f.view.element.children[0];
  details.open = true;
  await f.view.refresh();
  expect(reads).toBe(2);
  f.tick();
  await f.view.refresh();
  expect(reads).toBe(3);
  expect(f.view.element.children[0]).toBe(details);
  expect(details.open).toBe(true);
});
