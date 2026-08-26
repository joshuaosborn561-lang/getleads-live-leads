import { chunk } from "./clients/webhook.js";
import { applyEmploymentCurrency } from "./gates/prospect.js";
import {
  bandFromEmployeeCount,
  cleanSizeBand,
  companyLinkedinSlug,
  domainFromWebsite,
  hashedProfileId,
  linkedinSlug,
  normCompany,
  normFirstName,
} from "./normalize.js";
import { addSpend, wouldExceedCap } from "./spend.js";
import { emailDomain, isEmail } from "./util/email.js";

export function needsCompany(lead) {
  return !String(lead.engagerCompany || "").trim() || !cleanSizeBand(lead.engagerEmployees);
}

export function needsEmail(lead) {
  return !isEmail(lead.engagerEmail);
}

export function companyDomainOf(lead) {
  if (lead.companyDomain) return lead.companyDomain;
  const fromSite = domainFromWebsite(lead.engagerCompanyWebsite);
  if (fromSite) return fromSite;
  const fromEmail = isEmail(lead.engagerEmail) ? emailDomain(lead.engagerEmail) : "";
  if (fromEmail && !isFreemail(fromEmail)) return fromEmail;
  return "";
}

export function waterfallPersonKey(lead) {
  const slug = linkedinSlug(lead.engagerLinkedinUrl);
  const hash = hashedProfileId(lead.engagerLinkedinUrl);
  if (slug) return `li:${slug}`;
  if (hash) return `li:${hash}`;
  const domain = companyDomainOf(lead);
  const first = String(lead.engagerFirstName || "").trim().toLowerCase();
  const last = String(lead.engagerLastName || "").trim().toLowerCase();
  if (domain && first) return `${domain}|${first}|${last}`;
  return "";
}

export function uniqueWaterfallLeads(leads) {
  const seen = new Set();
  const out = [];
  for (const lead of leads) {
    const key = waterfallPersonKey(lead);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(lead);
  }
  return out;
}

export function shouldWaterfall(lead) {
  const hasPerson =
    Boolean(lead.engagerLinkedinUrl) ||
    Boolean(lead.engagerFirstName || lead.engagerFullName);
  if (!hasPerson) return false;
  if (needsEmail(lead)) return true;
  return !companyDomainOf(lead) && Boolean(lead.engagerLinkedinUrl);
}

const FREEMAIL = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "live.com",
  "msn.com",
  "proton.me",
  "protonmail.com",
]);

export function isFreemail(domain) {
  return FREEMAIL.has(String(domain || "").toLowerCase());
}

export function matchApifyItem(lead, items) {
  const hash = hashedProfileId(lead.engagerLinkedinUrl);
  const slug = linkedinSlug(lead.engagerLinkedinUrl);
  const keys = [...new Set([hash, slug].filter(Boolean).map((s) => s.toLowerCase()))];
  if (!keys.length) return null;
  return (
    items.find((item) => {
      const candidates = [
        item.id,
        item.profileId,
        item.query,
        item.publicIdentifier,
        linkedinSlug(item.linkedinUrl),
      ]
        .filter(Boolean)
        .map((s) => String(s).toLowerCase());
      return keys.some((key) => candidates.some((c) => c === key || c.includes(key)));
    }) || null
  );
}

export function matchCompanyItem(lead, items) {
  const slug = companyLinkedinSlug(lead.companyLinkedinUrl);
  if (!slug) return null;
  return (
    items.find((item) => companyLinkedinSlug(item.linkedinUrl) === slug) ||
    items.find((item) => String(item.universalName || "").toLowerCase() === slug) ||
    items.find((item) => String(item.id || "").toLowerCase() === slug) ||
    null
  );
}

export function applyProfileItem(lead, item) {
  if (!item) return false;
  let changed = false;
  if (item.company) {
    const currency = applyEmploymentCurrency(lead, item.company);
    lead.engagerCompany = currency.company;
    lead.employmentMismatch = currency.mismatch;
    lead.companySource = currency.source;
    changed = true;
  }
  if (item.employees) {
    lead.engagerEmployees = item.employees;
    changed = true;
  }
  if (item.companyLinkedinUrl) lead.companyLinkedinUrl = item.companyLinkedinUrl;
  if (item.title) lead.engagerJobTitle = item.title;
  if (item.city) lead.engagerCity = item.city;
  if (item.country) lead.engagerCountry = item.country;
  if (item.website) lead.engagerCompanyWebsite = item.website;
  lead.companyDomain = domainFromWebsite(item.website) || lead.companyDomain;
  return changed;
}

export function uniqueCompanyLeads(leads) {
  const seen = new Set();
  const out = [];
  for (const lead of leads) {
    const domain = companyDomainOf(lead);
    const key = domain || waterfallPersonKey(lead);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(lead);
  }
  return out;
}

/** One lookup per domain, else one per normalized company name. */
export function uniqueCompanyLookupLeads(leads) {
  const ranked = [...leads].sort((a, b) => Number(Boolean(companyDomainOf(b))) - Number(Boolean(companyDomainOf(a))));
  const seen = new Set();
  const out = [];
  for (const lead of ranked) {
    const domain = companyDomainOf(lead);
    const name = (normCompany(lead.engagerCompany) || "").toLowerCase();
    const keys = [domain && `d:${domain}`, name && `n:${name}`].filter(Boolean);
    if (!keys.length || keys.some((key) => seen.has(key))) {
      for (const key of keys) seen.add(key);
      continue;
    }
    for (const key of keys) seen.add(key);
    out.push(lead);
  }
  return out;
}

export function sizeFromCompanyHit(hit) {
  if (!hit) return "";
  return (
    cleanSizeBand(hit.employee_range) ||
    cleanSizeBand(hit.employees) ||
    cleanSizeBand(hit.company_size) ||
    bandFromEmployeeCount(
      hit.employee_count ?? hit.employeeCount,
      hit.employee_count_range ?? hit.employeeCountRange,
    ) ||
    ""
  );
}

/** Company/size comes from getleads, AI Ark, or LeadMagic via waterfall. Never Apify. */
export async function resolveCompanies({ leads, waterfall, config, spend, supabase, log, cap }) {
  const stats = { attempted: 0, resolved: 0, skipped_cap: 0, skipped_aiark: 0, errors: 0, spend_cents: 0, job_id: null };
  const out = leads.map((l) => ({ ...l }));
  const need = out.filter((l) => needsCompany(l) && (l.engagerLinkedinUrl || companyDomainOf(l)));
  if (!need.length) return { leads: out, stats, spend };

  let current = spend;
  try {
    const existing = await readWaterfallCompanies(
      supabase,
      config.waterfallClientTag,
      [],
      uniqueCompanyLeads(need).map(waterfallRowOf),
    );
    applyCompanyHits(out, existing, stats);
  } catch {
    // Best-effort table read; still try a waterfall job if size is missing.
  }

  const still = uniqueCompanyLeads(
    out.filter((l) => needsCompany(l) && l.engagerLinkedinUrl && companyDomainOf(l)),
  );
  if (!still.length) return { leads: out, stats, spend: current };
  if (!config.emailWaterfallMcpUrl || !waterfall?.enrich) {
    log.info("company size skipped; waterfall not configured", { remaining: still.length });
    return { leads: out, stats, spend: current };
  }

  stats.attempted += still.length;
  try {
    if (waterfall.health) await waterfall.health();
    if (waterfall.ensureClient) await waterfall.ensureClient();
    const started = await waterfall.enrich({
      rows: still.map(waterfallRowOf),
      need: "email",
      requireTitleMatch: false,
      background: true,
      maxTier: config.waterfallMaxTier || "leadmagic",
    });
    const jobId = started?.job_id || started?.id || started?.jobId || null;
    stats.job_id = jobId;
    if (jobId && waterfall.waitForJob) {
      await waterfall.waitForJob(jobId, { timeoutMs: 50 * 60_000 });
    }
    const companies = await readWaterfallCompanies(
      supabase,
      config.waterfallClientTag,
      [],
      still.map(waterfallRowOf),
    );
    applyCompanyHits(out, companies, stats);
    const cents = Number(started?.cost_cents || started?.spend_cents || 0);
    if (cents > 0) {
      current = await addSpend(supabase, "waterfall", cents);
      stats.spend_cents += cents;
    }
    log.info("waterfall company job complete", {
      job_id: jobId,
      count: still.length,
      with_range: companies.filter((c) => sizeFromCompanyHit(c)).length,
      spend_cents: cents,
    });
  } catch (err) {
    stats.errors += still.length;
    log.warn("waterfall company failed", {
      error: String(err.message || err).slice(0, 200),
      count: still.length,
    });
  }
  return { leads: out, stats, spend: current };
}

export async function resolveCompanySizes({ leads, supabase, config, spend, stats }) {
  const need = uniqueCompanyLeads(leads.filter((l) => !cleanSizeBand(l.engagerEmployees)));
  if (!need.length) return spend;
  try {
    const companies = await readWaterfallCompanies(
      supabase,
      config.waterfallClientTag,
      [],
      need.map(waterfallRowOf),
    );
    applyCompanyHits(leads, companies, stats || { resolved: 0 });
  } catch {
    // Size backfill is best-effort from waterfall company rows only.
  }
  return spend;
}

export function waterfallRowOf(lead) {
  return {
    domain: companyDomainOf(lead) || "",
    company_name: lead.engagerCompany || undefined,
    first_name: lead.engagerFirstName || String(lead.engagerFullName || "").split(/\s+/)[0] || undefined,
    last_name: lead.engagerLastName || undefined,
    title: lead.engagerJobTitle || undefined,
    email: isEmail(lead.engagerEmail) ? lead.engagerEmail : undefined,
    linkedin_url: lead.engagerLinkedinUrl || undefined,
  };
}

export function applyWaterfallHit(lead, hit) {
  if (!hit) return false;
  let changed = false;
  if (isEmail(hit.email)) {
    lead.engagerEmail = hit.email;
    lead.emailSource = hit.source_tier || "waterfall";
    changed = true;
    const domain = emailDomain(hit.email);
    if (domain && !isFreemail(domain) && !lead.companyDomain && !domainFromWebsite(lead.engagerCompanyWebsite)) {
      lead.companyDomain = domain;
      lead.companySource = lead.companySource || "aiark";
    }
  }
  if (hit.domain && !companyDomainOf(lead) && !isFreemail(hit.domain)) {
    lead.companyDomain = String(hit.domain).toLowerCase();
    lead.companySource = lead.companySource || "aiark";
    changed = true;
  }
  if (hit.company_name && !String(lead.engagerCompany || "").trim()) {
    lead.engagerCompany = hit.company_name;
    lead.companySource = lead.companySource || "aiark";
    changed = true;
  }
  const size = sizeFromCompanyHit(hit);
  if (size && !cleanSizeBand(lead.engagerEmployees)) {
    lead.engagerEmployees = size;
    changed = true;
  }
  return changed;
}

export async function resolveEmails({ leads, waterfall, config, spend, supabase, log, cap }) {
  const stats = {
    attempted: 0,
    resolved: 0,
    skipped_cap: 0,
    skipped_no_domain: 0,
    errors: 0,
    spend_cents: 0,
    job_id: null,
  };
  const out = leads.map((l) => ({ ...l }));
  const missing = uniqueWaterfallLeads(out.filter(shouldWaterfall));
  if (!missing.length) return { leads: out, stats, spend };

  let current = spend;
  const rows = [];
  const indexed = [];
  for (const lead of missing) {
    const domain = companyDomainOf(lead);
    const linkedin = lead.engagerLinkedinUrl || "";
    if (!domain && !linkedin) {
      stats.skipped_no_domain += 1;
      continue;
    }
    rows.push(waterfallRowOf(lead));
    indexed.push(lead);
  }
  if (!rows.length) return { leads: out, stats, spend: current };
  if (!config.emailWaterfallMcpUrl) return { leads: out, stats, spend: current };

  try {
    const existing = await readWaterfallContacts(supabase, config.waterfallClientTag, rows);
    const existingCompanies = await readWaterfallCompanies(supabase, config.waterfallClientTag, existing, rows);
    applyHitsToLeads(out, existing, existingCompanies, stats);
  } catch {
    // Table read is best-effort; still try a paid job if contacts aren't there yet.
  }
  const still = [];
  const stillLeads = [];
  for (const lead of indexed) {
    if (!needsEmail(lead) && companyDomainOf(lead)) continue;
    still.push(waterfallRowOf(lead));
    stillLeads.push(lead);
  }
  if (!still.length) return { leads: out, stats, spend: current };
  rows.length = 0;
  rows.push(...still);
  indexed.length = 0;
  indexed.push(...stillLeads);

  const estimate = rows.length * config.waterfallCentsPerRow;
  if (wouldExceedCap(current.spendCents, estimate, cap)) {
    stats.skipped_cap += rows.length;
    await logCap(log, "waterfall", current, cap, estimate);
    return { leads: out, stats, spend: current };
  }

  stats.attempted += rows.length;
  try {
    await waterfall.health();
    await waterfall.ensureClient();
    const started = await waterfall.enrich({
      rows,
      need: "email",
      requireTitleMatch: false,
      background: true,
      maxTier: config.waterfallMaxTier || "leadmagic",
    });
    const jobId = started?.job_id || started?.id || started?.jobId || null;
    stats.job_id = jobId;
    if (jobId) await waterfall.waitForJob(jobId);
    const contacts = await readWaterfallContacts(supabase, config.waterfallClientTag, rows);
    const companies = await readWaterfallCompanies(supabase, config.waterfallClientTag, contacts, rows);
    const cents = Number(started?.cost_cents || started?.spend_cents || 0) || estimate;
    current = await addSpend(supabase, "waterfall", cents);
    stats.spend_cents += cents;
    log.info("waterfall job complete", {
      job_id: jobId,
      count: rows.length,
      matched: contacts.length,
      spend_cents: cents,
    });
    applyHitsToLeads(out, contacts, companies, stats);
  } catch (err) {
    stats.errors += rows.length;
    log.warn("waterfall failed", { error: String(err.message || err).slice(0, 200), count: rows.length });
    for (const lead of indexed) {
      lead.resolveError = String(err.message || "waterfall failed").slice(0, 500);
    }
  }

  return { leads: out, stats, spend: current };
}

async function selectInChunks(supabase, table, columns, column, values) {
  const unique = [...new Set(values.filter(Boolean))];
  const out = [];
  for (const part of chunk(unique, 40)) {
    const { data, error } = await supabase.from(table).select(columns).in(column, part);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
  }
  return out;
}

export async function readWaterfallContacts(supabase, clientTag, rows) {
  const table = `${clientTag}_wf_contacts`;
  const domains = [...new Set(rows.map((r) => r.domain).filter(Boolean))];
  const urls = [...new Set(rows.map((r) => r.linkedin_url).filter(Boolean))];
  const seen = new Set();
  const out = [];
  const add = (batch) => {
    for (const row of batch || []) {
      if (!row?.email && !row?.linkedin_url) continue;
      const key = `${row.domain || ""}|${row.email || ""}|${row.linkedin_url || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  };
  const columns = "domain, first_name, last_name, email, source_tier, linkedin_url";
  if (domains.length) add(await selectInChunks(supabase, table, columns, "domain", domains));
  if (urls.length) add(await selectInChunks(supabase, table, columns, "linkedin_url", urls));
  return out.filter((r) => isEmail(r.email) || r.linkedin_url);
}

export async function readWaterfallCompanies(supabase, clientTag, contacts, rows) {
  const table = `${clientTag}_wf_companies`;
  const source = [...(contacts || []), ...(rows || [])];
  const domains = [
    ...new Set(source.map((r) => r.domain).filter(Boolean).map((d) => String(d).toLowerCase())),
  ];
  const names = [...new Set(source.map((r) => r.company_name).filter(Boolean))];
  const seen = new Set();
  const out = [];
  const add = (batch) => {
    for (const row of batch || []) {
      const key = `${String(row.domain || "").toLowerCase()}|${row.company_name || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  };
  const columns = "domain, company_name, employee_range, website";
  if (domains.length) add(await selectInChunks(supabase, table, columns, "domain", domains));
  if (names.length) add(await selectInChunks(supabase, table, columns, "company_name", names));
  return out;
}

function applyHitsToLeads(leads, contacts, companies, stats) {
  const byKey = indexContacts(contacts);
  const byDomain = indexCompanies(companies);
  for (const lead of leads) {
    const domain = companyDomainOf(lead);
    const first = (lead.engagerFirstName || "").toLowerCase();
    const last = (lead.engagerLastName || "").toLowerCase();
    const hit =
      contactLookupKeys(lead).map((key) => byKey.get(key)).find(Boolean) ||
      byKey.get(`${domain}|${first}|${last}`) ||
      byKey.get(`${domain}|${first}|`) ||
      null;
    const company = byDomain.get(domain) || byDomain.get(hit?.domain || "") || null;
    if (applyWaterfallHit(lead, hit ? { ...hit, ...company } : company)) stats.resolved += 1;
  }
}

function contactLookupKeys(lead) {
  const slug = linkedinSlug(lead.engagerLinkedinUrl);
  const hash = hashedProfileId(lead.engagerLinkedinUrl);
  return [`li:${slug}`, `li:${hash}`].filter((key) => key.length > 3);
}

function indexContacts(contacts) {
  const map = new Map();
  for (const row of contacts) {
    const domain = String(row.domain || "").toLowerCase();
    const first = String(row.first_name || "").toLowerCase();
    const last = String(row.last_name || "").toLowerCase();
    if (domain && first && last) map.set(`${domain}|${first}|${last}`, row);
    if (domain && first) map.set(`${domain}|${first}|`, row);
    const slug = linkedinSlug(row.linkedin_url);
    const hash = hashedProfileId(row.linkedin_url);
    if (slug) map.set(`li:${slug}`, row);
    if (hash) map.set(`li:${hash}`, row);
  }
  return map;
}

function applyCompanyHits(leads, companies, stats) {
  const byDomain = indexCompanies(companies);
  const byName = indexCompaniesByName(companies);
  for (const lead of leads) {
    const company =
      byDomain.get(companyDomainOf(lead)) ||
      byName.get((normCompany(lead.engagerCompany) || "").toLowerCase()) ||
      null;
    if (company && applyWaterfallHit(lead, company)) stats.resolved += 1;
  }
}

function indexCompanies(companies) {
  const map = new Map();
  for (const row of companies || []) {
    const domain = String(row.domain || "").toLowerCase();
    if (domain) map.set(domain, row);
  }
  return map;
}

function indexCompaniesByName(companies) {
  const map = new Map();
  for (const row of companies || []) {
    const name = (normCompany(row.company_name) || "").toLowerCase();
    if (!name) continue;
    const prev = map.get(name);
    if (!prev || (sizeFromCompanyHit(row) && !sizeFromCompanyHit(prev))) map.set(name, row);
  }
  return map;
}

async function logCap(log, vendor, spend, cap, wouldCost) {
  log.warn("monthly spend cap hit; leaving remaining rows parked", {
    reason: vendor,
    spend_cents: spend.spendCents,
    cap_cents: cap,
    would_cost_cents: wouldCost,
  });
}

export function applyResolvedFields(lead) {
  return {
    ...lead,
    first_name_n: normFirstName(lead.engagerFirstName),
    company_n: normCompany(lead.engagerCompany),
  };
}
