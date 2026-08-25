import { requestJson, withBackoff } from "../http.js";

function leadsFromBody(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.leads)) return body.leads;
  if (body.data && Array.isArray(body.data.leads)) return body.data.leads;
  if (body.id || body.email) return [body];
  return [];
}

export function extractUploadCount(body) {
  if (!body || typeof body !== "object") return null;
  const raw = body.upload_count ?? body.data?.upload_count;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function createSmartlead(config, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const base = config.smartleadBaseUrl;
  const key = config.smartleadApiKey;

  function url(path, extra = {}) {
    const u = new URL(`${base}${path}`);
    u.searchParams.set("api_key", key);
    for (const [k, v] of Object.entries(extra)) {
      if (v != null) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async function campaignHasEmail(campaignId, email) {
    const res = await withBackoff(() =>
      requestJson(url(`/campaigns/${campaignId}/leads`, { email }), {
        fetchImpl,
        timeoutMs: 30_000,
      }),
    );
    return leadsFromBody(res.json).length > 0;
  }

  async function addLeads(campaignId, leadList) {
    const res = await withBackoff(() =>
      requestJson(url(`/campaigns/${campaignId}/leads`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lead_list: leadList }),
        fetchImpl,
        timeoutMs: 60_000,
      }),
    );
    return {
      body: res.json || {},
      uploadCount: extractUploadCount(res.json),
      submitted: leadList.length,
    };
  }

  return { campaignHasEmail, addLeads };
}

export function toSmartleadLead(row) {
  const lead = {
    email: row.email || row.engager_email,
    first_name: row.first_name || row.first_name_n || null,
    last_name: row.last_name || row.engager_last_name || null,
    company_name: row.company_name || row.company_n || null,
  };
  const linkedin = row.linkedin_profile || row.engager_linkedin_url;
  const location = row.location || formatLocation(row);
  if (linkedin) lead.linkedin_profile = linkedin;
  if (location) lead.location = location;
  return lead;
}

export function formatLocation(row) {
  const parts = [row.engager_city, row.engager_country].filter((p) => p && String(p).trim());
  return parts.length ? parts.join(", ") : row.location || null;
}
