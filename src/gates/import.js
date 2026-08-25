import { toSmartleadLead } from "../clients/smartlead.js";

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

export async function importStaged({ rows, smartlead, chunkSize = 200, onMismatch }) {
  const imported = [];
  const mismatches = [];
  const errors = [];
  const skippedCampaigns = new Set();
  const byCampaign = groupByCampaign(rows);

  for (const [campaignId, campaignRows] of byCampaign) {
    if (skippedCampaigns.has(campaignId)) continue;
    for (const part of chunk(campaignRows, chunkSize)) {
      if (skippedCampaigns.has(campaignId)) break;
      try {
        const result = await smartlead.addLeads(campaignId, part.map(toSmartleadLead));
        if (result.uploadCount === part.length) {
          for (const row of part) {
            imported.push({
              row,
              patch: { status: "imported", processed_at: new Date().toISOString() },
            });
          }
        } else {
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
        }
      } catch (err) {
        for (const row of part) {
          errors.push({
            row,
            patch: { status: "error", routing_note: String(err.message || "import failed").slice(0, 500) },
          });
        }
      }
    }
  }

  return { imported, mismatches, errors, skippedCampaigns: [...skippedCampaigns] };
}
