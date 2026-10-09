import type { BridgeAdapter } from "./bridge-types.ts";
import { ClaudeCompanionAdapter } from "./bridge-adapters.claude.ts";
import { CodeBuddyAcpAdapter } from "./bridge-adapters.codebuddy.ts";
import { LocalCompanionProxyAdapter } from "./bridge-adapters.core.ts";
import { CodexPtyAdapter } from "./bridge-adapters.codex.ts";
import { DeepSeekHarnessAdapter } from "./bridge-adapters.deepseek.ts";
import {
  GrokAcpAdapter,
  readGrokStoredSessionMessages,
} from "./bridge-adapters.grok.ts";
import { OpenCodeServerAdapter } from "./bridge-adapters.opencode.ts";
import { ReasonixServerAdapter } from "./bridge-adapters.reasonix.ts";
import { PiOwnerAdapter } from "./bridge-adapters.pi.ts";
import { ShellAdapter } from "./bridge-adapters.shell.ts";
import { WorkBuddyDesktopAdapter } from "./bridge-adapters.workbuddy.ts";
import type { AdapterOptions } from "./bridge-adapters.shared.ts";
import { isClaudeProviderKind } from "./bridge-providers.ts";

export * from "./bridge-adapters.shared.ts";

export function createBridgeAdapter(options: AdapterOptions): BridgeAdapter {
  if (isClaudeProviderKind(options.kind)) {
    return options.renderMode === "companion"
      ? new ClaudeCompanionAdapter(options)
      : new LocalCompanionProxyAdapter(options);
  }
  switch (options.kind) {
    case "codex":
      return options.renderMode === "panel"
        ? new CodexPtyAdapter(options)
        : new LocalCompanionProxyAdapter(options);
    case "opencode":
      return options.renderMode === "companion"
        ? new OpenCodeServerAdapter(options)
        : new LocalCompanionProxyAdapter(options);
    case "grok":
      return options.renderMode === "companion"
        ? new GrokAcpAdapter(options)
        : new LocalCompanionProxyAdapter(options, {
            readSessionMessages: readGrokStoredSessionMessages,
          });
    case "codebuddy":
      return options.renderMode === "companion"
        ? new CodeBuddyAcpAdapter(options)
        : new LocalCompanionProxyAdapter(options);
    case "reasonix":
      return options.renderMode === "companion"
        ? new ReasonixServerAdapter(options)
        : new LocalCompanionProxyAdapter(options);
    case "pi":
      return options.renderMode === "companion"
        ? new PiOwnerAdapter(options)
        : new LocalCompanionProxyAdapter(options);
    case "workbuddy":
      return new WorkBuddyDesktopAdapter(options);
    case "deepseek":
      return new DeepSeekHarnessAdapter(options);
    case "shell":
      return new ShellAdapter(options);
    default:
      throw new Error(`Unsupported adapter: ${options.kind}`);
  }
}
