import { cleanSizeBand, sizeBandStatus } from "./normalize.js";
import { applyResolvedFields, resolveCompanies, resolveEmails } from "./resolve.js";
import { markByDedupeKeys, fetchByStatus } from "./inbox.js";
import { loadSpend } from "./spend.js";
import { loadSuppressionMap } from "./gates/suppression.js";
import { emailDomain, isEmail, normalizeEmail } from "./util/email.js";

function realEmail(...candidates) {
  for (const value of candidates) {
    if (isEmail(value)) return value;
  }
  return "";
}

export function nextParkedStatus(row, lead) {
  const email = realEmail(lead.engagerEmail, row.engager_email);
  const company = lead.engagerCompany || row.engager_company;
  const band = cleanSizeBand(lead.engagerEmployees || row.engager_employees);
  const campaignId = row.campaign_id;
  return sizeBandStatus(band, company, email, campaignId);
}

export async function runParkedResolution({ supabase, config, apify, waterfall, log }) {
  const rows = await fetchByStatus(supabase, ["needs_email", "needs_company_data"], {
    limit: config.enrichmentBatchLimit,
    orders: [
      ["resolution_attempts", { ascending: true }],
      ["last_resolution_at", { ascending: true, nullsFirst: true }],
      ["id", { ascending: true }],
    ],
  });
  const stats = { claimed: rows.length, updated: 0, unresolvable: 0, error: 0, cap_hit: false };
  if (!rows.length) return stats;

  const suppression = await loadSuppressionMap(supabase);
  const spend = await loadSpend(supabase);
  const leads = rows.map((row) => ({
    dedupeKey: row.dedupe_key,
    leadId: row.lead_id,
    profileId: row.profile_id,
    authorLinkedinUrl: row.author_linkedin_url,
    engagerFirstName: row.engager_first_name,
    engagerLastName: row.engager_last_name,
    engagerFullName: row.engager_full_name,
    engagerLinkedinUrl: row.engager_linkedin_url,
    engagerEmail: isEmail(row.engager_email) ? row.engager_email : "",
    engagerCompany: row.engager_company,
    engagerEmployees: row.engager_employees,
    engagerCity: row.engager_city,
    engagerCountry: row.engager_country,
    engagerJobTitle: row.engager_job_title,
    engagerCompanyWebsite: row.company_domain ? `https://${row.company_domain}` : null,
    companyDomain: row.company_domain,
    resolutionAttempts: row.resolution_attempts || 0,
  }));

  const company = await resolveCompanies({
    leads,
    apify,
    config,
    spend,
    supabase,
    log,
    cap: config.monthlySpendCapCents,
  });
  const email = await resolveEmails({
    leads: company.leads,
    waterfall,
    config,
    spend: company.spend,
    supabase,
    log,
    cap: config.monthlySpendCapCents,
  });
  stats.cap_hit = company.stats.skipped_cap > 0 || email.stats.skipped_cap > 0;

  const byKey = new Map(email.leads.map((l) => [l.dedupeKey, applyResolvedFields(l)]));
  for (const row of rows) {
    const lead = byKey.get(row.dedupe_key);
    const attempts = (row.resolution_attempts || 0) + 1;
    const domain = emailDomain(realEmail(lead?.engagerEmail));
    if (domain && suppression.has(domain)) {
      await markByDedupeKeys(supabase, [row.dedupe_key], {
        status: "suppressed",
        routing_note: `suppressed: domain ${domain}`,
        resolution_attempts: attempts,
        last_resolution_at: new Date().toISOString(),
      });
      stats.updated += 1;
      continue;
    }
    const status = nextParkedStatus(row, lead || {});
    const exhausted =
      attempts >= config.maxResolutionAttempts &&
      (status === "needs_email" || status === "needs_company_data");
    const patch = {
      engager_email: realEmail(lead?.engagerEmail, row.engager_email) || row.engager_email,
      engager_company: lead?.engagerCompany || row.engager_company,
      engager_job_title: lead?.engagerJobTitle || row.engager_job_title,
      engager_city: lead?.engagerCity || row.engager_city,
      engager_country: lead?.engagerCountry || row.engager_country,
      company_domain: lead?.companyDomain || row.company_domain,
      company_source: lead?.companySource || row.company_source,
      employment_mismatch: Boolean(lead?.employmentMismatch),
      first_name_n: lead?.first_name_n || row.first_name_n,
      company_n: lead?.company_n || row.company_n,
      resolution_attempts: attempts,
      last_resolution_at: new Date().toISOString(),
      status: exhausted ? "unresolvable" : status,
      routing_note: exhausted
        ? `unresolvable after ${attempts} attempts`
        : lead?.employmentMismatch
          ? "employment mismatch; trusted linkedin"
          : row.routing_note,
    };
    await markByDedupeKeys(supabase, [row.dedupe_key], patch);
    if (exhausted) stats.unresolvable += 1;
    else stats.updated += 1;
  }

  log.info("parked resolution", stats);
  return stats;
}
