import { describe, expect, test } from "bun:test";

import {
  DAEMON_PROVIDER_IDS,
  getBridgeProvider,
  isBridgeAdapterKind,
  isClaudeProviderKind,
  isDaemonAdapterKind,
  listDaemonProviders,
  providerRequiresVisibleClient,
  providerUsesHarnessHost,
} from "../../src/bridge/bridge-providers.ts";
import { createBridgeAdapter } from "../../src/bridge/bridge-adapters.ts";
import { LocalCompanionProxyAdapter } from "../../src/bridge/bridge-adapters.core.ts";
import { resolveDefaultAdapterCommand } from "../../src/bridge/bridge-adapters.shared.ts";

describe("bridge provider registry", () => {
  test("exposes implemented shared-owner and WorkBuddy Desktop providers", () => {
    expect(getBridgeProvider("grok")).toMatchObject({
      transport: "shared_service",
      sessionIntegration: {
        owner: "shared_service_owner",
        continuity: "same_owner",
        localVisibility: "live",
      },
    });
    expect(getBridgeProvider("workbuddy").transport).toBe("desktop_app");
    expect(getBridgeProvider("codebuddy")).toMatchObject({
      transport: "shared_service",
      sessionIntegration: {
        owner: "shared_service_owner",
        continuity: "same_owner",
        localVisibility: "live",
      },
    });
    expect(isBridgeAdapterKind("grok")).toBe(true);
    expect(isBridgeAdapterKind("codebuddy")).toBe(true);
    expect(isBridgeAdapterKind("reasonix")).toBe(true);
    expect(isDaemonAdapterKind("grok")).toBe(true);
    expect(isDaemonAdapterKind("codebuddy")).toBe(true);
    expect(isDaemonAdapterKind("reasonix")).toBe(true);
    expect(isBridgeAdapterKind("workbuddy")).toBe(true);
    expect(isBridgeAdapterKind("deepseek")).toBe(true);
    expect(isDaemonAdapterKind("workbuddy")).toBe(true);
    expect(DAEMON_PROVIDER_IDS).toContain("workbuddy");
    expect(DAEMON_PROVIDER_IDS).toContain("reasonix");
    expect(DAEMON_PROVIDER_IDS).toContain("deepseek");
    expect(getBridgeProvider("deepseek")).toMatchObject({
      label: "DSH",
      command: "dsh",
      transport: "harness_host",
      sessionIntegration: {
        owner: "shared_service_owner",
        continuity: "same_owner",
        localVisibility: "live",
      },
    });
    expect(getBridgeProvider("reasonix")).toMatchObject({
      label: "reasonix",
      command: "reasonix",
      transport: "shared_service",
      sessionIntegration: {
        owner: "shared_service_owner",
        continuity: "same_owner",
        localVisibility: "live",
      },
    });
    expect(resolveDefaultAdapterCommand("reasonix")).toBe("reasonix");
    expect(resolveDefaultAdapterCommand("deepseek")).toBe("dsh");
  });

  test("treats TClaude as an implemented Claude-compatible daemon provider", () => {
    expect(getBridgeProvider("claude")).toMatchObject({
      label: "Claude Code",
      capabilities: {
        nativeCommands: true,
      },
    });
    expect(isBridgeAdapterKind("tclaude")).toBe(true);
    expect(isDaemonAdapterKind("tclaude")).toBe(true);
    expect(isClaudeProviderKind("tclaude")).toBe(true);
    expect(DAEMON_PROVIDER_IDS).toContain("tclaude");
    expect(resolveDefaultAdapterCommand("tclaude")).toBe("tclaude");
    expect(getBridgeProvider("tclaude").capabilities.nativeCommands).toBe(true);
  });

  test("never starts a second hidden owner for same-owner terminal providers", () => {
    for (const kind of [
      "claude",
      "tclaude",
      "grok",
      "codebuddy",
      "reasonix",
      "opencode",
    ] as const) {
      expect(createBridgeAdapter({
        kind,
        command: getBridgeProvider(kind).command,
        cwd: "/tmp/werelay-owner-contract",
      })).toBeInstanceOf(LocalCompanionProxyAdapter);
      expect(getBridgeProvider(kind).sessionIntegration).toMatchObject({
        continuity: "same_owner",
        localVisibility: "live",
      });
    }
  });

  test("declares a dependency graph for every provider", () => {
    for (const provider of listDaemonProviders()) {
      expect(Array.isArray(provider.dependencies)).toBe(true);
      for (const dep of provider.dependencies) {
        if (dep.kind === "command") {
          expect(dep.name.length).toBeGreaterThan(0);
          expect(dep.hint.length).toBeGreaterThan(0);
        } else if (dep.kind === "port") {
          expect(dep.port).toBeGreaterThan(0);
          expect(dep.hint.length).toBeGreaterThan(0);
        } else if (dep.kind === "app") {
          expect(dep.path.length).toBeGreaterThan(0);
          expect(dep.hint.length).toBeGreaterThan(0);
        } else if (dep.kind === "env") {
          expect(dep.name.length).toBeGreaterThan(0);
          expect(dep.hint.length).toBeGreaterThan(0);
        } else {
          throw new Error(`unknown dependency kind for ${provider.id}`);
        }
      }
    }
  });

  test("marks optional dependencies separately and only exposes predefined installers", () => {
    const codex = getBridgeProvider("codex");
    const codexCommand = codex.dependencies.find(
      (dep) => dep.kind === "command" && dep.name === "codex",
    );
    const codexApp = codex.dependencies.find((dep) => dep.kind === "app");
    expect(codexCommand).toMatchObject({
      id: "codex-cli",
      install: {
        command: "npm",
        args: ["install", "-g", "@openai/codex"],
      },
    });
    expect(codexCommand).toMatchObject({ alternativeGroup: "codex-runtime" });
    expect(codexApp).toMatchObject({ alternativeGroup: "codex-runtime" });

    const claude = getBridgeProvider("claude");
    expect(claude.dependencies.find(
      (dep) => dep.kind === "command" && dep.name === "tclaude",
    )).toMatchObject({ required: false });

    for (const provider of listDaemonProviders()) {
      for (const dependency of provider.dependencies) {
        if (dependency.install) {
          expect(dependency.kind).toBe("command");
          expect(dependency.id.length).toBeGreaterThan(0);
          expect(dependency.install.command).toMatch(/^[A-Za-z0-9._-]+$/);
          expect(dependency.install.args.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("deepseek harness depends on the local harness host without opening a companion terminal", () => {
    const provider = getBridgeProvider("deepseek");
    expect(providerUsesHarnessHost("deepseek")).toBe(true);
    expect(providerRequiresVisibleClient("deepseek")).toBe(false);
    const portDeps = provider.dependencies.filter((dep) => dep.kind === "port");
    expect(portDeps.some((dep) => dep.kind === "port" && dep.port === 3080)).toBe(true);
    expect(provider.dependencies.some((dep) => dep.kind === "command" && dep.name === "dsh")).toBe(true);
  });
});
