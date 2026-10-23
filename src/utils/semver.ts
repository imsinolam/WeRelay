// Keep the full identity: preview.10 is newer than preview.2, while build
// metadata never changes precedence. Do not extract digits from prose.
const VERSION = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 256) return null;
  const value = raw.trim();
  const match = VERSION.exec(value);
  if (!match || match[4]?.split(".").some((part) => /^0\d+$/.test(part))) return null;
  return value.replace(/^v/, "");
}

function compareNumeric(a: string, b: string): number {
  return a.length === b.length ? (a === b ? 0 : a > b ? 1 : -1) : a.length > b.length ? 1 : -1;
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error("无法比较无效的语义版本号");
  const l = VERSION.exec(left)!;
  const r = VERSION.exec(right)!;
  for (const index of [1, 2, 3]) {
    const result = compareNumeric(l[index]!, r[index]!);
    if (result) return result;
  }
  if (l[4] === r[4]) return 0;
  if (l[4] === undefined) return 1;
  if (r[4] === undefined) return -1;
  const lp = l[4].split(".");
  const rp = r[4].split(".");
  for (let index = 0; index < Math.max(lp.length, rp.length); index++) {
    const x = lp[index];
    const y = rp[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return compareNumeric(x, y);
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
