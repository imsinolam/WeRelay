const personalProductionDomainSuffix = ["sinolin", "com"].join(".");

export function isPrivateWebsitePath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  return /^(?:website|docs\/官网素材|[Ww]e[Rr]elay-website-private)(?:\/|$)/.test(normalized) ||
    normalized === "scripts/generate-brand-logo.mjs";
}

export function containsPersonalProductionDomain(text) {
  for (const match of text.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi)) {
    const hostname = match[0].toLowerCase();
    if (
      hostname === personalProductionDomainSuffix ||
      hostname.endsWith(`.${personalProductionDomainSuffix}`)
    ) {
      return true;
    }
  }
  return false;
}
