/**
 * Read-only remapper for already-paid HarvestAPI datasets.
 * Does not start new Apify scrapes.
 */
import { ApifyClient } from "apify-client";
import { mapApifyCompany, mapApifyProfile } from "../src/clients/apify.js";
import { chunk } from "../src/clients/webhook.js";
import { loadConfig } from "../src/config.js";
import { countsByStatus, markByDedupeKeys } from "../src/inbox.js";
import { createLogger } from "../src/logger.js";
import { cleanSizeBand, companyLinkedinSlug, domainFromWebsite, normCompany } from "../src/normalize.js";
import { nextParkedStatus } from "../src/parked.js";
import { applyProfileItem, matchApifyItem, matchCompanyItem } from "../src/resolve.js";
import { createSupabase, throwIfError } from "../src/supabase.js";
import { isEmail } from "../src/util/email.js";

const log = createLogger("sg-remap-stored");
const PAGE = 400;
const PROFILE_ACTOR = "harvestapi~linkedin-profile-scraper";
const COMPANY_ACTOR = "harvestapi~linkedin-company";

function inboxToLead(row) {
  return {
    dedupeKey: row.dedupe_key,
    engagerCompany: row.engager_company,
    engagerEmployees: row.engager_employees,
    engagerEmail: isEmail(row.engager_email) ? row.engager_email : "",
    engagerLinkedinUrl: row.engager_linkedin_url,
    engagerJobTitle: row.engager_job_title,
    engagerCity: row.engager_city,
    engagerCountry: row.engager_country,
    companyDomain: row.company_domain,
    companySource: row.company_source,
    campaignId: row.campaign_id,
    _row: row,
  };
}

async function fetchMissingSize(supabase) {
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
      out.push(row);
    }
  }
  return out;
}

async function listSucceededRuns(client, actorId, limit = 100) {
  const list = await client.actor(actorId).runs().list({ limit, desc: true });
  return (list.items || []).filter((run) => run.status === "SUCCEEDED" && run.defaultDatasetId);
}

async function loadMappedItems(client, runs, mapper) {
  const items = [];
  for (const run of runs) {
    let offset = 0;
    let runCount = 0;
    while (true) {
      const listed = await client.dataset(run.defaultDatasetId).listItems({ limit: 1000, offset });
      const batch = listed.items || [];
      items.push(...batch.map(mapper));
      runCount += batch.length;
      if (batch.length < 1000) break;
      offset += batch.length;
    }
    log.info("loaded stored run", { actor: run.actId || "", items: runCount });
  }
  return items;
}

function indexCompanies(items) {
  const bySlug = new Map();
  const byDomain = new Map();
  const byName = new Map();
  for (const item of items || []) {
    const slug = companyLinkedinSlug(item.linkedinUrl) || String(item.universalName || "").toLowerCase();
    const domain = domainFromWebsite(item.website);
    const name = (normCompany(item.name) || "").toLowerCase();
    if (slug) bySlug.set(slug, item);
    if (domain) byDomain.set(domain, item);
    if (name) {
      const prev = byName.get(name) || [];
      prev.push(item);
      byName.set(name, prev);
    }
  }
  return { bySlug, byDomain, byName };
}

function uniqueNameMatch(byName, companyName) {
  const name = (normCompany(companyName) || "").toLowerCase();
  const hits = name ? byName.get(name) || [] : [];
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0];
  const bands = [...new Set(hits.map((h) => cleanSizeBand(h.employees)).filter(Boolean))];
  if (bands.length === 1) return hits.find((h) => cleanSizeBand(h.employees) === bands[0]);
  return null;
}

function applyCompanyMap(lead, company) {
  if (!company) return false;
  let changed = false;
  if (cleanSizeBand(company.employees) && !cleanSizeBand(lead.engagerEmployees)) {
    lead.engagerEmployees = company.employees;
    changed = true;
  }
  if (company.name && !String(lead.engagerCompany || "").trim()) {
    lead.engagerCompany = company.name;
    changed = true;
  }
  const domain = domainFromWebsite(company.website);
  if (domain && !lead.companyDomain) {
    lead.companyDomain = domain;
    lead.companySource = lead.companySource || "apify_store";
    changed = true;
  }
  if (company.linkedinUrl) lead.companyLinkedinUrl = company.linkedinUrl;
  return changed;
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
    const key = [
      lead.engagerEmployees,
      lead.engagerCompany || row.engager_company || "",
      lead.companyDomain || row.company_domain || "",
      lead.companySource || row.company_source || "apify_store",
      status,
    ].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        keys: [],
        patch: {
          engager_employees: lead.engagerEmployees,
          engager_company: lead.engagerCompany || row.engager_company,
          company_domain: lead.companyDomain || row.company_domain,
          company_source: lead.companySource || row.company_source || "apify_store",
          status,
          routing_note: "company size remapped from stored Apify dataset",
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

async function upsertCompanies(supabase, clientTag, companies) {
  const rows = [];
  const seen = new Set();
  for (const item of companies || []) {
    const domain = domainFromWebsite(item.website);
    const band = cleanSizeBand(item.employees);
    if (!domain || !band || seen.has(domain)) continue;
    seen.add(domain);
    rows.push({
      domain,
      company_name: item.name || null,
      website: item.website || `https://${domain}`,
      employee_range: band,
      source: "apify_store",
      client_tag: clientTag,
      updated_at: new Date().toISOString(),
    });
  }
  let written = 0;
  for (const part of chunk(rows, 40)) {
    const { error } = await supabase.from(`${clientTag}_wf_companies`).upsert(part, { onConflict: "domain" });
    throwIfError({ error }, "company upsert");
    written += part.length;
  }
  return written;
}

async function main() {
  const config = loadConfig(process.env);
  if (!config.apifyToken) throw new Error("APIFY_TOKEN missing");
  const supabase = createSupabase(config);
  const client = new ApifyClient({ token: config.apifyToken });
  const rows = await fetchMissingSize(supabase);
  const leads = rows.map(inboxToLead);
  log.info("remap start", { parked_rows: rows.length });

  const profileRuns = await listSucceededRuns(client, PROFILE_ACTOR, 100);
  const companyRuns = await listSucceededRuns(client, COMPANY_ACTOR, 100);
  log.info("stored runs", { profile_runs: profileRuns.length, company_runs: companyRuns.length });

  const profiles = await loadMappedItems(client, profileRuns, mapApifyProfile);
  const companies = await loadMappedItems(client, companyRuns, mapApifyCompany);
  const index = indexCompanies(companies);
  log.info("stored items", {
    profiles: profiles.length,
    companies: companies.length,
    profiles_with_size: profiles.filter((p) => cleanSizeBand(p.employees)).length,
    companies_with_size: companies.filter((c) => cleanSizeBand(c.employees)).length,
  });

  let profileHits = 0;
  let companyHits = 0;
  for (const lead of leads) {
    const profile = matchApifyItem(lead, profiles);
    if (profile && (applyProfileItem(lead, profile) || lead.companyLinkedinUrl)) profileHits += 1;
    if (cleanSizeBand(lead.engagerEmployees) && lead.companyDomain) continue;
    const company =
      matchCompanyItem(lead, companies) ||
      index.bySlug.get(companyLinkedinSlug(lead.companyLinkedinUrl)) ||
      index.byDomain.get(lead.companyDomain || "") ||
      uniqueNameMatch(index.byName, lead.engagerCompany);
    if (applyCompanyMap(lead, company)) companyHits += 1;
    if (cleanSizeBand(lead.engagerEmployees)) lead.companySource = lead.companySource || "apify_store";
  }

  const wroteCompanies = await upsertCompanies(supabase, config.waterfallClientTag, companies);
  const wrote = await persistSized(supabase, rows, leads);
  const after = await countsByStatus(supabase);
  log.info("remap done", {
    profile_hits: profileHits,
    company_hits: companyHits,
    sized: leads.filter((l) => cleanSizeBand(l.engagerEmployees)).length,
    still_missing: leads.filter((l) => !cleanSizeBand(l.engagerEmployees)).length,
    companies_upserted: wroteCompanies,
    inbox_updated: wrote.updated,
    pending_like: wrote.pending,
    dq_size: wrote.dq,
    needs_company_data: Number(after.needs_company_data || 0),
    dq_size_now: Number(after.dq_size || 0),
    pending_verification: Number(after.pending_verification || 0),
    needs_email: Number(after.needs_email || 0),
  });
}

main().catch((err) => {
  log.error("remap failed", { error: String(err.message || err).slice(0, 200) });
  process.exit(1);
});
