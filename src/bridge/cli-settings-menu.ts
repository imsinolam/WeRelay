import { normalizeOutput } from "./bridge-utils.ts";
import type { BridgeSessionModelOption } from "./bridge-types.ts";
import { reasoningSettingLabel } from "./native-session-model-settings.ts";

/** Only choices printed by the original CLI are eligible for remote selection. */
export function parseCliSettingsMenu(text: string, kind: "model" | "effort"): {
  options: Array<BridgeSessionModelOption & { position: number }>; current?: string;
} {
  if (kind === "effort") {
    const lines = text.split(/\r?\n/);
    const choicesLine = lines.findLast((line) => /low/.test(line) && /medium/.test(line) && /high/.test(line));
    if (choicesLine) {
      // eslint-disable-next-line no-control-regex -- Native ANSI horizontal positions.
      const matches = [...choicesLine.matchAll(/\u001b\[(\d+)G(low|medium|high|xhigh|max)\b/g)];
      const markerLine = lines.findLast((line) => line.includes("▲"));
      // eslint-disable-next-line no-control-regex -- Native ANSI slider cursor.
      const marker = markerLine && /\u001b\[(\d+)G([^▲]*)▲/.exec(markerLine);
      const column = marker ? Number(marker[1]) + [...marker[2]!].length : undefined;
      const current = column !== undefined ? matches.reduce((best, match) => Math.abs(Number(match[1]) - column) < Math.abs(Number(best[1]) - column) ? match : best, matches[0]!)?.[2] : undefined;
      if (matches.length) return { options: matches.map((match, index) => ({ id: match[2]!, label: reasoningSettingLabel(match[2]!), position: index })), current };
      const plain = [...choicesLine.matchAll(/\b(low|medium|high|xhigh|max)\b/g)];
      const columnIndex = markerLine?.indexOf("▲");
      if (plain.length) return {
        options: plain.map((match, index) => ({ id: match[1]!, label: reasoningSettingLabel(match[1]!), position: index })),
        current: columnIndex !== undefined && columnIndex >= 0 ? plain.reduce((best, match) => Math.abs(match.index - columnIndex) < Math.abs(best.index - columnIndex) ? match : best, plain[0]!)?.[1] : undefined,
      };
    }
  }
  const options = new Map<string, BridgeSessionModelOption & { position: number }>();
  // eslint-disable-next-line no-control-regex -- Preserve native ANSI spacing before stripping styles.
  text = normalizeOutput(text.replace(/\u001b\[(\d*)C/g, (_all, count) => " ".repeat(Math.min(200, Number(count) || 1))));
  let current: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const row = /^\s*(?:[❯›>●✓✔]\s*)?(\d+)[.)]\s*(.+)$/.exec(line);
    if (!row?.[2] || /unavailable|not available|不可用|无法使用/i.test(row[2])) continue;
    const label = row[2].replace(/\s*[✓✔].*$/, "").replace(/\s*\((?:current|当前)\).*$/i, "").trim();
    const effort = /^(off|none|minimal|low|medium|high|xhigh|max|auto)\b/i.exec(label)?.[1]?.toLowerCase();
    const alias = /^(default|sonnet|opusplan|opus|haiku|fable|best)(?:\s*\d+(?:\.\d+)?)?(\[1m\])?/i.exec(label);
    const explicit = /\(([\w./:[\]-]+)\)/.exec(label)?.[1];
    const id = kind === "effort" ? effort : alias ? `${alias[1]!.toLowerCase()}${/1\s*m\s*context/i.test(label) && alias[1]!.toLowerCase() !== "default" ? "[1m]" : alias[2] ?? ""}` : explicit ?? /^([\w./:[\]-]+)(?:\s|$)/.exec(label)?.[1];
    if (!id || id.length > 240) continue;
    const modelLabel = alias ? alias[1]!.toLowerCase() === "default" ? "默认模型" : `${alias[1]!.charAt(0).toUpperCase()}${alias[1]!.slice(1).toLowerCase()}${id.endsWith("[1m]") ? "（1M 上下文）" : ""}` : label;
    options.set(id, { id, position: Number(row[1]), label: kind === "effort" ? reasoningSettingLabel(id) : modelLabel });
    if (/\bcurrent\b|当前|[✓✔]/i.test(line) || (!current && /^\s*[❯›>●]/.test(line))) current = id;
  }
  return { options: [...options.values()], current };
}
