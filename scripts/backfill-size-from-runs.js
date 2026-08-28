import { ApifyClient } from "apify-client";
import { createApify, mapApifyProfile } from "../src/clients/apify.js";
import { loadConfig } from "../src/config.js";
import { markByDedupeKeys } from "../src/inbox.js";
import { createLogger } from "../src/logger.js";
import { applyProfileItem, matchApifyItem, resolveCompanySizes } from "../src/resolve.js";
import { nextParkedStatus } from "../src/parked.js";
import { addSpend, loadSpend } from "../src/spend.js";
import { createSupabase } from "../src/supabase.js";

const log = createLogger("sg-backfill-size");

async function loadRunItems(client, runId) {
  const run = await client.run(runId).get();
  const listed = await client.dataset(run.defaultDatasetId).listItems();
  return (listed.items || []).map(mapApifyProfile);
}

async function main(env = process.env, argv = process.argv) {
  const runIds = argv.slice(2).filter((id) => !id.startsWith("-"));
  if (!runIds.length) throw new Error("usage: node scripts/backfill-size-from-runs.js <runId> [runId...]");

  const config = loadConfig(env);
  const supabase = createSupabase(config);
  const apify = createApify(config);
  const client = new ApifyClient({ token: config.apifyToken });

  const { data: rows, error } = await supabase
    .from("sg_engager_inbox")
    .select("*")
    .eq("status", "needs_company_data")
    .not("last_resolution_at", "is", null);
  if (error) throw new Error(error.message);

  const items = [];
  for (const runId of runIds) {
    const part = await loadRunItems(client, runId);
    log.info("loaded apify run", { run_id: runId, items: part.length });
    items.push(...part);
  }

  const leads = (rows || []).map((row) => ({
    dedupeKey: row.dedupe_key,
    engagerCompany: row.engager_company,
    engagerEmployees: row.engager_employees,
    engagerEmail: row.engager_email,
    engagerLinkedinUrl: row.engager_linkedin_url,
    engagerJobTitle: row.engager_job_title,
    engagerCity: row.engager_city,
    engagerCountry: row.engager_country,
    companyDomain: row.company_domain,
    campaignId: row.campaign_id,
    _row: row,
  }));

  let matched = 0;
  for (const lead of leads) {
    const item = matchApifyItem(lead, items);
    if (applyProfileItem(lead, item) || lead.companyLinkedinUrl) matched += 1;
  }
  log.info("profile remap", { rows: leads.length, matched, with_company_url: leads.filter((l) => l.companyLinkedinUrl).length });

  const stats = { attempted: 0, resolved: 0, skipped_cap: 0, errors: 0, spend_cents: 0 };
  const spend = await loadSpend(supabase);
  await resolveCompanySizes({
    leads,
    apify,
    config,
    spend,
    supabase,
    log,
    stats,
  });

  let updated = 0;
  const byStatus = {};
  for (const lead of leads) {
    const row = lead._row;
    const status = nextParkedStatus(row, lead);
    byStatus[status] = (byStatus[status] || 0) + 1;
    await markByDedupeKeys(supabase, [row.dedupe_key], {
      engager_email: lead.engagerEmail || row.engager_email,
      engager_company: lead.engagerCompany || row.engager_company,
      engager_job_title: lead.engagerJobTitle || row.engager_job_title,
      engager_city: lead.engagerCity || row.engager_city,
      engager_country: lead.engagerCountry || row.engager_country,
      engager_employees: lead.engagerEmployees || row.engager_employees,
      company_domain: lead.companyDomain || row.company_domain,
      company_source: lead.companySource || row.company_source,
      first_name_n: row.first_name_n,
      company_n: row.company_n,
      resolution_attempts: 1,
      last_resolution_at: new Date().toISOString(),
      status,
      routing_note: status === "needs_company_data" ? "size missing after company scrape" : null,
    });
    updated += 1;
  }

  const spendAfter = await addSpend(supabase, "apify", 0);
  log.info("backfill complete", { updated, matched, by_status: byStatus, company_stats: stats, spend_cents: spendAfter.spendCents });
}

main().catch((err) => {
  log.error("fatal", { error: err.message });
  process.exit(1);
});
