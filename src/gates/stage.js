import { formatLocation } from "../clients/smartlead.js";
import { normalizeEmail } from "../util/email.js";

export function toStagingRow(row) {
  const email = normalizeEmail(row.engager_email);
  const location = formatLocation(row);
  const linkedin = row.engager_linkedin_url || null;
  const staged = {
    campaign_id: Number(row.campaign_id),
    campaign_name: row.campaign_name || null,
    email,
    first_name: row.first_name_n || null,
    last_name: row.engager_last_name || null,
    company_name: row.company_n || null,
    location: location || null,
    imported: false,
    source_dedupe_key: row.dedupe_key,
  };
  if (linkedin) staged.linkedin_profile = linkedin;
  return staged;
}

export async function stageVerified(supabase, rows) {
  const staged = [];
  const errors = [];
  for (const row of rows) {
    if (!row.campaign_id || !normalizeEmail(row.engager_email) || !row.dedupe_key) {
      errors.push({
        row,
        patch: { status: "error", routing_note: "missing campaign_id, email, or dedupe_key" },
      });
      continue;
    }
    const payload = toStagingRow(row);
    const { error } = await supabase.from("leads_staging").upsert(payload, {
      onConflict: "source_dedupe_key",
      ignoreDuplicates: false,
    });
    if (error) {
      errors.push({
        row,
        patch: { status: "error", routing_note: String(error.message || "stage failed").slice(0, 500) },
      });
      continue;
    }
    staged.push({
      row,
      patch: { status: "staged" },
    });
  }
  return { staged, errors };
}
