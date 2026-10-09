import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MobileRemoteAccess, normalizeMobileRemoteUrl, isPublicRelayAddress,
  checkMobileRemoteConnection,
} from "../../src/daemon/mobile-remote-access.ts";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function stateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-settings-"));
  directories.push(dir);
  return path.join(dir, "private", "remote.json");
}
const config = { relayUrl: "https://relay.example.com", deviceId: "default", deviceToken: "test-pairing-secret-only" };
const input = { enabled: true, serverUrl: config.relayUrl, deviceId: config.deviceId, deviceToken: config.deviceToken };

describe("remote access settings", () => {
  test("accepts HTTPS origin only and rejects local, private and embedded credentials", async () => {
    expect(normalizeMobileRemoteUrl(" https://relay.example.com/ ")).toBe(config.relayUrl);
    for (const url of ["http://relay.example.com", "https://localhost", "https://a.local", "https://127.1", "https://2130706433", "https://10.0.0.1", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://user:secret@relay.example.com", "https://relay.example.com/admin", "https://relay.example.com/?token=x", "https://relay.example.com/#x"]) {
      expect(() => normalizeMobileRemoteUrl(url)).toThrow();
    }
    for (const ip of ["127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:192.0.2.1", "2002:7f00:1::", "2001:0:1234::"]) expect(isPublicRelayAddress(ip)).toBe(false);
    expect(isPublicRelayAddress("2606:4700:4700::1111")).toBe(true);
    await expect(checkMobileRemoteConnection({ ...config, relayUrl: "https://127.0.0.1" })).rejects.toThrow("公网 HTTPS");
  });

  test("checking never persists, starts a connection, or returns the key", async () => {
    const file = stateFile(); let checks = 0; let applies = 0;
    const access = new MobileRemoteAccess({ stateFile: file, check: async () => { checks++; }, apply: async () => { applies++; } });
    const view = await access.change(input, true);
    expect(checks).toBe(1); expect(applies).toBe(0); expect(fs.existsSync(file)).toBe(false);
    expect(view.enabled).toBe(false); expect(JSON.stringify(view)).not.toContain(config.deviceToken);
  });

  test("saves privately, restores after restart and persists disabling over environment settings", async () => {
    const file = stateFile(); const applied: unknown[] = [];
    const options = { stateFile: file, check: async () => {}, apply: async (value: unknown) => { applied.push(value); } };
    const access = new MobileRemoteAccess(options);
    await access.change(input);
    expect(applied).toEqual([config]);
    // POSIX permission bits have no equivalent meaning on Windows.
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
    const restored = new MobileRemoteAccess(options);
    expect(restored.activeConfig()).toEqual(config);
    restored.setConnectionStatus("connected"); expect(restored.view().status).toBe("connected");
    await restored.change({ enabled: false });
    expect(restored.view()).toMatchObject({ enabled: false, hasToken: true, status: "disabled" });
    expect(new MobileRemoteAccess({ ...options, environmentConfig: config }).activeConfig()).toBeNull();
    expect(JSON.stringify(restored.view())).not.toContain(config.deviceToken);
    await restored.change({ ...input, deviceToken: "" });
    expect(restored.activeConfig()).toEqual(config);
  });

  test("blank keys are reusable only for the exact same origin and device", async () => {
    const access = new MobileRemoteAccess({ stateFile: stateFile(), environmentConfig: config, check: async () => {}, apply: async () => {} });
    await access.change({ ...input, deviceToken: "" }, true);
    await expect(access.change({ ...input, deviceToken: "", serverUrl: "https://another.example.com" }, true)).rejects.toThrow("连接密钥");
    await expect(access.change({ ...input, deviceToken: "", deviceId: "another" }, true)).rejects.toThrow("连接密钥");
    await expect(access.change({ ...input, deviceToken: "test-secret\ninvalid" })).rejects.toThrow("连接密钥");
  });

  test("failed validation leaves old configuration untouched and busy requests conflict", async () => {
    const file = stateFile(); let finish!: () => void;
    const access = new MobileRemoteAccess({ stateFile: file, environmentConfig: config, check: () => new Promise<void>((resolve) => { finish = resolve; }), apply: async () => {} });
    const pending = access.change(input, true);
    await expect(access.change({ enabled: false })).rejects.toMatchObject({ statusCode: 409 });
    finish(); await pending;
    expect(fs.existsSync(file)).toBe(false);
    const failing = new MobileRemoteAccess({ stateFile: file, environmentConfig: config, check: async () => { throw new Error("test failure"); }, apply: async () => {} });
    await expect(failing.change(input)).rejects.toThrow("test failure");
    expect(failing.activeConfig()).toEqual(config); expect(fs.existsSync(file)).toBe(false);
  });

  test("failed apply rolls back disk and attempts the old live configuration", async () => {
    const file = stateFile(); const applied: unknown[] = [];
    const access = new MobileRemoteAccess({ stateFile: file, environmentConfig: config, check: async () => {}, apply: async (value) => { applied.push(value); if (!value) throw new Error("test failure"); } });
    await expect(access.change({ enabled: false })).rejects.toThrow("已还原保存的配置");
    expect(fs.existsSync(file)).toBe(false); expect(access.activeConfig()).toEqual(config);
    expect(applied).toEqual([null, config]);
  });

  test("failed replacement preserves a previously saved configuration exactly", async () => {
    const file = stateFile();
    const access = new MobileRemoteAccess({ stateFile: file, check: async () => {}, apply: async (value) => {
      if (value?.relayUrl === "https://replacement.example.com") throw new Error("cannot apply");
    } });
    await access.change(input);
    const before = fs.readFileSync(file, "utf8");
    await expect(access.change({ ...input, serverUrl: "https://replacement.example.com" })).rejects.toThrow("已还原保存的配置");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(access.activeConfig()).toEqual(config);
  });

  test("saved settings override environment; invalid saved data never falls back to environment", async () => {
    const file = stateFile();
    const options = { stateFile: file, environmentConfig: config, apply: async () => {}, check: async () => {} };
    expect(new MobileRemoteAccess(options).view().source).toBe("environment");
    await new MobileRemoteAccess(options).change({ ...input, serverUrl: "https://saved.example.com" });
    expect(new MobileRemoteAccess(options).publicUrl()).toBe("https://saved.example.com");
    fs.writeFileSync(file, "invalid");
    expect(() => new MobileRemoteAccess(options)).toThrow("远程访问配置无法读取");
  });

  test("localhost display preference persists without touching the relay or freezing environment defaults", async () => {
    const file = stateFile(); let applies = 0; let checks = 0;
    const options = { stateFile: file, environmentConfig: config, apply: async () => { applies++; }, check: async () => { checks++; } };
    const access = new MobileRemoteAccess(options);
    access.setConnectionStatus("connected");
    await access.change({ showLocalLink: true });
    expect(access.view()).toMatchObject({ enabled: true, configured: true, showLocalLink: true, status: "connected", source: "environment" });
    expect(applies).toBe(0); expect(checks).toBe(0);
    const restarted = new MobileRemoteAccess({ ...options, environmentConfig: { ...config, relayUrl: "https://next.example.com" } });
    expect(restarted.view().showLocalLink).toBe(true);
    expect(restarted.publicUrl()).toBe("https://next.example.com");
    await restarted.change({ enabled: false });
    expect(restarted.view()).toMatchObject({ showLocalLink: true, configured: true, enabled: false });
    await restarted.change({ showLocalLink: false });
    expect(restarted.view().enabled).toBe(false);
  });

  test("never-configured state remains introductory after changing link visibility", async () => {
    const access = new MobileRemoteAccess({ stateFile: stateFile(), apply: async () => {} });
    expect(access.view()).toMatchObject({ configured: false, showLocalLink: false });
    await access.change({ showLocalLink: true });
    expect(access.view()).toMatchObject({ configured: false, enabled: false });
    await expect(access.change({ showLocalLink: "true" })).rejects.toThrow();
    await expect(access.change({ showLocalLink: true }, true)).rejects.toThrow();
  });

  test("legacy HTTP environment settings can be disabled without preventing the next startup", async () => {
    const file = stateFile();
    const options = { stateFile: file, environmentConfig: { ...config, relayUrl: "http://legacy.example.com" }, apply: async () => {} };
    await new MobileRemoteAccess(options).change({ enabled: false });
    expect(new MobileRemoteAccess(options).view().enabled).toBe(false);
  });
});
