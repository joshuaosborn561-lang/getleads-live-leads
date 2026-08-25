import { normalizeEmail } from "../util/email.js";

export function applyInboxDedupe(rows, existing = []) {
  const firstIdByEmail = new Map();
  for (const row of existing) {
    const email = normalizeEmail(row.engager_email);
    if (!email) continue;
    const id = Number(row.id);
    const prev = firstIdByEmail.get(email);
    if (prev == null || id < prev) firstIdByEmail.set(email, id);
  }

  const duplicates = [];
  const remaining = [];
  const seenThisBatch = new Map();

  const ordered = [...rows].sort((a, b) => Number(a.id) - Number(b.id));
  for (const row of ordered) {
    const email = normalizeEmail(row.engager_email);
    if (!email) {
      remaining.push(row);
      continue;
    }
    const earlierExisting = firstIdByEmail.get(email);
    const earlierBatch = seenThisBatch.get(email);
    if ((earlierExisting != null && earlierExisting < Number(row.id)) || earlierBatch != null) {
      duplicates.push({
        row,
        patch: { status: "duplicate", routing_note: "duplicate inbox email" },
      });
      continue;
    }
    seenThisBatch.set(email, Number(row.id));
    remaining.push(row);
  }
  return { duplicates, remaining };
}

export async function applySmartleadDedupe(rows, smartlead) {
  const duplicates = [];
  const remaining = [];
  for (const row of rows) {
    const campaignId = row.campaign_id;
    const email = normalizeEmail(row.engager_email);
    if (!campaignId || !email) {
      remaining.push(row);
      continue;
    }
    try {
      const present = await smartlead.campaignHasEmail(campaignId, email);
      if (present) {
        duplicates.push({
          row,
          patch: { status: "duplicate", routing_note: "already in smartlead campaign" },
        });
        continue;
      }
      remaining.push(row);
    } catch (err) {
      remaining.push({ ...row, __error: err.message || "smartlead lookup failed" });
    }
  }
  const errors = remaining.filter((r) => r.__error);
  const ok = remaining.filter((r) => !r.__error);
  return { duplicates, remaining: ok, errors };
}
