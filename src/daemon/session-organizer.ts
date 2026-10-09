import type { CodexMobileTaskBoardTask, CodexMobileTaskStatus } from "./codex-mobile-server.ts";

export type SessionOrganizerSection = "active" | "waiting" | "recent" | "stale" | "error";

export type SessionOrganizerTitleQuality = "clear" | "needsReview" | "missing";

export type SessionOrganizerSession = CodexMobileTaskBoardTask & {
  projectKey: string;
  projectLabel: string;
  section: SessionOrganizerSection;
  titleQuality: SessionOrganizerTitleQuality;
  renameSuggestion?: string;
  renameReason?: string;
};

export type SessionOrganizerProject = {
  projectKey: string;
  projectLabel: string;
  cwd?: string;
  latestActivityAt?: string;
  counts: Record<SessionOrganizerSection, number>;
  sessions: SessionOrganizerSession[];
};

export type SessionOrganizerSnapshot = {
  generatedAt: string;
  staleAfterDays: number;
  projects: SessionOrganizerProject[];
  sessions: SessionOrganizerSession[];
  totals: {
    projects: number;
    sessions: number;
    needsReview: number;
    active: number;
    waiting: number;
    stale: number;
  };
};

const DEFAULT_STALE_AFTER_DAYS = 30;
const GENERIC_TITLE_PATTERN = /^(?:new|new task|task|todo|test|testing|fix|bug|issue|work|work item|continue|continued|继续|任务|新任务|测试|修复|问题|临时|未命名|无标题|untitled|conversation|chat|codex|claude|grok|opencode|codebuddy|workbuddy|dsh|\d+|[a-f0-9]{8,})$/iu;
const GENERIC_TITLE_WORDS = new Set([
  "new",
  "task",
  "todo",
  "test",
  "testing",
  "fix",
  "bug",
  "issue",
  "work",
  "continue",
  "continued",
  "继续",
  "任务",
  "新任务",
  "测试",
  "修复",
  "问题",
  "临时",
  "未命名",
  "无标题",
  "untitled",
  "conversation",
  "chat",
  "codex",
  "claude",
  "grok",
  "opencode",
  "codebuddy",
  "workbuddy",
  "dsh",
]);

const TITLE_TOKEN_TRANSLATIONS: Record<string, string> = {
  add: "增加",
  auth: "鉴权",
  bug: "问题",
  check: "检查",
  deploy: "部署",
  fix: "修复",
  image: "图片",
  list: "列表",
  message: "消息",
  messages: "消息",
  mobile: "移动端",
  project: "项目",
  publish: "发布",
  release: "发布",
  rename: "重命名",
  review: "检查",
  server: "服务端",
  session: "会话",
  sync: "同步",
  task: "任务",
  tasks: "任务",
  test: "测试",
  tests: "测试",
  ui: "界面",
  web: "网页",
  wechat: "微信",
};

function parseTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function projectLabelFor(task: CodexMobileTaskBoardTask): string {
  if (task.projectName?.trim()) return task.projectName.trim();
  if (task.cwd?.trim()) {
    const pieces = task.cwd.split(/[\\/]/).filter(Boolean);
    if (pieces.at(-1)) return pieces.at(-1)!;
  }
  return "未归类项目";
}

function projectKeyFor(task: CodexMobileTaskBoardTask): string {
  return task.projectId?.trim() || task.cwd?.trim() || projectLabelFor(task);
}

function isGenericTitle(title: string): boolean {
  const normalized = title.trim().replace(/[：:：|/\\_-]+/g, " ").replace(/\s+/g, " ");
  if (!normalized) return true;
  if (GENERIC_TITLE_PATTERN.test(normalized)) return true;
  const tokens = normalized.toLocaleLowerCase().split(" ").filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => GENERIC_TITLE_WORDS.has(token));
}

function tokenizeTitle(title: string): string[] {
  return title
    .trim()
    .split(/[\s,，。.!！?？:：;；/\\|_-]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function titleSuggestion(title: string): string | undefined {
  const tokens = tokenizeTitle(title);
  if (tokens.length < 2) return undefined;
  // Chinese titles and version numbers are already readable; do not turn
  // “发布 2.2.0” into the misleading “发布220”.
  if (/[\u4e00-\u9fff]/u.test(title) && !/[a-z]/iu.test(title)) return undefined;
  const translated = tokens.map((token) => {
    const translatedToken = TITLE_TOKEN_TRANSLATIONS[token.toLocaleLowerCase()];
    return translatedToken ?? token;
  });
  const suggestion = translated.join("").replace(/\s+/g, "").trim();
  if (!suggestion || suggestion === title.trim() || suggestion.length < 4) return undefined;
  return suggestion;
}

export function classifySession(
  task: Pick<CodexMobileTaskBoardTask, "status" | "lastUpdatedAt">,
  nowMs = Date.now(),
  staleAfterDays = DEFAULT_STALE_AFTER_DAYS,
): SessionOrganizerSection {
  if (task.status === "error") return "error";
  if (task.status === "running") return "active";
  if (task.status === "approval" || task.status === "input") return "waiting";
  const lastUpdatedMs = parseTimestamp(task.lastUpdatedAt);
  const staleCutoff = nowMs - staleAfterDays * 24 * 60 * 60 * 1_000;
  return lastUpdatedMs > 0 && lastUpdatedMs < staleCutoff ? "stale" : "recent";
}

export function getTitleQuality(title: string): SessionOrganizerTitleQuality {
  const normalized = title.trim();
  if (!normalized || isGenericTitle(normalized)) return "missing";
  if (normalized.length < 6 || titleSuggestion(normalized) !== undefined) return "needsReview";
  return "clear";
}

export function buildSessionOrganizerSnapshot(
  tasks: CodexMobileTaskBoardTask[],
  options: { nowMs?: number; staleAfterDays?: number } = {},
): SessionOrganizerSnapshot {
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterDays = options.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const sessions: SessionOrganizerSession[] = tasks.map((task) => {
    const projectLabel = projectLabelFor(task);
    const titleQuality = getTitleQuality(task.title);
    const suggestion = titleQuality === "needsReview"
      ? titleSuggestion(task.title)
      : undefined;
    const renameReason = titleQuality === "missing"
      ? "标题过于笼统，建议打开会话后补充它正在解决的问题。"
      : suggestion
        ? "标题包含可标准化的英文缩写或分隔符。"
        : undefined;
    return {
      ...task,
      projectKey: projectKeyFor(task),
      projectLabel,
      section: classifySession(task, nowMs, staleAfterDays),
      titleQuality,
      ...(suggestion ? { renameSuggestion: suggestion } : {}),
      ...(renameReason ? { renameReason } : {}),
    };
  });

  const projectsByKey = new Map<string, SessionOrganizerProject>();
  for (const session of sessions) {
    const existing = projectsByKey.get(session.projectKey);
    const project: SessionOrganizerProject = existing ?? {
      projectKey: session.projectKey,
      projectLabel: session.projectLabel,
      ...(session.cwd ? { cwd: session.cwd } : {}),
      counts: { active: 0, waiting: 0, recent: 0, stale: 0, error: 0 },
      sessions: [],
    };
    project.sessions.push(session);
    project.counts[session.section] += 1;
    const currentLatest = parseTimestamp(project.latestActivityAt);
    if (parseTimestamp(session.lastUpdatedAt) > currentLatest) {
      project.latestActivityAt = session.lastUpdatedAt;
    }
    projectsByKey.set(session.projectKey, project);
  }

  const sectionOrder: Record<SessionOrganizerSection, number> = {
    active: 0,
    waiting: 1,
    recent: 2,
    error: 3,
    stale: 4,
  };
  const sortSessions = (left: SessionOrganizerSession, right: SessionOrganizerSession) => {
    const sectionDiff = sectionOrder[left.section] - sectionOrder[right.section];
    if (sectionDiff !== 0) return sectionDiff;
    return parseTimestamp(right.lastUpdatedAt) - parseTimestamp(left.lastUpdatedAt);
  };
  for (const project of projectsByKey.values()) project.sessions.sort(sortSessions);
  const projects = [...projectsByKey.values()].sort((left, right) => {
    const latestDiff = parseTimestamp(right.latestActivityAt) - parseTimestamp(left.latestActivityAt);
    if (latestDiff !== 0) return latestDiff;
    return left.projectLabel.localeCompare(right.projectLabel, "zh-CN");
  });

  const totals = {
    projects: projects.length,
    sessions: sessions.length,
    needsReview: sessions.filter((session) => session.titleQuality !== "clear").length,
    active: sessions.filter((session) => session.section === "active").length,
    waiting: sessions.filter((session) => session.section === "waiting").length,
    stale: sessions.filter((session) => session.section === "stale").length,
  };
  return {
    generatedAt: new Date(nowMs).toISOString(),
    staleAfterDays,
    projects,
    sessions: sessions.sort(sortSessions),
    totals,
  };
}
