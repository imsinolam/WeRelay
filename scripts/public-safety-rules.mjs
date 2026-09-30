const personalProductionDomainSuffix = ["sinolin", "com"].join(".");

export function containsPersonalProductionDomain(text, { allowMarketingWebsite = false } = {}) {
  // Only the user-approved marketing root and exact public demo-video URL are
  // public. Task links, arbitrary asset/API paths and other hosts stay forbidden.
  if (allowMarketingWebsite) {
    const website = `https://${["werelay", personalProductionDomainSuffix].join(".")}/`;
    const approvedUrls = [website, `${website}__website/assets/media/WeRelay-60s-Film.mp4`];
    for (const url of approvedUrls) {
      const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(new RegExp(`${escaped}(?=$|[\\s"'<>\\)\\]])`, "g"), "https://project.example/");
    }
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
