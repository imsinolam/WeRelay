import { describe, expect, test } from "bun:test";

import {
  compareVersions,
  fetchLatestVersion,
  parseVersion,
} from "../../src/utils/version-checker.ts";

type RouteConfig = {
  release?: unknown;
  tags?: unknown;
  packageJson?: unknown;
  releaseStatus?: number;
  tagsStatus?: number;
  packageStatus?: number;
};

// 可注入的 fetch mock：按 GitHub 路由返回结果，并记录调用顺序。
function buildFetchMock(routes: RouteConfig): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch = (async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.includes("/releases/latest")) {
      const status = routes.releaseStatus ?? 200;
      const body = routes.release === undefined ? "" : JSON.stringify(routes.release);
      return new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/tags?")) {
      const status = routes.tagsStatus ?? 200;
      const body = routes.tags === undefined ? "" : JSON.stringify(routes.tags);
      return new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("raw.githubusercontent.com")) {
      const status = routes.packageStatus ?? 200;
      const body = routes.packageJson === undefined
        ? ""
        : JSON.stringify(routes.packageJson);
      return new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
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

  test("从预发布标识中提取主版本号", () => {
    expect(parseVersion("v2.0.0-rc.1")).toBe("2.0.0");
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
});

describe("fetchLatestVersion", () => {
  test("优先读取 GitHub 最新 Release", async () => {
    const { fetch, calls } = buildFetchMock({
      release: { tag_name: "v0.4.0" },
    });
    const latest = await fetchLatestVersion({ fetchImpl: fetch });
    expect(latest).toBe("0.4.0");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("api.github.com");
    expect(calls[0]).toContain("/releases/latest");
    expect(calls.some((url) => url.includes("registry.npmjs.org"))).toBe(false);
  });

  test("没有 Release 时从 GitHub tags 取最高版本", async () => {
    const { fetch, calls } = buildFetchMock({
      releaseStatus: 404,
      tags: [{ name: "0.3.3" }, { name: "v0.3.4" }, { name: "0.2.9" }],
    });
    const latest = await fetchLatestVersion({ fetchImpl: fetch });
    expect(latest).toBe("0.3.4");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("/tags?");
  });

  test("没有 Release 和 tag 时读取 GitHub main 的 package.json", async () => {
    const { fetch, calls } = buildFetchMock({
      releaseStatus: 404,
      tags: [],
      packageJson: { version: "0.3.4" },
    });
    const latest = await fetchLatestVersion({ fetchImpl: fetch });
    expect(latest).toBe("0.3.4");
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain("raw.githubusercontent.com");
  });

  test("无效 Release 会继续尝试 tags", async () => {
    const { fetch } = buildFetchMock({
      release: { tag_name: "not-a-version" },
      tags: [{ name: "v0.3.5" }],
    });
    const latest = await fetchLatestVersion({ fetchImpl: fetch });
    expect(latest).toBe("0.3.5");
  });

  test("GitHub 三个公开版本入口都失败时返回 null", async () => {
    const { fetch } = buildFetchMock({
      releaseStatus: 500,
      tagsStatus: 503,
      packageStatus: 404,
    });
    const latest = await fetchLatestVersion({ fetchImpl: fetch });
    expect(latest).toBeNull();
  });

  test("请求超时返回 null 且不挂起", async () => {
    const fetch = (async (
      _url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as typeof fetch;
    const latest = await fetchLatestVersion({ fetchImpl: fetch, timeoutMs: 20 });
    expect(latest).toBeNull();
  });
});
