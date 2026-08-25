import { bandFromEmployeeCount, hashedProfileId } from "../normalize.js";
import { withBackoff } from "../http.js";

export function splitLinkedinInputs(urls) {
  const vanity = [];
  const profileIds = [];
  for (const raw of urls) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const hashed = hashedProfileId(value);
    if (hashed) profileIds.push(hashed);
    else vanity.push(value.split("?")[0]);
  }
  return { urls: vanity, profileIds };
}

export function mapApifyProfile(item) {
  const current = item?.currentPosition?.[0] || {};
  const present = (item?.experience || []).find((e) => e.endDate?.text === "Present") || {};
  const companyObj = current.company || present.company || {};
  const company = current.companyName || present.companyName || companyObj.name || null;
  const title = current.position || present.position || item?.headline || null;
  const location =
    item?.location?.linkedinText || item?.location?.parsed?.text || null;
  const website =
    current.companyWebsite ||
    present.companyWebsite ||
    companyObj.website ||
    item?.companyWebsites?.[0]?.url ||
    null;
  const employees = bandFromEmployeeCount(
    companyObj.employeeCount ?? item?.employeeCount,
    companyObj.employeeCountRange ?? item?.employeeCountRange,
  );
  const profileId = item?.originalQuery?.profileId || item?.id || null;
  const query =
    item?.originalQuery?.profileId ||
    item?.originalQuery?.url ||
    item?.originalQuery?.query ||
    item?.linkedinUrl ||
    null;
  return {
    query,
    id: item?.id || null,
    profileId,
    publicIdentifier: item?.publicIdentifier || null,
    linkedinUrl: item?.linkedinUrl || null,
    company,
    companyLinkedinUrl: current.companyLinkedinUrl || present.companyLinkedinUrl || null,
    title,
    location,
    website,
    employees,
    headline: item?.headline || null,
    city: item?.location?.parsed?.city || null,
    country: item?.location?.parsed?.country || null,
  };
}

export function mapApifyCompany(item) {
  return {
    id: item?.id || null,
    linkedinUrl: item?.linkedinUrl || item?.url || null,
    universalName: item?.universalName || null,
    name: item?.name || null,
    website: item?.website || item?.websiteUrl || null,
    employees: bandFromEmployeeCount(item?.employeeCount, item?.employeeCountRange),
  };
}

export function createApify(config, deps = {}) {
  const clientFactory = deps.clientFactory;

  async function scrapeProfiles(urls, { timeout = 600, waitSecs = 660, maxTotalChargeUsd } = {}) {
    const { urls: vanity, profileIds } = splitLinkedinInputs(urls);
    if (!vanity.length && !profileIds.length) return { items: [], usageTotalUsd: 0, runId: null };

    if (!clientFactory && !config.apifyToken) {
      throw new Error("APIFY_TOKEN missing");
    }

    const run = await withBackoff(async () => {
      const { ApifyClient } = await import("apify-client");
      const client = clientFactory
        ? clientFactory()
        : new ApifyClient({ token: config.apifyToken });
      return client.actor(config.apifyActor).call(
        {
          profileScraperMode: "Profile details no email ($4 per 1k)",
          urls: vanity,
          profileIds,
        },
        { timeout, waitSecs, maxTotalChargeUsd },
      );
    });

    let items = [];
    if (deps.listItems) {
      items = await deps.listItems(run);
    } else {
      const { ApifyClient } = await import("apify-client");
      const client = clientFactory
        ? clientFactory()
        : new ApifyClient({ token: config.apifyToken });
      const listed = await client.dataset(run.defaultDatasetId).listItems();
      items = listed.items || [];
    }

    return {
      items: items.map(mapApifyProfile),
      usageTotalUsd: Number(run.usageTotalUsd || 0),
      chargedEventCounts: run.chargedEventCounts || {},
      runId: run.id || null,
    };
  }

  async function scrapeCompanies(urls, { timeout = 600, waitSecs = 660, maxTotalChargeUsd } = {}) {
    const companies = [
      ...new Set(
        (urls || [])
          .map((u) => String(u || "").trim().split("?")[0].replace(/\/+$/, ""))
          .filter((u) => /linkedin\.com\/company\//i.test(u)),
      ),
    ];
    if (!companies.length) return { items: [], usageTotalUsd: 0, runId: null };
    if (!clientFactory && !config.apifyToken) {
      throw new Error("APIFY_TOKEN missing");
    }

    const run = await withBackoff(async () => {
      const { ApifyClient } = await import("apify-client");
      const client = clientFactory
        ? clientFactory()
        : new ApifyClient({ token: config.apifyToken });
      return client.actor(config.apifyCompanyActor || "harvestapi/linkedin-company").call(
        { companies },
        { timeout, waitSecs, maxTotalChargeUsd },
      );
    });

    let items = [];
    if (deps.listCompanyItems) {
      items = await deps.listCompanyItems(run);
    } else {
      const { ApifyClient } = await import("apify-client");
      const client = clientFactory
        ? clientFactory()
        : new ApifyClient({ token: config.apifyToken });
      const listed = await client.dataset(run.defaultDatasetId).listItems();
      items = listed.items || [];
    }

    return {
      items: items.map(mapApifyCompany),
      usageTotalUsd: Number(run.usageTotalUsd || 0),
      chargedEventCounts: run.chargedEventCounts || {},
      runId: run.id || null,
    };
  }

  return { scrapeProfiles, scrapeCompanies };
}
