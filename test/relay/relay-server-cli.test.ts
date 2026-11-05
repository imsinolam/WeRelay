import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  parseRelayServerCliOptions,
} from "../../src/relay/relay-server-cli.ts";

describe("WeRelay relay server CLI", () => {
  test("defaults to a loopback listener without putting the device token in process arguments", () => {
    expect(parseRelayServerCliOptions(
      ["--host", "127.0.0.1", "--port", "14396", "--device-id", "example-device"],
      {
        WERELAY_RELAY_DEVICE_TOKEN: "server-secret",
        WERELAY_DATA_DIR: "/tmp/werelay-test",
      },
    )).toEqual({
      host: "127.0.0.1",
      port: 14396,
      deviceId: "example-device",
      deviceToken: "server-secret",
      allowNonLoopback: false,
      taskLinkStateFile: path.join("/tmp/werelay-test", "relay-task-links.json"),
      warmSnapshotFile: path.join("/tmp/werelay-test", "relay-warm-snapshot.bin"),
    });
  });

  test("allows overriding or disabling the encrypted warm snapshot", () => {
    expect(parseRelayServerCliOptions([], {
      WERELAY_RELAY_DEVICE_TOKEN: "server-secret",
      WERELAY_DATA_DIR: "/tmp/werelay-test",
      WERELAY_RELAY_WARM_SNAPSHOT_FILE: "/tmp/custom-snapshot.bin",
    }).warmSnapshotFile).toBe("/tmp/custom-snapshot.bin");
    expect(parseRelayServerCliOptions([], {
      WERELAY_RELAY_DEVICE_TOKEN: "server-secret",
      WERELAY_RELAY_WARM_SNAPSHOT_FILE: "off",
    }).warmSnapshotFile).toBeNull();
  });

  test("rejects wildcard and non-loopback listeners by default", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.20", "example.com"]) {
      expect(() => parseRelayServerCliOptions(
        ["--host", host],
        { WERELAY_RELAY_DEVICE_TOKEN: "server-secret" },
      )).toThrow("默认只允许监听本机回环地址");
    }
  });

  test("requires an explicit dangerous switch for a non-loopback listener", () => {
    expect(parseRelayServerCliOptions(
      ["--host", "0.0.0.0", "--allow-non-loopback"],
      { WERELAY_RELAY_DEVICE_TOKEN: "server-secret" },
    )).toMatchObject({
      host: "0.0.0.0",
      allowNonLoopback: true,
    });
  });

  test("requires a device token", () => {
    expect(() => parseRelayServerCliOptions([], {})).toThrow(
      "缺少 WERELAY_RELAY_DEVICE_TOKEN",
    );
  });
});
