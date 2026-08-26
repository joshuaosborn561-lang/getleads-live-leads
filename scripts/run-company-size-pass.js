import { createGetleads } from "../src/clients/getleads.js";
import { chunk } from "../src/clients/webhook.js";
import { createWaterfall } from "../src/clients/waterfall.js";
import { loadConfig } from "../src/config.js";
import { countsByStatus, markByDedupeKeys } from "../src/inbox.js";
import { createLogger } from "../src/logger.js";
import { nextParkedStatus } from "../src/parked.js";
import { cleanSizeBand } from "../src/normalize.js";
import {
  applyWaterfallHit,
  companyDomainOf,
  readWaterfallCompanies,
  sizeFromCompanyHit,
  uniqueCompanyLeads,
  waterfallRowOf,
} from "../src/resolve.js";
import { loadSpend } from "../src/spend.js";
import { createSupabase, throwIfError } from "../src/supabase.js";
import { isEmail } from "../src/util/email.js";

const log = createLogger("sg-company-size");
const PAGE = 400;
const BATCH = 350;
const MAX_TIER = "leadmagic";

function inboxToLead(row) {
  return {
    dedupeKey: row.dedupe_key,
    leadId: row.lead_id,
    engagerFirstName: row.engager_first_name,
    engagerLastName: row.engager_last_name,
    engagerFullName: row.engager_full_name,
    engagerLinkedinUrl: row.engager_linkedin_url,
    engagerEmail: isEmail(row.engager_email) ? row.engager_email : "",
    engagerCompany: row.engager_company,
    engagerEmployees: row.engager_employees,
    engagerJobTitle: row.engager_job_title,
    companyDomain: row.company_domain,
    campaignId: row.campaign_id,
  };
}

async function fetchParkedMissingSize(supabase) {
  const out = [];
  let afterId = 0;
  while (true) {
    let q = supabase
      .from("sg_engager_inbox")
      .select("*")
      .eq("status", "needs_company_data")
      .order("id", { ascending: true })
      .limit(PAGE);
    if (afterId) q = q.gt("id", afterId);
    const { data, error } = await q;
    throwIfError({ error }, "inbox page");
    const rows = data || [];
    if (!rows.length) break;
    afterId = rows[rows.length - 1].id;
    for (const row of rows) {
      if (cleanSizeBand(row.engager_employees)) continue;
      if (!row.engager_linkedin_url && !row.company_domain) continue;
      out.push(row);
    }
  }
  return out;
}

function stillMissingCount(leads) {
  return leads.filter((l) => !cleanSizeBand(l.engagerEmployees)).length;
}

async function persistSized(supabase, rows, leads) {
  const byKey = new Map(leads.map((l) => [l.dedupeKey, l]));
  const groups = new Map();
  let pending = 0;
  let dq = 0;
  for (const row of rows) {
    const lead = byKey.get(row.dedupe_key);
    if (!lead || !cleanSizeBand(lead.engagerEmployees)) continue;
    const status = nextParkedStatus(row, lead);
    if (
      cleanSizeBand(row.engager_employees) === cleanSizeBand(lead.engagerEmployees) &&
      row.status === status
    ) {
      continue;
    }
    const key = [
      lead.engagerEmployees,
      lead.engagerCompany || row.engager_company || "",
      lead.companyDomain || row.company_domain || "",
      lead.companySource || row.company_source || "waterfall",
      status,
    ].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        keys: [],
        patch: {
          engager_employees: lead.engagerEmployees,
          engager_company: lead.engagerCompany || row.engager_company,
          company_domain: lead.companyDomain || row.company_domain,
          company_source: lead.companySource || row.company_source || "waterfall",
          status,
          routing_note: "company size from getleads/aiark/leadmagic",
        },
      });
    }
    groups.get(key).keys.push(row.dedupe_key);
    row.engager_employees = lead.engagerEmployees;
    row.engager_company = lead.engagerCompany || row.engager_company;
    row.company_domain = lead.companyDomain || row.company_domain;
    row.status = status;
    if (status === "pending_verification" || status === "verified") pending += 1;
    if (status === "dq_size") dq += 1;
  }
  let updated = 0;
  for (const group of groups.values()) {
    for (const part of chunk(group.keys, 40)) {
      await markByDedupeKeys(supabase, part, group.patch);
      updated += part.length;
    }
  }
  return { updated, pending, dq };
}

async function applyGetleadsSizes(rows, leads, getleads, log) {
  const byLeadId = new Map();
  for (const lead of leads) {
    if (lead.leadId) byLeadId.set(String(lead.leadId), lead);
  }
  let applied = 0;
  const pulled = await getleads.listAllLeads({
    limit: 200,
    onPage: ({ pages, pulled: n }) => {
      if (pages === 1 || pages % 10 === 0) log.info("getleads page", { pages, pulled: n });
    },
  });
  for (const gl of pulled.leads || []) {
    const lead = byLeadId.get(String(gl.leadId || ""));
    if (!lead || cleanSizeBand(lead.engagerEmployees)) continue;
    if (cleanSizeBand(gl.engagerEmployees)) {
      lead.engagerEmployees = gl.engagerEmployees;
      lead.companySource = lead.companySource || "getleads";
      applied += 1;
    }
    if (gl.engagerCompany && !lead.engagerCompany) lead.engagerCompany = gl.engagerCompany;
  }
  log.info("getleads size apply", { pulled: pulled.leads?.length || 0, applied });
  return applied;
}

async function main() {
  const config = loadConfig(process.env, process.argv);
  const supabase = createSupabase(config);
  const wf = createWaterfall(config);
  const getleads = createGetleads(config);
  const spend = await loadSpend(supabase);
  const before = await countsByStatus(supabase);
  const rows = await fetchParkedMissingSize(supabase);
  const leads = rows.map(inboxToLead);
  log.info("company size start", {
    spend_cents: spend.spendCents,
    cap_cents: config.monthlySpendCapCents,
    parked_rows: rows.length,
    unique_companies: uniqueCompanyLeads(leads).length,
    needs_company_data: Number(before.needs_company_data || 0),
    max_tier: MAX_TIER,
  });

  await applyGetleadsSizes(rows, leads, getleads, log);
  let persisted = await persistSized(supabase, rows, leads);

  const companies = await readWaterfallCompanies(
    supabase,
    config.waterfallClientTag,
    [],
    uniqueCompanyLeads(leads).map(waterfallRowOf),
  );
  let existingHits = 0;
  const byDomain = new Map();
  for (const company of companies) {
    if (company?.domain) byDomain.set(String(company.domain).toLowerCase(), company);
  }
  for (const lead of leads) {
    const hit = byDomain.get(companyDomainOf(lead));
    if (hit && applyWaterfallHit(lead, hit)) existingHits += 1;
  }
  persisted = await persistSized(supabase, rows, leads);
  log.info("existing waterfall companies", { companies: companies.length, with_range: companies.filter(sizeFromCompanyHit).length, hits: existingHits });

  const stillLeads = uniqueCompanyLeads(leads.filter((l) => !cleanSizeBand(l.engagerEmployees) && l.engagerLinkedinUrl && companyDomainOf(l)));
  log.info("waterfall company queue", { unique_companies: stillLeads.length, batches: Math.ceil(stillLeads.length / BATCH) });

  await wf.health();
  await wf.ensureClient();
  let batchNo = 0;
  for (const batch of chunk(stillLeads, BATCH)) {
    batchNo += 1;
    const payload = batch.map(waterfallRowOf);
    log.info("waterfall company start", { batch: batchNo, company_count: payload.length, max_tier: MAX_TIER });
    const started = await wf.enrich({
      rows: payload,
      need: "email",
      requireTitleMatch: false,
      background: true,
      maxTier: MAX_TIER,
    });
    const jobId = started?.job_id || started?.id || started?.jobId || null;
    if (jobId) await wf.waitForJob(jobId, { timeoutMs: 50 * 60_000, pollMs: 15_000 });
    const after = await readWaterfallCompanies(supabase, config.waterfallClientTag, [], payload);
    let hits = 0;
    const found = new Map();
    for (const company of after) {
      if (company?.domain) found.set(String(company.domain).toLowerCase(), company);
    }
    for (const lead of leads) {
      const hit = found.get(companyDomainOf(lead));
      if (hit && applyWaterfallHit(lead, hit)) hits += 1;
    }
    const wrote = await persistSized(supabase, rows, leads);
    log.info("waterfall company done", {
      batch: batchNo,
      job_id: jobId,
      with_range: after.filter(sizeFromCompanyHit).length,
      hits,
      wrote: wrote.updated,
    });
  }

  persisted = await persistSized(supabase, rows, leads);
  const afterCounts = await countsByStatus(supabase);
  log.info("company size done", {
    wrote: persisted.updated,
    pending_like: persisted.pending,
    dq_size: persisted.dq,
    still_missing: stillMissingCount(leads),
    needs_company_data: Number(afterCounts.needs_company_data || 0),
    dq_size_now: Number(afterCounts.dq_size || 0),
    pending_verification: Number(afterCounts.pending_verification || 0),
    verified: Number(afterCounts.verified || 0),
  });
}

main().catch((err) => {
  log.error("company size failed", { error: String(err.message || err).slice(0, 200) });
  process.exit(1);
});
