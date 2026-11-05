import { expect, test } from "bun:test";
import { isInternalTask, readTaskOriginMetadata, retainTaskOrigin } from "../../src/bridge/task-origin.ts";

test("Harness parent and origin fields hide real children without relying on titles", () => {
  expect(readTaskOriginMetadata({ parentSessionId: "main", origin: "subagent" }))
    .toEqual({ parentThreadId: "main", source: "subagent" });
  expect(isInternalTask({ origin: "subagent" })).toBe(true);
  expect(isInternalTask({ parentSessionId: "main" })).toBe(true);
  expect(isInternalTask({ title: "子任务 Guardian review", source: "cli" })).toBe(false);
  expect(retainTaskOrigin({ title: "updated" }, { parentThreadId: "main", source: "subagent" }))
    .toMatchObject({ parentThreadId: "main", source: "subagent" });
});
