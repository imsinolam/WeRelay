const personalProductionDomainSuffix = ["sinolin", "com"].join(".");

export function containsPersonalProductionDomain(text, { allowMarketingWebsite = false } = {}) {
  // Only the user-approved HTTPS marketing root is public. Task links, API paths,
  // other subdomains and plain hostnames remain forbidden.
  if (allowMarketingWebsite) {
    const website = `https://${["werelay", personalProductionDomainSuffix].join(".")}/`;
    const escaped = website.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`${escaped}(?=$|[\\s"'<>\\)\\]])`, "g"), "https://project.example/");
  }
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
