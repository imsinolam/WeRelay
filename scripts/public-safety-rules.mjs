const personalProductionDomainSuffix = ["sinolin", "com"].join(".");

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
