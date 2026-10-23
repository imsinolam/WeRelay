import { compareVersions, parseVersion } from "./semver.ts";

export const WERELAY_GITHUB_REPO = "imsinolam/WeRelay";
const TAG_ROOT = `https://github.com/${WERELAY_GITHUB_REPO}/releases/tag/`;
const API = `https://api.github.com/repos/${WERELAY_GITHUB_REPO}/releases?per_page=100`;
const FEED = `https://github.com/${WERELAY_GITHUB_REPO}/releases.atom`;
const MAX_BYTES = 2 * 1024 * 1024;

export type PublishedRelease = {
  version: string;
  tagName: string;
  prerelease: boolean;
  url: string;
};

export function releaseFromTag(tagName: unknown, prerelease = false): PublishedRelease | null {
  const version = parseVersion(tagName);
  if (!version || (tagName !== version && tagName !== `v${version}`)) return null;
  return {
    version,
    tagName: tagName as string,
    prerelease: prerelease || version.split("+")[0]!.includes("-"),
    url: `${TAG_ROOT}${encodeURIComponent(tagName as string)}`,
  };
}

// Cached metadata is untrusted too: never substitute a branch or arbitrary URL.
export function validatePublishedRelease(value: unknown): PublishedRelease | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (typeof data.url !== "string" || !data.url.startsWith(TAG_ROOT)) return null;
  try {
    const tagName = decodeURIComponent(data.url.slice(TAG_ROOT.length));
    const release = releaseFromTag(tagName, data.prerelease === true);
    return release && release.version === data.version && release.url === data.url &&
      (data.tagName === undefined || data.tagName === release.tagName) ? release : null;
  } catch { return null; }
}

async function requestText(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          headers: { Accept: "application/vnd.github+json, application/atom+xml", "User-Agent": "WeRelay-Update-Checker" },
        });
        if (!response.ok) { controller.abort(); return null; }
        const reader = response.body?.getReader();
        if (!reader) {
          const text = await response.text();
          return Buffer.byteLength(text) <= MAX_BYTES ? text : null;
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > MAX_BYTES) { controller.abort(); return null; }
            chunks.push(value);
          }
          return Buffer.concat(chunks).toString("utf8");
        } finally { reader.releaseLock(); }
      })(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
      }),
    ]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function latest(releases: PublishedRelease[]): PublishedRelease | null {
  return releases.sort((a, b) => compareVersions(b.version, a.version) ||
    Number(a.prerelease) - Number(b.prerelease) || a.tagName.localeCompare(b.tagName))[0] ?? null;
}

/** Only published Releases qualify. Neither tags nor main are fallback channels. */
export async function fetchLatestPublishedRelease(options: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<PublishedRelease | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeout = options.timeoutMs ?? 10_000;
  const api = await requestText(API, fetchImpl, timeout);
  if (api !== null) {
    try {
      const data: unknown = JSON.parse(api);
      if (Array.isArray(data)) {
        return latest(data.slice(0, 100).flatMap((item: unknown) => {
          if (!item || typeof item !== "object") return [];
          const release = item as Record<string, unknown>;
          if (release.draft) return [];
          const candidate = releaseFromTag(release.tag_name, release.prerelease === true);
          return candidate ? [candidate] : [];
        }));
      }
    } catch { /* Use the feed when the API is unavailable or malformed. */ }
  }
  // Includes prereleases, without the REST API's unauthenticated quota.
  // /releases/latest would silently drop preview releases again.
  const feed = await requestText(FEED, fetchImpl, timeout);
  if (!feed) return null;
  const releases: PublishedRelease[] = [];
  for (const entry of feed.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
    for (const link of entry[1]!.matchAll(/<link\b([^>]+)\/?\s*>/g)) {
      const attrs = link[1]!;
      const rel = /\brel=["']([^"']*)["']/.exec(attrs)?.[1];
      if (rel && rel !== "alternate") continue;
      const href = /\bhref=["']([^"']*)["']/.exec(attrs)?.[1];
      if (!href?.startsWith(TAG_ROOT)) continue;
      try {
        const candidate = releaseFromTag(decodeURIComponent(href.slice(TAG_ROOT.length)));
        if (candidate) releases.push(candidate);
      } catch { /* Invalid encoded tag. */ }
    }
    if (releases.length >= 100) break;
  }
  return latest(releases);
}
