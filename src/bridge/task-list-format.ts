import path from "node:path";

import type { BridgeResumeSessionCandidate } from "./bridge-types.ts";
import { formatTaskListDisplayTitle } from "./task-list-display.ts";

function isGeneratedCodexWorkspace(cwd: string | undefined): boolean {
  if (!cwd) return false;
  const segments = cwd.split(/[\\/]+/).filter(Boolean);
  return segments.some(
    (segment, index) =>
      segment.toLowerCase() === "codex" &&
      /^\d{4}-\d{2}-\d{2}$/.test(segments[index + 1] ?? "") &&
      Boolean(segments[index + 2]),
  );
}

export function resolveTaskProjectName(
  candidate: Pick<BridgeResumeSessionCandidate, "projectName" | "cwd">,
): string {
  const explicitName = candidate.projectName?.trim();
  if (explicitName) return explicitName;
  if (!candidate.cwd || isGeneratedCodexWorkspace(candidate.cwd)) return "";
  return path.basename(candidate.cwd).trim();
}

export function formatTaskProjectLabel(
  candidate: Pick<BridgeResumeSessionCandidate, "projectName" | "cwd">,
): string {
  const projectName = resolveTaskProjectName(candidate);
  return projectName ? `[${formatTaskListDisplayTitle(projectName, 36)}] ` : "";
}
