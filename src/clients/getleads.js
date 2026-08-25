import { requestJson, withBackoff } from "../http.js";

export function createGetleads(config, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const base = config.getleadsBaseUrl;
  const key = config.getleadsApiKey;

  function headers() {
    return {
      authorization: `Bearer ${key}`,
      "x-api-key": key,
      accept: "application/json",
    };
  }

  async function listMonitoredProfiles() {
    const res = await withBackoff(() =>
      requestJson(`${base}/api/v1/profile-monitoring/profiles`, {
        fetchImpl,
        headers: headers(),
        timeoutMs: 30_000,
      }),
    );
    return res.json?.profiles || [];
  }

  async function listLeadsPage({ limit = 200, cursor } = {}) {
    const url = new URL(`${base}/api/v1/profile-monitoring/leads`);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await withBackoff(() =>
      requestJson(url.toString(), {
        fetchImpl,
        headers: headers(),
        timeoutMs: 45_000,
      }),
    );
    const body = res.json || {};
    return {
      leads: (body.leads || []).map(normalizeLead),
      nextCursor: body.next_cursor || body.nextCursor || null,
      total: body.total ?? null,
    };
  }

  async function listAllLeads({ limit = 200, onPage } = {}) {
    const all = [];
    let cursor;
    let pages = 0;
    for (;;) {
      const page = await listLeadsPage({ limit, cursor });
      pages += 1;
      all.push(...page.leads);
      await onPage?.({ pages, pulled: all.length, pageCount: page.leads.length });
      if (!page.nextCursor || !page.leads.length) break;
      cursor = page.nextCursor;
    }
    return { leads: all, pages };
  }

  return { listMonitoredProfiles, listLeadsPage, listAllLeads };
}

export function normalizeLead(raw) {
  const leadId = raw.leadId || raw.lead_id || null;
  return {
    dedupeKey: raw.dedupeKey || raw.dedupe_key || leadId,
    leadId,
    profileId: raw.profileId || raw.profile_id || null,
    authorLinkedinUrl: raw.authorLinkedinUrl || raw.author_linkedin_url || null,
    authorDisplayName: raw.authorDisplayName || raw.author_display_name || null,
    engagementType: raw.engagementType || raw.engagement_type || null,
    engagementDate: raw.engagementDate || raw.engagement_date || null,
    capturedAt: raw.capturedAt || raw.captured_at || null,
    postUrl: raw.postUrl || raw.post_url || null,
    postText: raw.postText || raw.post_text || null,
    postDate: raw.postDate || raw.post_date || null,
    engagerFirstName: raw.engagerFirstName || raw.engager_first_name || null,
    engagerLastName: raw.engagerLastName || raw.engager_last_name || null,
    engagerFullName: raw.engagerFullName || raw.engager_full_name || null,
    engagerLinkedinUrl: raw.engagerLinkedinUrl || raw.engager_linkedin_url || null,
    enrichmentStatus:
      raw.enrichmentStatus ||
      raw.enrichment_status ||
      (raw.engagerEmail || raw.engagerCompany ? "succeeded" : "failed"),
    enrichedAt: raw.enrichedAt || raw.enriched_at || null,
    engagerEmail: raw.engagerEmail || raw.engager_email || null,
    engagerCompany: raw.engagerCompany || raw.engager_company || null,
    engagerEmployees: cleanEmployees(raw.engagerEmployees || raw.engager_employees),
    engagerCity: raw.engagerCity || raw.engager_city || null,
    engagerCountry: raw.engagerCountry || raw.engager_country || null,
    engagerSeniority: raw.engagerSeniority || raw.engager_seniority || null,
    engagerFunction: raw.engagerFunction || raw.engager_function || null,
    engagerCompanyIndustry: raw.engagerCompanyIndustry || raw.engager_company_industry || null,
    engagerJobTitle: raw.engagerJobTitle || raw.engager_job_title || null,
    engagerHeadline: raw.engagerHeadline || raw.engager_headline || null,
    engagerCompanyWebsite: raw.engagerCompanyWebsite || raw.engager_company_website || null,
  };
}

const EMPTY_BANDS = new Set(["", "—", "–", "-", "unknown", "n/a", "na", "none", "null"]);

export function cleanEmployees(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s || EMPTY_BANDS.has(s.toLowerCase()) || EMPTY_BANDS.has(s)) return null;
  return s;
}

export function newerThanHwm(lead, hwmCapturedAt) {
  if (!hwmCapturedAt) return true;
  if (!lead.capturedAt) return true;
  return new Date(lead.capturedAt).getTime() > new Date(hwmCapturedAt).getTime();
}
