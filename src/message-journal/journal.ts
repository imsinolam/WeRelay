import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writePrivateFileAtomic } from "../utils/private-files.ts";

export const JOURNAL_AGENTS = ["codex", "pi", "pi-desktop", "workbuddy", "dsh", "claude"] as const;
type Agent = typeof JOURNAL_AGENTS[number];
type Permissions = { version: 1; agents: Agent[] };
type Message = { agent: string; id: string; text: string; [key: string]: unknown };
type ScanResult = { messages: Message[]; sources: Array<Record<string, unknown>>; [key: string]: unknown };
export type MessageJournal = ReturnType<typeof createMessageJournal>;

export function createMessageJournal(options: {
  permissionFile: string;
  roots?: Array<{ agent: string; root: string }>;
  scan?: () => Promise<ScanResult>;
  refreshMs?: number;
}) {
  const refreshMs = Math.max(15_000, options.refreshMs ?? 60_000);
  let permissions: Permissions = { version: 1, agents: [] };
  try {
    const value = JSON.parse(fs.readFileSync(options.permissionFile, "utf8"));
    if (value.version === 1 && Array.isArray(value.agents)) {
      permissions.agents = JOURNAL_AGENTS.filter(agent => value.agents.includes(agent));
    }
  } catch { /* Missing or unreadable consent fails closed. */ }
  let generation = 0;
  let latest: ScanResult | null = null;
  let pending: Promise<void> | null = null;
  let lastScan = 0;
  let error = "";
  let scanner: { run(): Promise<ScanResult> } | undefined;

  function reads() {
    // Supply an explicit permission entry for every supported source.
    return { asked: true, all: false, agents: Object.fromEntries(JOURNAL_AGENTS.map(agent => [agent, permissions.agents.includes(agent)])) };
  }
  async function scan() {
    if (options.scan) return options.scan();
    if (!scanner) {
      const modulePath = fileURLToPath(new URL("../../vendor/message-journal/src/scanner.mjs", import.meta.url));
      const { createScanner } = await import(pathToFileURL(modulePath).href);
      scanner = createScanner({
        lookbackDays: 30,
        ...(options.roots ? { roots: options.roots } : {}),
        getReads: async () => reads(),
        allowedAgent: (_reads: unknown, agent: Agent) => permissions.agents.includes(agent),
      });
    }
    return scanner!.run();
  }
  function startScan() {
    if (pending || !permissions.agents.length) return;
    const startedGeneration = generation;
    pending = (async () => {
      try {
        const result = await scan();
        if (generation === startedGeneration) { latest = result; error = ""; lastScan = Date.now(); }
      } catch {
        if (generation === startedGeneration) { latest = null; error = "索引读取失败，请稍后刷新。"; lastScan = Date.now(); }
      }
    })().finally(() => { pending = null; });
  }
  return {
    setPermissions(agents: unknown) {
      if (!Array.isArray(agents) || agents.some(agent => !JOURNAL_AGENTS.includes(agent))) throw new Error("请选择有效的消息来源。");
      const next: Permissions = { version: 1, agents: JOURNAL_AGENTS.filter(agent => agents.includes(agent)) };
      writePrivateFileAtomic(options.permissionFile, JSON.stringify(next));
      permissions = next; generation++; latest = null; lastScan = 0; error = ""; scanner = undefined;
    },
    async read(waitForScan = true) {
      if (permissions.agents.length && Date.now() - lastScan >= refreshMs) startScan();
      if (waitForScan) await pending;
      const agents = new Set<string>(permissions.agents);
      // Keep responses bounded for the application relay, without persisting message bodies.
      let bytes = 0;
      const messages: Message[] = [];
      let truncated = false;
      for (const message of latest?.messages ?? []) {
        if (!agents.has(message.agent)) continue;
        const item = { ...message, text: message.text.slice(0, 30_000) };
        const size = Buffer.byteLength(JSON.stringify(item));
        if (messages.length >= 10_000 || bytes + size > 12 * 1024 * 1024) { truncated = true; break; }
        messages.push(item); bytes += size;
      }
      return {
        version: 1, generatedAt: lastScan, lookbackDays: 30, refreshMs,
        loading: Boolean(pending) && !latest && agents.size > 0,
        messages,
        sources: JOURNAL_AGENTS.map(agent => agents.has(agent)
          ? latest?.sources.find(source => source.agent === agent) ?? { agent, status: "ok", messages: 0 }
          : { agent, status: "disabled", messages: 0 }),
        permissions: structuredClone(permissions), classifications: {},
        error: error || (truncated ? "消息较多，仅展示最近的一部分；完整记录仍保留在原 Agent。" : ""),
      };
    },
  };
}
