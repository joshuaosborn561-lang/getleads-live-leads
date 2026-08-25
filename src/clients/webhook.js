import { requestJson, sleep, withBackoff } from "../http.js";

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function toWebhookLead(lead) {
  return {
    dedupeKey: lead.dedupeKey || lead.leadId,
    leadId: lead.leadId || null,
    profileId: lead.profileId || null,
    authorLinkedinUrl: lead.authorLinkedinUrl || null,
    authorDisplayName: lead.authorDisplayName || null,
    engagementType: lead.engagementType || null,
    engagementDate: lead.engagementDate || null,
    postUrl: lead.postUrl || null,
    postText: lead.postText || null,
    postDate: lead.postDate || null,
    engagerFirstName: lead.engagerFirstName || null,
    engagerLastName: lead.engagerLastName || null,
    engagerFullName: lead.engagerFullName || null,
    engagerLinkedinUrl: lead.engagerLinkedinUrl || null,
    enrichmentStatus: lead.enrichmentStatus || null,
    enrichedAt: lead.enrichedAt || null,
    engagerEmail: lead.engagerEmail || null,
    engagerCompany: lead.engagerCompany || null,
    engagerEmployees: lead.engagerEmployees || null,
    engagerCity: lead.engagerCity || null,
    engagerCountry: lead.engagerCountry || null,
    engagerSeniority: lead.engagerSeniority || null,
    engagerFunction: lead.engagerFunction || null,
    engagerCompanyIndustry: lead.engagerCompanyIndustry || null,
  };
}

export function createWebhook(config, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  function url() {
    const u = new URL(config.webhookUrl);
    u.searchParams.set("token", config.webhookToken);
    return u.toString();
  }

  async function postBatch(leads) {
    const res = await withBackoff(
      () =>
        requestJson(url(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ leads: leads.map(toWebhookLead) }),
          fetchImpl,
          timeoutMs: 60_000,
        }),
      { attempts: 3, delaysMs: [1000, 3000, 8000] },
    );
    return res.json || {};
  }

  async function postAll(leads, { chunkSize = config.webhookChunkSize, delayMs = config.webhookDelayMs, onBatch } = {}) {
    const summary = { posted: 0, failed_batches: 0, failed_count: 0, by_lane: {}, by_status: {} };
    for (const part of chunk(leads, chunkSize)) {
      try {
        const body = await postBatch(part);
        summary.posted += part.length;
        mergeCounts(summary.by_lane, body.by_lane);
        mergeCounts(summary.by_status, body.by_status);
        await onBatch?.({ ok: true, count: part.length, body });
      } catch {
        summary.failed_batches += 1;
        summary.failed_count += part.length;
        await onBatch?.({ ok: false, count: part.length });
      }
      if (delayMs) await sleep(delayMs);
    }
    return summary;
  }

  return { postBatch, postAll };
}

function mergeCounts(into, from) {
  if (!from || typeof from !== "object") return;
  for (const [k, v] of Object.entries(from)) {
    into[k] = (into[k] || 0) + Number(v || 0);
  }
}
