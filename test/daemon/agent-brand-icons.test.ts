import { describe, expect, test } from "bun:test";
import { BRIDGE_PROVIDER_IDS } from "../../src/bridge/bridge-providers.ts";
import { AGENT_BRAND_ICON_DATA } from "../../src/daemon/agent-brand-icons.ts";

function decodeSvg(id: (typeof BRIDGE_PROVIDER_IDS)[number]): string {
  const data = AGENT_BRAND_ICON_DATA[id];
  expect(data.startsWith("data:image/svg+xml,")).toBe(true);
  return decodeURIComponent(data.slice("data:image/svg+xml,".length));
}

describe("Magpie standard Agent icons", () => {
  test("bundles an icon for every bridge provider", () => {
    for (const id of BRIDGE_PROVIDER_IDS) {
      expect(AGENT_BRAND_ICON_DATA[id].startsWith("data:image/svg+xml,")).toBe(true);
    }
  });

  test("keeps every data URI self-contained and free of executable content", () => {
    for (const id of BRIDGE_PROVIDER_IDS) {
      const svg = decodeSvg(id);
      expect(svg).toMatch(/^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)?<svg\b/);
      expect(svg).toContain("</svg>");
      expect(svg).not.toMatch(/<script\b/i);
      expect(svg).not.toMatch(/\son[a-z]+\s*=/i);
      expect(svg).not.toMatch(/\b(?:href|src)\s*=\s*["'](?:https?:)?\/\//i);
      expect(svg).not.toMatch(/\burl\(\s*["']?(?:https?:)?\/\//i);
    }
  });

  test("keeps Pi distinct from shell and pairs Pi Desktop with the Pi mark", () => {
    expect(AGENT_BRAND_ICON_DATA.pi).not.toBe(AGENT_BRAND_ICON_DATA.shell);
    expect(AGENT_BRAND_ICON_DATA["pi-desktop"]).toBe(AGENT_BRAND_ICON_DATA.pi);
    expect(decodeSvg("pi")).toContain("<title>Pi</title>");
  });

  test("uses the Claude Code mark for both Claude Code adapters", () => {
    expect(AGENT_BRAND_ICON_DATA.tclaude).toBe(AGENT_BRAND_ICON_DATA.claude);
    const svg = decodeSvg("claude");
    expect(svg).toContain("<title>Claude Code</title>");
    expect(svg).toContain('fill="#D97757"');
    expect(svg).not.toContain("<title>Claude</title>");
  });

  test("uses the standard WorkBuddy application SVG", () => {
    const svg = decodeSvg("workbuddy");
    expect(svg).toContain('width="64.0003"');
    expect(svg).toContain('height="64"');
    expect(svg).toContain('stop-color="#0EC7A8"');
    expect(svg).toContain('stop-color="#00C885"');
  });
});
