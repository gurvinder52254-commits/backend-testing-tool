/**
 * ============================================================
 * microservices/worker/crawler.js — Link discovery
 * ============================================================
 * Reuses the monolith's proven discoverDomainUrls() so link
 * discovery behaves identically to the existing tool. Returns a
 * de-duplicated list of same-domain page URLs plus the header /
 * footer link sets for the report.
 * ============================================================
 */

const { discoverDomainUrls } = require('../../playwrightTester');

/**
 * @returns {Promise<{urls: Array<{url,text,source}>, headerLinks, footerLinks}>}
 */
async function discover(frontendUrl) {
  const discovered = await discoverDomainUrls(frontendUrl); // [{url, text, source}]
  const list = Array.isArray(discovered) ? discovered : [];

  const headerLinks = list.filter((l) => l.source === 'header');
  const footerLinks = list.filter((l) => l.source === 'footer');

  return { urls: list, headerLinks, footerLinks };
}

module.exports = { discover };
