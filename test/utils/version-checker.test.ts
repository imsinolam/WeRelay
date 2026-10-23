import { describe, expect, test } from "bun:test";

import {
  compareVersions,
  fetchLatestVersion,
  parseVersion,
} from "../../src/utils/version-checker.ts";

function buildFetchMock(releases: unknown, apiStatus = 200, feed = "<feed></feed>") {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    return url.includes("api.github.com")
      ? Response.json(releases, { status: apiStatus }) : new Response(feed);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("parseVersion", () => {
  test("提取纯数字版本号", () => {
    expect(parseVersion("1.1.1")).toBe("1.1.1");
  });

  test("兼容 v 前缀", () => {
    expect(parseVersion("v1.2.3")).toBe("1.2.3");
  });

  test("trim 后提取", () => {
    expect(parseVersion("  2.0.0  ")).toBe("2.0.0");
  });

  test("保留预发布和构建标识，不把不同预览版压成同一版本", () => {
    expect(parseVersion("v2.0.0-rc.1")).toBe("2.0.0-rc.1");
    expect(parseVersion("0.3.21-preview.10+build.2")).toBe("0.3.21-preview.10+build.2");
    expect(parseVersion("anything0.3.21")).toBeNull();
    expect(parseVersion("0.3.21-preview.01")).toBeNull();
  });

  test("无版本号返回 null", () => {
    expect(parseVersion("garbage")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });

  test("非字符串返回 null", () => {
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(123)).toBeNull();
  });
});

describe("compareVersions", () => {
  test("大于返回正数", () => {
    expect(compareVersions("1.1.1", "1.1.0")).toBeGreaterThan(0);
  });

  test("小于返回负数", () => {
    expect(compareVersions("1.0.0", "1.1.0")).toBeLessThan(0);
  });

  test("相等返回 0", () => {
    expect(compareVersions("1.1.1", "1.1.1")).toBe(0);
  });

  test("主版本号差异优先", () => {
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });

  test("预发布逐段按语义版本比较，不降级也不忽略数字尾号", () => {
    expect(compareVersions("0.3.21-preview.10", "0.3.21-preview.2")).toBeGreaterThan(0);
    expect(compareVersions("0.3.21", "0.3.21-preview.10")).toBeGreaterThan(0);
    expect(compareVersions("0.3.21-preview.1", "0.3.20")).toBeGreaterThan(0);
    expect(compareVersions("0.3.20", "0.3.21-preview.1")).toBeLessThan(0);
    expect(compareVersions("0.3.21+build.2", "0.3.21+build.1")).toBe(0);
  });
});

describe("fetchLatestVersion", () => {
  test("CLI 与微信一致读取已发布正式版和预发布版", async () => {
    const { fetch, calls } = buildFetchMock([
      { tag_name: "v0.4.0" }, { tag_name: "v0.4.1-preview.2", prerelease: true },
    ]);
    expect(await fetchLatestVersion({ fetchImpl: fetch })).toBe("0.4.1-preview.2");
    expect(calls).toEqual(["https://api.github.com/repos/imsinolam/WeRelay/releases?per_page=100"]);
  });
  test("仅有草稿或没有 Release 时不读 tag/main 冒充已发布", async () => {
    const { fetch, calls } = buildFetchMock([{ tag_name: "v9.0.0", draft: true }]);
    expect(await fetchLatestVersion({ fetchImpl: fetch })).toBeNull();
    expect(calls).toHaveLength(1);
  });
  test("API 限流时使用发布 feed，仍能发现预发布", async () => {
    const { fetch, calls } = buildFetchMock({}, 403,
      '<feed><entry><link href="https://github.com/imsinolam/WeRelay/releases/tag/v0.4.1-rc.3"/></entry></feed>');
    expect(await fetchLatestVersion({ fetchImpl: fetch })).toBe("0.4.1-rc.3");
    expect(calls[1]).toContain("releases.atom");
  });
  test("两个发布入口均不可用时返回 null", async () => {
    const { fetch } = buildFetchMock({}, 500, "not xml");
    expect(await fetchLatestVersion({ fetchImpl: fetch })).toBeNull();
  });
  test("请求超时返回 null 且不挂起", async () => {
    const fetch = (async (_url: unknown, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof globalThis.fetch;
    expect(await fetchLatestVersion({ fetchImpl: fetch, timeoutMs: 20 })).toBeNull();
  });
});
