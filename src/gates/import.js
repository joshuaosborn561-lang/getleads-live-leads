import { toSmartleadLead } from "../clients/smartlead.js";
import { sleep } from "../http.js";

export function alreadyAddedCount(result) {
  const body = result?.body || {};
  const raw = body.already_added_to_campaign ?? body.data?.already_added_to_campaign ?? result?.alreadyAdded;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function importChunkAccepted(result, submitted) {
  const uploaded = Number(result?.uploadCount);
  const already = alreadyAddedCount(result);
  const up = Number.isFinite(uploaded) ? uploaded : 0;
  return up === submitted || already === submitted || up + already === submitted;
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function groupByCampaign(rows) {
  const map = new Map();
  for (const row of rows) {
    const id = Number(row.campaign_id);
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  return map;
}

export async function importStaged({
  rows,
  smartlead,
  chunkSize = 200,
  onMismatch,
  pauseMs = 0,
  retry429 = 4,
  retryDelayMs = 8_000,
}) {
  const imported = [];
  const mismatches = [];
  const errors = [];
  const skippedCampaigns = new Set();
  const byCampaign = groupByCampaign(rows);

  for (const [campaignId, campaignRows] of byCampaign) {
    if (skippedCampaigns.has(campaignId)) continue;
    for (const part of chunk(campaignRows, chunkSize)) {
      if (skippedCampaigns.has(campaignId)) break;
      let lastErr = null;
      let accepted = false;
      for (let attempt = 0; attempt <= retry429; attempt += 1) {
        try {
          const result = await smartlead.addLeads(campaignId, part.map(toSmartleadLead));
          if (importChunkAccepted(result, part.length)) {
            for (const row of part) {
              imported.push({
                row,
                patch: { status: "imported", processed_at: new Date().toISOString() },
              });
            }
            accepted = true;
            break;
          }
          skippedCampaigns.add(campaignId);
          for (const row of part) {
            mismatches.push({
              row,
              patch: {
                status: "import_mismatch",
                routing_note: `upload_count=${result.uploadCount} submitted=${part.length}`,
              },
            });
          }
          await onMismatch?.({
            campaign_id: campaignId,
            submitted: part.length,
            upload_count: result.uploadCount,
          });
          accepted = true;
          break;
        } catch (err) {
          lastErr = err;
          const retryable = /HTTP 429/.test(String(err.message || ""));
          if (!retryable || attempt === retry429) break;
          await sleep(retryDelayMs * 2 ** attempt);
        }
      }
      if (!accepted && lastErr) {
        for (const row of part) {
          errors.push({
            row,
            patch: { status: "error", routing_note: String(lastErr.message || "import failed").slice(0, 500) },
          });
        }
      }
      if (pauseMs && !skippedCampaigns.has(campaignId)) await sleep(pauseMs);
    }
  }

  return { imported, mismatches, errors, skippedCampaigns: [...skippedCampaigns] };
}
