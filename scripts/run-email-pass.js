/**
 * One-shot: find work emails for in-band rows that still need one.
 * Includes parked needs_email and in-band unresolvable (3 attempts already used).
 * Does not increment resolution_attempts. max_tier=leadmagic.
 */
import { createGetleads } from "../src/clients/getleads.js";
import { chunk } from "../src/clients/webhook.js";
import { createWaterfall } from "../src/clients/waterfall.js";
import { loadConfig, SIZE_OK } from "../src/config.js";
import { countsByStatus, markByDedupeKeys } from "../src/inbox.js";
import { createLogger } from "../src/logger.js";
import { cleanSizeBand } from "../src/normalize.js";
import { nextParkedStatus } from "../src/parked.js";
import {
  applyWaterfallHit,
  companyDomainOf,
  readWaterfallCompanies,
  readWaterfallContacts,
  uniqueWaterfallLeads,
  waterfallRowOf,
} from "../src/resolve.js";
import { createSupabase, throwIfError } from "../src/supabase.js";
import { isEmail } from "../src/util/email.js";

const log = createLogger("sg-email-pass");
const PAGE = 400;
const BATCH = 250;
const MAX_TIER = "leadmagic";
const SOURCE_STATUSES = ["needs_email", "unresolvable"];

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

function inBandMissingEmail(row) {
  if (!SIZE_OK.includes(cleanSizeBand(row.engager_employees) || "")) return false;
  if (!String(row.engager_company || "").trim()) return false;
  if (isEmail(row.engager_email)) return false;
  return Boolean(row.engager_linkedin_url || row.company_domain);
}

async function fetchNeedEmail(supabase) {
  const out = [];
  let afterId = 0;
  while (true) {
    let q = supabase
      .from("sg_engager_inbox")
      .select("*")
      .in("status", SOURCE_STATUSES)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (afterId) q = q.gt("id", afterId);
    const { data, error } = await q;
    throwIfError({ error }, "inbox page");
    const rows = data || [];
    if (!rows.length) break;
    afterId = rows[rows.length - 1].id;
    for (const row of rows) {
      if (inBandMissingEmail(row)) out.push(row);
    }
  }
  return out;
}

function applyHits(leads, companies, contacts = []) {
  const byLi = new Map();
  const byPerson = new Map();
  for (const contact of contacts || []) {
    if (contact?.linkedin_url) byLi.set(String(contact.linkedin_url).toLowerCase(), contact);
    const domain = String(contact?.domain || "").toLowerCase();
    const first = String(contact?.first_name || "").toLowerCase();
    const last = String(contact?.last_name || "").toLowerCase();
    if (domain && first) byPerson.set(`${domain}|${first}|${last}`, contact);
  }
  const byDomain = new Map();
  for (const company of companies || []) {
    if (company?.domain) byDomain.set(String(company.domain).toLowerCase(), company);
  }
  let hits = 0;
  for (const lead of leads) {
    const company = byDomain.get(companyDomainOf(lead)) || null;
    const contact =
      byLi.get(String(lead.engagerLinkedinUrl || "").toLowerCase()) ||
      byPerson.get(
        `${companyDomainOf(lead)}|${String(lead.engagerFirstName || "").toLowerCase()}|${String(lead.engagerLastName || "").toLowerCase()}`,
      ) ||
      null;
    if (applyWaterfallHit(lead, contact ? { ...company, ...contact } : company)) hits += 1;
  }
  return hits;
}

async function persistFound(supabase, rows, leads) {
  const byKey = new Map(leads.map((l) => [l.dedupeKey, l]));
  const groups = new Map();
  let pending = 0;
  for (const row of rows) {
    const lead = byKey.get(row.dedupe_key);
    if (!lead || !isEmail(lead.engagerEmail)) continue;
    const status = nextParkedStatus(row, lead);
    const key = [lead.engagerEmail, lead.companyDomain || row.company_domain || "", status].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        keys: [],
        patch: {
          engager_email: lead.engagerEmail,
          company_domain: lead.companyDomain || row.company_domain,
          engager_company: lead.engagerCompany || row.engager_company,
          engager_employees: lead.engagerEmployees || row.engager_employees,
          company_source: lead.companySource || row.company_source,
          status,
          routing_note: "email from getleads/aiark/leadmagic",
        },
      });
    }
    groups.get(key).keys.push(row.dedupe_key);
    row.engager_email = lead.engagerEmail;
    row.company_domain = lead.companyDomain || row.company_domain;
    row.status = status;
    if (status === "pending_verification" || status === "verified") pending += 1;
  }
  let updated = 0;
  for (const group of groups.values()) {
    for (const part of chunk(group.keys, 40)) {
      await markByDedupeKeys(supabase, part, group.patch);
      updated += part.length;
    }
  }
  return { updated, pending };
}

async function applyGetleadsEmails(leads, getleads, log) {
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
    if (!lead || isEmail(lead.engagerEmail)) continue;
    if (isEmail(gl.engagerEmail)) {
      lead.engagerEmail = gl.engagerEmail;
      lead.emailSource = "getleads";
      applied += 1;
    }
    if (gl.engagerCompanyWebsite && !lead.companyDomain) {
      lead.companyDomain = companyDomainOf({ engagerCompanyWebsite: gl.engagerCompanyWebsite }) || lead.companyDomain;
    }
  }
  log.info("getleads email apply", { pulled: pulled.leads?.length || 0, applied });
  return applied;
}

async function main() {
  const config = loadConfig(process.env, process.argv);
  const supabase = createSupabase(config);
  const wf = createWaterfall(config);
  const getleads = createGetleads(config);
  const before = await countsByStatus(supabase);
  const rows = await fetchNeedEmail(supabase);
  const leads = rows.map(inboxToLead);
  const unique = uniqueWaterfallLeads(leads.filter((l) => !isEmail(l.engagerEmail)));
  log.info("email pass start", {
    parked_rows: rows.length,
    unique_people: unique.length,
    needs_email: Number(before.needs_email || 0),
    unresolvable: Number(before.unresolvable || 0),
    max_tier: MAX_TIER,
  });

  await applyGetleadsEmails(leads, getleads, log);
  let persisted = await persistFound(supabase, rows, leads);

  const existingRows = uniqueWaterfallLeads(leads.filter((l) => !isEmail(l.engagerEmail))).map(waterfallRowOf);
  const existingContacts = existingRows.length
    ? await readWaterfallContacts(supabase, config.waterfallClientTag, existingRows)
    : [];
  const existingCompanies = existingRows.length
    ? await readWaterfallCompanies(supabase, config.waterfallClientTag, existingContacts, existingRows)
    : [];
  const existingHits = applyHits(leads, existingCompanies, existingContacts);
  persisted = await persistFound(supabase, rows, leads);
  log.info("existing waterfall contacts", {
    contacts: existingContacts.length,
    companies: existingCompanies.length,
    hits: existingHits,
    wrote: persisted.updated,
  });

  const still = uniqueWaterfallLeads(
    leads.filter((l) => !isEmail(l.engagerEmail) && (companyDomainOf(l) || l.engagerLinkedinUrl)),
  );
  log.info("waterfall email queue", { unique_people: still.length, batches: Math.ceil(still.length / BATCH) });

  if (still.length) {
    await wf.health();
    await wf.ensureClient();
    let batchNo = 0;
    for (const batch of chunk(still, BATCH)) {
      batchNo += 1;
      const payload = batch.map(waterfallRowOf);
      log.info("waterfall email start", { batch: batchNo, people: payload.length, max_tier: MAX_TIER });
      const started = await wf.enrich({
        rows: payload,
        need: "email",
        requireTitleMatch: false,
        background: true,
        maxTier: MAX_TIER,
      });
      const jobId = started?.job_id || started?.id || started?.jobId || null;
      if (jobId) await wf.waitForJob(jobId, { timeoutMs: 50 * 60_000, pollMs: 15_000 });
      const contacts = await readWaterfallContacts(supabase, config.waterfallClientTag, payload);
      const companies = await readWaterfallCompanies(supabase, config.waterfallClientTag, contacts, payload);
      const hits = applyHits(leads, companies, contacts);
      const wrote = await persistFound(supabase, rows, leads);
      log.info("waterfall email done", {
        batch: batchNo,
        job_id: jobId,
        contacts: contacts.length,
        hits,
        wrote: wrote.updated,
        pending_like: wrote.pending,
      });
    }
  }

  persisted = await persistFound(supabase, rows, leads);
  const after = await countsByStatus(supabase);
  log.info("email pass done", {
    wrote: persisted.updated,
    pending_like: persisted.pending,
    still_missing: leads.filter((l) => !isEmail(l.engagerEmail)).length,
    needs_email: Number(after.needs_email || 0),
    pending_verification: Number(after.pending_verification || 0),
    unresolvable: Number(after.unresolvable || 0),
  });
}

main().catch((err) => {
  log.error("email pass failed", { error: String(err.message || err).slice(0, 200) });
  process.exit(1);
});
