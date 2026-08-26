import { chunk } from "../src/clients/webhook.js";
import { createWaterfall } from "../src/clients/waterfall.js";
import { loadConfig } from "../src/config.js";
import { countsByStatus } from "../src/inbox.js";
import { markByDedupeKeys } from "../src/inbox.js";
import { createLogger } from "../src/logger.js";
import { nextParkedStatus, parkedAttemptCount } from "../src/parked.js";
import {
  applyResolvedFields,
  applyWaterfallHit,
  companyDomainOf,
  needsEmail,
  readWaterfallCompanies,
  readWaterfallContacts,
  shouldWaterfall,
  uniqueWaterfallLeads,
  waterfallRowOf,
} from "../src/resolve.js";
import { addSpend, loadSpend } from "../src/spend.js";
import { createSupabase, throwIfError } from "../src/supabase.js";
import { isEmail } from "../src/util/email.js";

const log = createLogger("sg-wf-mcp-pass");
const PAGE = 400;
const BATCH = 350;
const MAX_TIER = "leadmagic";
const JOB_TIMEOUT_MS = 50 * 60_000;

function realEmail(...candidates) {
  for (const value of candidates) {
    if (isEmail(value)) return value;
  }
  return "";
}

function inboxToResolveLead(row) {
  return {
    dedupeKey: row.dedupe_key,
    leadId: row.lead_id,
    profileId: row.profile_id,
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
    campaignId: row.campaign_id,
    resolutionAttempts: row.resolution_attempts || 0,
  };
}

function tierHits(tiers, name) {
  const t = tiers?.[name];
  if (t == null) return null;
  if (typeof t === "number") return t;
  return t.email_hits ?? t.vendor_hits ?? null;
}

function jobSummary(job) {
  if (!job || typeof job !== "object") return { present: Boolean(job) };
  const result = job.result && typeof job.result === "object" ? job.result : {};
  const tiers = result.tier_stats || result.tier_breakdown || job.tiers || {};
  const enabled = result.vendors_enabled || {};
  return {
    job_id: job.job_id || job.id || null,
    status: job.status || job.state || null,
    rows_in: result.rows_in ?? job.rows_in ?? job.row_count ?? null,
    emails: result.emails_found ?? job.emails ?? job.email_count ?? job.found ?? null,
    contacts_written: result.contacts_written ?? null,
    max_tier: result.max_tier ?? job.max_tier ?? job.maxTier ?? null,
    cost_cents: result.cost_cents ?? job.cost_cents ?? job.spend_cents ?? null,
    smartlead: tierHits(tiers, "smartlead"),
    aiark: tierHits(tiers, "aiark"),
    leadmagic: tierHits(tiers, "leadmagic"),
    prospeo: tierHits(tiers, "prospeo"),
    fullenrich: tierHits(tiers, "fullenrich"),
    prospeo_enabled: enabled.prospeo ?? null,
    fullenrich_enabled: enabled.fullenrich ?? null,
  };
}

function isActiveJob(job) {
  const status = String(job?.status || job?.state || "").toLowerCase();
  return ["running", "queued", "pending", "in_progress", "processing", "started"].includes(status);
}

async function fetchAllParkedDomain(supabase) {
  const out = [];
  let afterId = 0;
  while (true) {
    let q = supabase
      .from("sg_engager_inbox")
      .select("*")
      .in("status", ["needs_email", "needs_company_data"])
      .not("company_domain", "is", null)
      .neq("company_domain", "")
      .order("id", { ascending: true })
      .limit(PAGE);
    if (afterId) q = q.gt("id", afterId);
    const { data, error } = await q;
    throwIfError({ error }, "inbox page");
    const rows = data || [];
    if (!rows.length) break;
    out.push(...rows);
    afterId = rows[rows.length - 1].id;
  }
  return out;
}

function applyHits(leads, contacts, companies) {
  const stats = { resolved: 0 };
  const byKey = new Map();
  for (const hit of contacts || []) {
    const slug = String(hit.linkedin_url || "")
      .toLowerCase()
      .match(/linkedin\.com\/in\/([^/?#]+)/)?.[1];
    if (slug) byKey.set(`li:${slug}`, hit);
    const domain = String(hit.domain || "").toLowerCase();
    const first = String(hit.first_name || "").toLowerCase();
    const last = String(hit.last_name || "").toLowerCase();
    if (domain && first) byKey.set(`${domain}|${first}|${last}`, hit);
  }
  const byDomain = new Map();
  for (const company of companies || []) {
    if (company?.domain) byDomain.set(String(company.domain).toLowerCase(), company);
  }
  for (const lead of leads) {
    const slug = String(lead.engagerLinkedinUrl || "")
      .toLowerCase()
      .match(/linkedin\.com\/in\/([^/?#]+)/)?.[1];
    const domain = companyDomainOf(lead);
    const first = String(lead.engagerFirstName || "").toLowerCase();
    const last = String(lead.engagerLastName || "").toLowerCase();
    const hit =
      (slug && byKey.get(`li:${slug}`)) ||
      byKey.get(`${domain}|${first}|${last}`) ||
      null;
    const company = byDomain.get(domain) || byDomain.get(hit?.domain || "") || null;
    if (applyWaterfallHit(lead, hit ? { ...hit, ...company } : company)) stats.resolved += 1;
  }
  return stats;
}

async function persistLeads(supabase, rows, leads, { sentKeys, maxAttempts }) {
  const byKey = new Map(leads.map((l) => [l.dedupeKey, applyResolvedFields(l)]));
  let updated = 0;
  let unresolvable = 0;
  for (const row of rows) {
    const lead = byKey.get(row.dedupe_key);
    if (!lead) continue;
    const gotEmail = Boolean(realEmail(lead.engagerEmail, row.engager_email));
    const wasSent = sentKeys.has(row.dedupe_key);
    const holdAttempt = !gotEmail && !wasSent;
    const attempts = parkedAttemptCount(row, { holdAttempt });
    const status = nextParkedStatus(row, lead);
    const exhausted =
      attempts >= maxAttempts && (status === "needs_email" || status === "needs_company_data") && wasSent;
    await markByDedupeKeys(supabase, [row.dedupe_key], {
      engager_email: realEmail(lead.engagerEmail, row.engager_email) || row.engager_email,
      engager_company: lead.engagerCompany || row.engager_company,
      company_domain: lead.companyDomain || row.company_domain,
      company_source: lead.companySource || row.company_source,
      first_name_n: lead.first_name_n || row.first_name_n,
      company_n: lead.company_n || row.company_n,
      resolution_attempts: attempts,
      last_resolution_at: new Date().toISOString(),
      status: exhausted ? "unresolvable" : status,
      routing_note: exhausted
        ? `unresolvable after ${attempts} attempts`
        : gotEmail
          ? "applied waterfall contact"
          : row.routing_note,
    });
    if (exhausted) unresolvable += 1;
    else if (gotEmail) updated += 1;
  }
  return { updated, unresolvable };
}

async function waitForActiveJobs(wf) {
  const listed = await wf.listJobs(20);
  const jobs = Array.isArray(listed) ? listed : listed?.jobs || listed?.items || [];
  const active = jobs.filter(isActiveJob);
  log.info("waterfall jobs listed", { count: jobs.length, active: active.length });
  for (const job of active) {
    const id = job.job_id || job.id;
    log.info("waiting for already-running waterfall job", jobSummary(job));
    if (id) await wf.waitForJob(id, { timeoutMs: JOB_TIMEOUT_MS, pollMs: 15_000 });
  }
  return jobs.map(jobSummary);
}

async function main() {
  const config = loadConfig(process.env, process.argv);
  const supabase = createSupabase(config);
  const wf = createWaterfall(config);
  const beforeSpend = await loadSpend(supabase);
  const before = await countsByStatus(supabase);

  log.info("mcp pass start", {
    spend_cents: beforeSpend.spendCents,
    cap_cents: config.monthlySpendCapCents,
    max_tier: MAX_TIER,
    needs_email: Number(before.needs_email || 0),
    needs_company_data: Number(before.needs_company_data || 0),
  });

  await wf.health();
  await wf.ensureClient();
  await waitForActiveJobs(wf);

  const parked = await fetchAllParkedDomain(supabase);
  const parkedLeads = parked.map(inboxToResolveLead);
  const unique = uniqueWaterfallLeads(parkedLeads.filter(shouldWaterfall));
  const withDomain = unique.filter((lead) => companyDomainOf(lead));
  const existing = await readWaterfallContacts(
    supabase,
    config.waterfallClientTag,
    withDomain.map(waterfallRowOf),
  );
  const companies = await readWaterfallCompanies(
    supabase,
    config.waterfallClientTag,
    existing,
    withDomain.map(waterfallRowOf),
  );
  const appliedExisting = applyHits(parkedLeads, existing, companies);
  const still = uniqueWaterfallLeads(withDomain.filter((lead) => needsEmail(lead)));
  log.info("mcp pass queue", {
    parked_rows: parked.length,
    unique_people: unique.length,
    with_domain: withDomain.length,
    existing_contacts: existing.length,
    applied_existing: appliedExisting.resolved,
    to_send: still.length,
    batches: Math.ceil(still.length / BATCH),
  });

  const sentKeys = new Set();
  const jobs = [];
  let bookedCents = 0;
  for (const [index, batch] of chunk(still, BATCH).entries()) {
    const rows = batch.filter((lead) => companyDomainOf(lead)).map(waterfallRowOf);
    if (!rows.length) continue;
    log.info("mcp enrich start", { batch: index + 1, row_count: rows.length, max_tier: MAX_TIER });
    const started = await wf.enrich({
      rows,
      need: "email",
      requireTitleMatch: false,
      background: true,
      maxTier: MAX_TIER,
    });
    const jobId = started?.job_id || started?.id || started?.jobId || null;
    if (!jobId) throw new Error("waterfall enrich returned no job_id");
    const finished = await wf.waitForJob(jobId, { timeoutMs: JOB_TIMEOUT_MS, pollMs: 15_000 });
    const summary = { ...jobSummary(started), ...jobSummary(finished), job_id: jobId };
    jobs.push(summary);
    log.info("mcp enrich done", { batch: index + 1, ...summary });
    const cents = Number(started?.cost_cents || finished?.cost_cents || 0);
    if (cents > 0) {
      await addSpend(supabase, "waterfall", cents);
      bookedCents += cents;
    }
    for (const lead of batch) sentKeys.add(lead.dedupeKey);
    const contacts = await readWaterfallContacts(supabase, config.waterfallClientTag, rows);
    const afterCompanies = await readWaterfallCompanies(supabase, config.waterfallClientTag, contacts, rows);
    applyHits(parkedLeads, contacts, afterCompanies);
    const batchPersisted = await persistLeads(supabase, parked, parkedLeads, {
      sentKeys,
      maxAttempts: config.maxResolutionAttempts,
    });
    log.info("mcp batch persisted", { batch: index + 1, ...batchPersisted });
  }

  const persisted = await persistLeads(supabase, parked, parkedLeads, {
    sentKeys,
    maxAttempts: config.maxResolutionAttempts,
  });
  const after = await countsByStatus(supabase);
  const afterSpend = await loadSpend(supabase);
  log.info("mcp pass done", {
    jobs: jobs.length,
    booked_cents: bookedCents,
    spend_cents: afterSpend.spendCents,
    cap_cents: config.monthlySpendCapCents,
    updated: persisted.updated,
    unresolvable: persisted.unresolvable,
    needs_email: Number(after.needs_email || 0),
    needs_company_data: Number(after.needs_company_data || 0),
    pending_verification: Number(after.pending_verification || 0),
    imported: Number(after.imported || 0),
  });
}

main().catch((err) => {
  log.error("mcp pass failed", { error: String(err.message || err).slice(0, 200) });
  process.exit(1);
});
