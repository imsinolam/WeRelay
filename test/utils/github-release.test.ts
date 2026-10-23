import { expect, test } from "bun:test";
import { fetchLatestPublishedRelease } from "../../src/utils/github-release.ts";

const root = "https://github.com/imsinolam/WeRelay/releases/tag/";

test("published releases include previews, sort full versions, and exclude drafts", async () => {
  const calls: string[] = [];
  const release = await fetchLatestPublishedRelease({ fetchImpl: (async (input: string | URL | Request) => {
    calls.push(String(input));
    return Response.json([
      { tag_name: "v0.3.20", prerelease: false },
      { tag_name: "v0.3.21-preview.20261024.2", prerelease: true },
      { tag_name: "v0.3.21-preview.20261024.10", prerelease: true, html_url: "https://evil.example" },
      { tag_name: "v0.3.22", draft: true },
      { tag_name: "main" },
    ]);
  }) as typeof fetch });
  expect(release).toEqual({
    version: "0.3.21-preview.20261024.10", tagName: "v0.3.21-preview.20261024.10",
    prerelease: true, url: `${root}v0.3.21-preview.20261024.10`,
  });
  expect(calls).toEqual(["https://api.github.com/repos/imsinolam/WeRelay/releases?per_page=100"]);
});

test("stable beats its own prerelease and unprefixed tags keep their real identity", async () => {
  const release = await fetchLatestPublishedRelease({ fetchImpl: (async () => Response.json([
    { tag_name: "v0.3.21-rc.3", prerelease: true }, { tag_name: "0.3.21" },
  ])) as typeof fetch });
  expect(release).toMatchObject({ version: "0.3.21", tagName: "0.3.21", url: `${root}0.3.21`, prerelease: false });
});

test("rate-limited API falls back to Atom including previews, never tags/main/latest-stable", async () => {
  const calls: string[] = [];
  const release = await fetchLatestPublishedRelease({ fetchImpl: (async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    if (url.includes("api.github.com")) return new Response("limited", { status: 403 });
    return new Response(`<?xml version="1.0"?><feed>
      <entry><link rel="alternate" href="${root}v0.3.20"/></entry>
      <entry><link href="${root}v0.3.21-preview.3" rel="alternate"/></entry>
      <entry><link href="https://evil.example/imsinolam/WeRelay/releases/tag/v99.0.0"/></entry>
      <entry><link href="${root}main"/></entry>
    </feed>`);
  }) as typeof fetch });
  expect(release?.version).toBe("0.3.21-preview.3");
  expect(calls).toEqual([
    "https://api.github.com/repos/imsinolam/WeRelay/releases?per_page=100",
    "https://github.com/imsinolam/WeRelay/releases.atom",
  ]);
});

test("draft-only catalogs do not turn an unpublished tag or branch into an update", async () => {
  const calls: string[] = [];
  const result = await fetchLatestPublishedRelease({ fetchImpl: (async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    return url.includes("api.github.com")
      ? Response.json([{ tag_name: "v9.0.0", draft: true }, { tag_name: "../0.3.21" }])
      : new Response("<feed></feed>");
  }) as typeof fetch });
  expect(result).toBeNull();
  expect(calls.some((url) => /\/tags\?|raw\.githubusercontent|\/releases\/latest/.test(url))).toBe(false);
});

test("stalled response bodies time out just like stalled headers", async () => {
  let aborts = 0;
  const result = await fetchLatestPublishedRelease({ timeoutMs: 10, fetchImpl: (async (_input: unknown, options: RequestInit) => ({
    ok: true,
    text: () => new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => {
      aborts++; reject(new Error("aborted"));
    }, { once: true })),
  })) as unknown as typeof fetch });
  expect(result).toBeNull();
  expect(aborts).toBe(2);
});


test("feed accepts raw plus signs but returns a canonical encoded release URL", async () => {
  const release = await fetchLatestPublishedRelease({ fetchImpl: (async (input: unknown) =>
    String(input).includes("api.github.com") ? new Response("limited", { status: 403 })
      : new Response(`<feed><entry><link href="${root}v0.3.21-rc.1+build.2"/></entry></feed>`)) as typeof fetch });
  expect(release?.version).toBe("0.3.21-rc.1+build.2");
  expect(release?.url).toBe(`${root}v0.3.21-rc.1%2Bbuild.2`);
});
