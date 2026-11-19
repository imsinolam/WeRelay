import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export type DailyReviewIssueStatus = "waiting" | "observing" | "confirm" | "action";
export type DailyReviewIssue = {
  title: string;
  detail: string;
  status: DailyReviewIssueStatus;
  statusLabel: string;
  next: string;
};
export type DailyReviewCounts = {
  recent: number | null;
  recovered: number | null;
  failed: number | null;
  unconfirmed: number | null;
  pending: number | null;
  closed: number | null;
  outstanding: number | null;
};
export type DailyReviewReport = {
  id: string;
  atMs: number;
  sinceMs: number;
  complete: boolean;
  counts: DailyReviewCounts;
  issues: DailyReviewIssue[];
  actions: string[];
  coverageNote: string;
};
export type DailyReviewHistory = { reports: DailyReviewReport[]; skipped: number };
export type ReadDailyReviewHistoryOptions = { now?: number };

type JsonRecord = Record<string, unknown>;
type CoverageState = "complete" | "gaps" | "unknown";

const REVIEW_DIRECTORY = path.join("diagnostics", "daily-failure-review");
const REPORT_PATTERN = /^report-(\d{4}-\d{2}-\d{2})(?:-([a-z0-9][a-z0-9-]{0,31}))?\.json$/;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 60;
const MAX_REPORTS = 30;
const MAX_ISSUES = 30;
const MAX_ACTIONS = 8;
const STATUS_LABELS: Record<DailyReviewIssueStatus, string> = {
  waiting: "已修复待更新",
  observing: "已更新待观察",
  confirm: "需要确认",
  action: "需用户处理",
};
const COVERAGE_NOTES: Record<CoverageState, string> = {
  complete: "本次证据可读取，未发现已知缺口；这不证明历史完整，也不代表任务执行成功。",
  gaps: "本次证据存在缺口，统计可能偏低；这不代表没有异常，也不代表任务执行成功。",
  unknown: "本次证据覆盖范围无法确认，统计仅供参考；这不代表任务执行成功。",
};
const ROOT_CAUSES: Record<string, DailyReviewIssue> = {
  "codex-desktop-protocol-compatibility": {
    title: "Codex 消息发送受阻",
    detail: "电脑端连接方式发生变化，部分消息未能送出；这不代表任务已经执行失败。",
    status: "confirm",
    statusLabel: STATUS_LABELS.confirm,
    next: "等待修复更新到运行版本；更新后从原任务继续观察，不要重发历史消息。",
  },
  "pi-original-owner-unavailable": {
    title: "Pi 原会话暂时无法连接",
    detail: "原会话的界面进程不可用时，远程消息暂时无法进入原窗口；已有记录不会因此消失。",
    status: "confirm",
    statusLabel: STATUS_LABELS.confirm,
    next: "在电脑上确认原会话已经恢复；不要新建会话代替原任务。",
  },
  "deepseek-model-unavailable": {
    title: "DeepSeek 模型目前不可用",
    detail: "所选模型当前无法使用时，新任务可能无法按预期开始；消息状态需要按原任务核对。",
    status: "action",
    statusLabel: STATUS_LABELS.action,
    next: "请改用可用模型或稍后再试；重试前先到原任务查看。",
  },
  "codex-uncertain-historical-receipts": {
    title: "部分历史消息仍待核对",
    detail: "部分历史消息没有明确结果，无法据此判断消息是否送达，也不能判断是否执行成功。",
    status: "confirm",
    statusLabel: STATUS_LABELS.confirm,
    next: "请到原任务核对；在确认前不要重新提交，避免重复任务。",
  },
};
const CATEGORIES: Record<string, DailyReviewIssue> = {
  readiness: {
    title: "会话入口尚未就绪",
    detail: "会话入口仍在准备时，消息可能暂时无法继续提交；这不代表任务已经执行或失败。",
    status: "confirm",
    statusLabel: STATUS_LABELS.confirm,
    next: "等待入口就绪后查看原任务；持续不可用请重新打开对应终端。",
  },
  "receipt-uncertain": {
    title: "消息结果尚未确认",
    detail: "提交结果暂时无法确认，消息可能已经进入原任务；未确认不能当作失败，也不能当作成功。",
    status: "confirm",
    statusLabel: STATUS_LABELS.confirm,
    next: "请到原任务查看是否已经收到；确认前不要重复发送。",
  },
  unknown: {
    title: "部分问题仍需核对",
    detail: "现有证据不足以自动判断具体原因，需要结合原任务状态确认。",
    status: "confirm",
    statusLabel: STATUS_LABELS.confirm,
    next: "请查看原任务中的最新消息；确认前不要重复发送。",
  },
  model: {
    title: "模型目前不可用",
    detail: "模型暂时无法使用时，任务可能无法按预期继续；消息状态需要按原任务核对。",
    status: "action",
    statusLabel: STATUS_LABELS.action,
    next: "请改用可用模型或稍后再试；重试前先到原任务查看。",
  },
  network: {
    title: "消息连接暂时不稳定",
    detail: "连接不稳定可能导致消息未能提交或结果延迟，不能据此判断任务是否执行成功。",
    status: "confirm",
    statusLabel: STATUS_LABELS.confirm,
    next: "检查网络连接后查看原任务；确认前不要重复发送。",
  },
  authentication: {
    title: "登录或访问权限需要检查",
    detail: "登录状态或访问权限异常时，消息可能无法继续提交；这不代表任务执行成功。",
    status: "action",
    statusLabel: STATUS_LABELS.action,
    next: "检查相关终端的登录状态和访问权限，再返回原任务查看。",
  },
};
const UNKNOWN_ISSUE = CATEGORIES.unknown!;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}
function firstCount(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = count(value);
    if (parsed !== null) return parsed;
  }
  return null;
}
function nestedCount(source: unknown, ...keys: string[]): number | null {
  let current = source;
  for (const key of keys) {
    if (!record(current)) return null;
    current = current[key];
  }
  return count(current);
}
function clonedIssue(template: DailyReviewIssue): DailyReviewIssue {
  return { ...template };
}
function issueFromId(value: unknown): DailyReviewIssue | undefined {
  if (typeof value !== "string") return undefined;
  const template = Object.hasOwn(ROOT_CAUSES, value) ? ROOT_CAUSES[value]
    : Object.hasOwn(CATEGORIES, value) ? CATEGORIES[value] : undefined;
  return template ? clonedIssue(template) : undefined;
}
function issueFromRecord(value: unknown): DailyReviewIssue | undefined {
  if (typeof value === "string") return issueFromId(value);
  if (!record(value)) return undefined;
  const nested = record(value.issue) ? value.issue : undefined;
  const status = nested?.status ?? value.status;
  if (status === "installed-locally-awaiting-observation" || status === "deployed" || status === "observed-deployed") {
    const issue = issueFromId(nested?.id ?? value.id ?? value.rootCauseId);
    if (issue) {
      issue.status = "observing";
      issue.statusLabel = STATUS_LABELS.observing;
      issue.next = "更新已完成，继续观察后续消息；历史消息不会自动重发。";
      return issue;
    }
  }
  if (status === "merged-awaiting-deployment") {
    const issue = issueFromId(nested?.id ?? value.id ?? value.rootCauseId);
    if (issue) {
      issue.status = "waiting";
      issue.statusLabel = STATUS_LABELS.waiting;
      return issue;
    }
  }
  for (const key of ["id", "category", "rootCauseId", "fingerprint", "categoryId", "rootCause"] as const) {
    const issue = issueFromId(nested?.[key] ?? value[key]);
    if (issue) return issue;
  }
  return undefined;
}
function issueKeys(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!record(value)) return [];
  const nested = record(value.issue) ? value.issue : undefined;
  return ["id", "category", "rootCauseId", "fingerprint", "categoryId", "rootCause"]
    .flatMap(key => [nested?.[key], value[key]])
    .filter((entry): entry is string => typeof entry === "string");
}

function readJsonFile(filePath: string, budget: { remaining: number }): unknown {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.size > budget.remaining) throw new Error("invalid-file");
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("invalid-file");
    const buffer = Buffer.alloc(stat.size);
    let length = 0;
    while (length < buffer.length) {
      const bytes = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!bytes) break;
      length += bytes;
    }
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally {
    budget.remaining -= stat.size;
    fs.closeSync(fd);
  }
}

function listReports(directory: string): { fileName: string; day: string }[] {
  const target = fs.lstatSync(directory);
  if (!target.isDirectory() || target.isSymbolicLink()) return [];
  if (fs.lstatSync(path.dirname(directory)).isSymbolicLink()) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      if (entry.isSymbolicLink()) return [];
      const match = REPORT_PATTERN.exec(entry.name);
      return match && entry.isFile() ? [{ fileName: entry.name, day: match[1]! }] : [];
    })
    .sort((left, right) => right.fileName.localeCompare(left.fileName));
}

function skippedReportNames(directory: string, selectedDays: Set<string>): number {
  return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => {
    const match = REPORT_PATTERN.exec(entry.name);
    return Boolean(match) && !selectedDays.has(match![1]!) && !entry.isFile();
  }).length;
}

function normalizeCounts(summary: unknown, observation: unknown, groups: unknown): DailyReviewCounts {
  const source = record(summary) ? summary : {};
  const observed = record(observation) ? observation : {};
  const groupList = Array.isArray(groups) ? groups.filter(record).slice(0, 5000) : [];
  const hasGroupOutcomes = groupList.some(group => record(group.outcomes));
  const sumGroupOutcome = (key: string): number | null => {
    if (!hasGroupOutcomes) return null;
    let total = 0;
    for (const group of groupList) {
      const outcomes: unknown = record(group.outcomes) ? group.outcomes[key] : undefined;
      total += count(outcomes) ?? 0;
    }
    return total;
  };
  const sumGroupCount = (key: "recentMessages" | "outstandingMessages"): number | null => {
    if (!groupList.some(group => count(group[key]) !== null)) return null;
    let total = 0;
    for (const group of groupList) total += count(group[key]) ?? 0;
    return total;
  };
  const outcomes = source.outstandingByRecordedStatus;
  const recentOutcomes = source.recentByRecordedStatus;
  const failed = nestedCount(outcomes, "failed");
  const unconfirmed = nestedCount(outcomes, "unconfirmed");
  const recovered = nestedCount(recentOutcomes, "delivered") ?? nestedCount(recentOutcomes, "recovered")
    ?? (hasGroupOutcomes ? sumGroupOutcome("recovered") : null);
  const outstanding = firstCount(source.outstandingLogicalMessages, sumGroupCount("outstandingMessages"));
  const attentionCount = (outcomes: unknown): number | null => {
    if (!record(outcomes)) return null;
    let total = 0;
    let seen = false;
    for (const key of ["failed", "unconfirmed", "attention"]) {
      const value = count(outcomes[key]);
      if (value === null) continue;
      seen = true;
      total += value;
    }
    return seen ? total : null;
  };
  return {
    recent: firstCount(source.recentIncidentMessages, sumGroupCount("recentMessages")),
    recovered,
    failed,
    unconfirmed,
    pending: firstCount(source.pendingRetryMessages, sumGroupOutcome("pending")),
    closed: sumGroupOutcome("closed") ?? attentionCount(source.handledByRecordedStatus),
    outstanding: outstanding ?? (failed !== null && unconfirmed !== null ? failed + unconfirmed : null)
      ?? firstCount(observed.outstandingMessages, attentionCount(outcomes), sumGroupOutcome("attention")),
  };
}

function completedActions(report: JsonRecord): string[] {
  const actions: string[] = [];
  if (record(report.observation) && Array.isArray(report.observation.coverage)) actions.push("已检查保留的消息发送记录。");
  const validation = Array.isArray(report.validation) ? report.validation.filter(record) : [];
  const passed = validation.some(entry => entry.result === true || entry.result === "passed"
    || (typeof entry.result === "string" && /^\d+\s+passed,\s*0\s+failed(?:\s|,|$)/i.test(entry.result)));
  if (passed) actions.push("已完成相关回归验证。");
  if (Array.isArray(report.newFixCommits) && report.newFixCommits.length > 0) actions.push("本次记录了新的修复提交。");
  const runtime = record(report.runtime) ? report.runtime : undefined;
  if (runtime?.daemonEntryMatchesInstalledPackage === true) actions.push("已核对运行入口与安装版本一致。");
  if (runtime?.fixIsAncestorOfObservedMain === true) actions.push("已确认相关修复已准备完成。");
  if (report.mainWritesByThisTask === true) actions.push("已将修复纳入后续更新。");
  if (Array.isArray(report.newFixCommits) && report.newFixCommits.length === 0) actions.push("本次没有新增代码修改。");
  if (!actions.length) actions.push("该记录未提供处理步骤。");
  return actions.slice(0, MAX_ACTIONS);
}

function normalizeIssues(value: unknown, hasUnmapped: boolean): DailyReviewIssue[] {
  const issues: DailyReviewIssue[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value) ? value.slice(0, MAX_ISSUES) : []) {
    const issue = issueFromRecord(item);
    if (!issue || seen.has(issue.title)) continue;
    seen.add(issue.title);
    issues.push(issue);
  }
  if (hasUnmapped && !seen.has(UNKNOWN_ISSUE.title)) issues.push(clonedIssue(UNKNOWN_ISSUE));
  return issues;
}

function normalizeReport(value: unknown, now: number): DailyReviewReport | null {
  if (!record(value)) return null;
  const observation = record(value.observation) ? value.observation : undefined;
  const generatedAtMs = value.generatedAtMs;
  if (!Number.isSafeInteger(generatedAtMs) || (generatedAtMs as number) <= 0 || (generatedAtMs as number) > now) return null;
  const sinceMs = value.sinceMs ?? observation?.sinceMs;
  if (!Number.isSafeInteger(sinceMs) || (sinceMs as number) <= 0 || (sinceMs as number) > (generatedAtMs as number)) return null;
  const coverageSource = record(value.coverageGaps) ? value.coverageGaps : observation;
  const complete = value.complete === true || observation?.complete === true;
  const gaps = Array.isArray(coverageSource?.gaps) ? coverageSource.gaps : [];
  const gapDetail = record(coverageSource?.workspaceGapCounts) ? coverageSource.workspaceGapCounts : {};
  const hasGaps = !complete || gaps.length > 0 || Object.keys(gapDetail).length > 0;
  const coverage: CoverageState = hasGaps ? "gaps" : complete ? "complete" : "unknown";
  const causes = Array.isArray(value.rootCauses) ? value.rootCauses : [];
  const unmapped = causes.some(item => !issueFromRecord(item)) || (Array.isArray(value.groups) && value.groups.some(group => {
    const category = record(group) ? group.category : undefined;
    return typeof category === "string" && !Object.hasOwn(CATEGORIES, category);
  }));
  const issues = normalizeIssues(causes.length ? causes : value.groups, unmapped);
  return {
    id: hash(JSON.stringify([generatedAtMs, sinceMs, value.schemaVersion ?? 1])),
    atMs: generatedAtMs as number,
    sinceMs: sinceMs as number,
    complete,
    counts: normalizeCounts(value.summary, observation, observation?.groups ?? value.groups),
    issues,
    actions: completedActions(value),
    coverageNote: COVERAGE_NOTES[coverage],
  };
}

function cloneReport(report: DailyReviewReport): DailyReviewReport {
  return { ...report, counts: { ...report.counts }, issues: report.issues.map(issue => ({ ...issue })), actions: [...report.actions] };
}

function applyDeploymentVerification(report: DailyReviewReport, issueFile: unknown, now: number): void {
  if (!record(issueFile)) return;
  const issues = Array.isArray(issueFile.issues) ? issueFile.issues : [];
  const protocolEntry = issues.find(item => {
    if (!record(item)) return false;
    return issueKeys(item).includes("codex-desktop-protocol-compatibility");
  });
  if (!protocolEntry || !record(protocolEntry)) return;
  const verification = record(protocolEntry.deploymentVerification) ? protocolEntry.deploymentVerification
    : record(issueFile.latestDeploymentVerification) ? issueFile.latestDeploymentVerification : undefined;
  if (!verification || verification.installedProtocolV13Present !== true
    || protocolEntry.status !== "installed-locally-awaiting-observation") return;
  const checkedAtMs = verification.checkedAtMs;
  if (!Number.isSafeInteger(checkedAtMs) || (checkedAtMs as number) < report.atMs || (checkedAtMs as number) > now) return;
  const protocol = report.issues.find(issue => issue.title === ROOT_CAUSES["codex-desktop-protocol-compatibility"]?.title);
  if (!protocol) return;
  protocol.status = "observing";
  protocol.statusLabel = STATUS_LABELS.observing;
  protocol.next = "已核对本机安装包含兼容更新；继续观察后续消息，不重发历史消息。";
}

/** Read-only, bounded projection; private report text never crosses this boundary. */
export function readDailyReviewHistory(dataDir: string, options: ReadDailyReviewHistoryOptions = {}): DailyReviewHistory {
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now <= 0) return { reports: [], skipped: 0 };
  const directory = path.join(dataDir, REVIEW_DIRECTORY);
  let candidates: ReturnType<typeof listReports>;
  try {
    candidates = listReports(directory).slice(0, MAX_FILES);
  } catch {
    return { reports: [], skipped: 0 };
  }
  if (!candidates.length) return { reports: [], skipped: 0 };
  const budget = { remaining: MAX_TOTAL_BYTES };
  const reports: (DailyReviewReport & { day: string })[] = [];
  let skipped = skippedReportNames(directory, new Set(candidates.map(candidate => candidate.day)));
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = readJsonFile(path.join(directory, candidate.fileName), budget);
    } catch {
      skipped++;
      continue;
    }
    const report = normalizeReport(value, now);
    if (!report) {
      skipped++;
      continue;
    }
    reports.push({ ...report, day: candidate.day });
  }
  reports.sort((left, right) => right.atMs - left.atMs || left.id.localeCompare(right.id));
  const byDay = new Map<string, DailyReviewReport & { day: string }>();
  for (const report of reports) {
    if (!byDay.has(report.day)) byDay.set(report.day, report);
  }
  const selected = [...byDay.values()].slice(0, MAX_REPORTS).map(({ day: _day, ...report }) => cloneReport(report));
  let issueFile: unknown;
  try {
    issueFile = readJsonFile(path.join(directory, "open-issues.json"), budget);
  } catch {
    issueFile = undefined;
  }
  if (selected[0]) applyDeploymentVerification(selected[0], issueFile, now);
  return {
    reports: selected.map(cloneReport),
    skipped,
  };
}
