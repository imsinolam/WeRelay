import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDailyReviewHistory } from "../../src/daemon/daily-review-history.ts";

const dirs: string[] = [];
const now = Date.UTC(2026, 10, 18, 4, 0, 0);
const day = 86_400_000;
const privateStrings = [
  "PRIVATE PROJECT NAME",
  "private-task-title",
  "private-token-abcdef",
  "https://private.example/path",
  "/synthetic/private/.werelay",
  "原始错误：连接失败",
];

afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-daily-review-"));
  dirs.push(root);
  const directory = path.join(root, "diagnostics", "daily-failure-review");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const write = (name: string, value: unknown) => {
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value), { mode: 0o600 });
  };
  const run = () => readDailyReviewHistory(root, { now });
  return { root, directory, write, run };
}

function auditReport(atMs: number, patch: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    generatedAtMs: atMs,
    owner: privateStrings[0],
    observation: {
      schemaVersion: 1,
      generatedAtMs: atMs,
      sinceMs: atMs - day,
      complete: true,
      gaps: [],
      coverage: [],
      groups: [{
        fingerprint: privateStrings[1],
        category: "readiness",
        recentMessages: 5,
        outstandingMessages: 6,
        outcomes: { recovered: 1, attention: 6, pending: 0, closed: 0 },
        samples: [{ error: privateStrings[2] }],
      }],
    },
    summary: {
      deduplicatedRecords: 124,
      outstandingLogicalMessages: 19,
      outstandingByRecordedStatus: { unconfirmed: 8, failed: 11 },
      recentIncidentMessages: 5,
      recentByRecordedStatus: { delivered: 1, failed: 4 },
      pendingRetryMessages: 0,
      meaning: privateStrings[3],
    },
    runtime: {
      installedVersion: privateStrings[4],
      daemonEntryMatchesInstalledPackage: true,
      fixIsAncestorOfObservedMain: true,
      deploymentStatus: privateStrings[5],
    },
    rootCauses: [
      { id: "codex-desktop-protocol-compatibility", evidence: privateStrings[0], status: "merged-awaiting-deployment", next: privateStrings[1] },
      { id: "pi-original-owner-unavailable", evidence: privateStrings[2] },
      { id: "deepseek-model-unavailable", evidence: privateStrings[3] },
      { id: "codex-uncertain-historical-receipts", evidence: privateStrings[4] },
    ],
    validation: [
      { command: privateStrings[0], result: "passed", sourceSha: privateStrings[1] },
      { command: privateStrings[2], result: "passed" },
    ],
    newFixCommits: [],
    mainWritesByThisTask: false,
    coverageGaps: { workspaceGapCounts: {}, noTimeGapSincePreviousReview: true },
    scope: privateStrings[5],
    ...patch,
  };
}

function legacyReport(atMs: number, patch: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    generatedAtMs: atMs,
    sinceMs: atMs - day,
    complete: true,
    coverage: [{ workspace: privateStrings[0], gaps: [] }],
    groups: [{
      fingerprint: privateStrings[1],
      category: "receipt-uncertain",
      recentMessages: 2,
      outstandingMessages: 3,
      outcomes: { recovered: 1, attention: 3, pending: 1, closed: 1 },
      samples: [{ error: privateStrings[2] }],
    }],
    scope: privateStrings[3],
    ...patch,
  };
}

test("projects the real schema through a fixed allow-list without copying private text", () => {
  const h = fixture();
  h.write("report-2026-11-17-audit.json", auditReport(now));
  const result = h.run();
  expect(result.skipped).toBe(0);
  expect(result.reports).toHaveLength(1);
  const report = result.reports[0]!;
  expect(Object.keys(report).sort()).toEqual(["actions", "atMs", "complete", "counts", "coverageNote", "id", "issues", "sinceMs"].sort());
  expect(report.counts).toEqual({ recent: 5, recovered: 1, failed: 11, unconfirmed: 8, pending: 0, closed: 0, outstanding: 19 });
  expect(report.issues.map(issue => issue.status)).toEqual(["waiting", "confirm", "action", "confirm"]);
  expect(report.issues.every(issue => ["waiting", "observing", "confirm", "action"].includes(issue.status))).toBe(true);
  expect(report.actions).toEqual(["已检查保留的消息发送记录。", "已完成相关回归验证。", "已核对运行入口与安装版本一致。", "已确认相关修复已准备完成。", "本次没有新增代码修改。"]);
  expect(report.coverageNote).toContain("不代表任务执行成功");
  const serialized = JSON.stringify(result);
  for (const text of [...privateStrings, "merge", "passed", "1.0.6"]) expect(serialized).not.toContain(text);
});

test("uses observation.sinceMs, keeps newest report per day and caps to 30 reports", () => {
  const h = fixture();
  h.write("report-2026-11-17.json", legacyReport(now - 1000));
  h.write("report-2026-11-17-audit.json", auditReport(now));
  for (let index = 1; index < 40; index++) {
    const date = new Date(now - index * day).toISOString().slice(0, 10);
    h.write(`report-${date}.json`, legacyReport(now - index * day));
  }
  const result = h.run();
  expect(result.reports).toHaveLength(30);
  expect(result.reports[0]?.atMs).toBe(now);
  expect(result.reports[0]?.sinceMs).toBe(now - day);
  expect(result.reports.filter(report => report.atMs === now)).toHaveLength(1);
  expect(result.reports.at(-1)?.atMs).toBe(now - 30 * day);
});

test("sums old recovered outcomes and leaves attention unsplit", () => {
  const h = fixture();
  h.write("report-2026-11-17.json", legacyReport(now, { complete: false, gaps: ["incomplete"] }));
  const report = h.run().reports[0]!;
  expect(report.counts).toEqual({ recent: 2, recovered: 1, failed: null, unconfirmed: null, pending: 1, closed: 1, outstanding: 3 });
  expect(report.coverageNote).toContain("统计可能偏低");
  expect(JSON.stringify(report)).not.toContain("attention");
});

test("shows an unknown fixed issue without forwarding unrecognized text", () => {
  const h = fixture();
  h.write("report-2026-11-17-audit.json", auditReport(now, {
    rootCauses: [
      { id: privateStrings[0], evidence: privateStrings[1] },
      { id: "codex-desktop-protocol-compatibility", evidence: privateStrings[2] },
    ],
  }));
  const report = h.run().reports[0]!;
  expect(report.issues).toHaveLength(2);
  expect(report.issues[0]).toMatchObject({ title: "Codex 消息发送受阻", status: "confirm" });
  expect(report.issues[1]).toMatchObject({ title: "部分问题仍需核对", status: "confirm" });
  const serialized = JSON.stringify(report);
  for (const text of privateStrings) expect(serialized).not.toContain(text);
});

test("applies deployment verification only to the newest report with a valid time gate", () => {
  const h = fixture();
  h.write("report-2026-11-16-audit.json", auditReport(now - 2 * day));
  h.write("report-2026-11-17-audit.json", auditReport(now - 2000));
  h.write("open-issues.json", {
    latestDeploymentVerification: { checkedAtMs: now - 1000, installedProtocolV13Present: true, installedVersion: privateStrings[0] },
    issues: [{ id: "codex-desktop-protocol-compatibility", status: "installed-locally-awaiting-observation", evidence: privateStrings[1] }],
  });
  const result = h.run();
  expect(result.reports[0]?.issues[0]?.status).toBe("observing");
  expect(result.reports[0]?.issues[1]?.status).toBe("confirm");
  expect(result.reports[1]?.issues[0]?.status).toBe("waiting");
  expect(JSON.stringify(result)).not.toContain(privateStrings[0]);
  h.write("open-issues.json", {
    issues: [{ id: "codex-desktop-protocol-compatibility", status: "installed-locally-awaiting-observation" }],
    latestDeploymentVerification: { checkedAtMs: now + day, installedProtocolV13Present: true },
  });
  expect(h.run().reports[0]?.issues[0]?.status).toBe("waiting");
});

test("skips malformed, future-dated, oversized and symlinked files without failing the page", () => {
  const h = fixture();
  h.write("report-2026-11-17-audit.json", auditReport(now));
  fs.writeFileSync(path.join(h.directory, "report-2026-11-16.json"), "{broken");
  h.write("report-2026-11-15.json", auditReport(now + day));
  fs.writeFileSync(path.join(h.directory, "report-2026-11-14.json"), "x".repeat(1024 * 1024 + 1));
  const target = path.join(h.directory, "private-target.json");
  fs.writeFileSync(target, JSON.stringify(auditReport(now - 2 * day)));
  fs.symlinkSync(target, path.join(h.directory, "report-2026-11-13.json"));
  const result = h.run();
  expect(result.reports).toHaveLength(1);
  expect(result.skipped).toBe(4);
  expect(JSON.stringify(result)).not.toContain(privateStrings[0]);
});

test("returns empty data for a missing directory and never mutates source files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-daily-review-empty-"));
  dirs.push(root);
  expect(readDailyReviewHistory(root, { now })).toEqual({ reports: [], skipped: 0 });
  const h = fixture();
  const file = path.join(h.directory, "report-2026-11-17-audit.json");
  fs.writeFileSync(file, JSON.stringify(auditReport(now, { note: privateStrings[0] })));
  const before = fs.readFileSync(file);
  h.run();
  h.run();
  expect(fs.readFileSync(file)).toEqual(before);
});

test("never follows a diagnostics directory link or treats object prototype keys as known issues", () => {
  const source = fixture();
  source.write("report-2026-11-17-audit.json", auditReport(now, { rootCauses: [{ id: "__proto__" }, { id: "constructor" }] }));
  expect(source.run().reports[0]?.issues).toHaveLength(1);
  expect(source.run().reports[0]?.issues[0]?.title).toBe("部分问题仍需核对");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-review-symlink-")); dirs.push(root);
  fs.symlinkSync(path.join(source.root, "diagnostics"), path.join(root, "diagnostics"));
  expect(readDailyReviewHistory(root, { now })).toEqual({ reports: [], skipped: 0 });
});

test("unrelated deployment entries and future reports cannot mark a repair as updated", () => {
  const h = fixture();
  h.write("report-2026-11-17-audit.json", auditReport(now - 2000));
  h.write("report-2026-11-18-audit.json", auditReport(now + 1));
  h.write("open-issues.json", { issues: [{ id: "unrelated", status: "installed-locally-awaiting-observation" }],
    latestDeploymentVerification: { checkedAtMs: now - 1000, installedProtocolV13Present: true } });
  const result = h.run();
  expect(result.reports).toHaveLength(1);
  expect(result.reports[0]?.issues[0]?.status).toBe("waiting");
  expect(result.skipped).toBe(1);
});
