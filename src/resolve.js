import { chunk } from "./clients/webhook.js";
import { applyEmploymentCurrency } from "./gates/prospect.js";
import {
  cleanSizeBand,
  companyLinkedinSlug,
  domainFromWebsite,
  hashedProfileId,
  linkedinSlug,
  normCompany,
  normFirstName,
} from "./normalize.js";
import { addSpend, apifyJobCapUsd, wouldExceedApifyJob } from "./spend.js";
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

export async function resolveCompanies({ leads, apify, config, spend, supabase, log }) {
  const stats = { attempted: 0, resolved: 0, skipped_cap: 0, skipped_aiark: 0, errors: 0, spend_cents: 0 };
  const out = leads.map((l) => ({ ...l }));
  // AI Ark (via waterfall + person LinkedIn URL) owns company/domain lookup now.
  // Keep any domain Apify already stored; do not scrape those people again.
  stats.skipped_aiark = out.filter((l) => l.engagerLinkedinUrl && (needsCompany(l) || !companyDomainOf(l))).length;
  const missing = out.filter((l) => needsCompany(l) && !l.engagerLinkedinUrl);
  if (!missing.length) return { leads: out, stats, spend };
  if (!config.apifyToken && !apify?.scrapeProfiles) return { leads: out, stats, spend };
  if (!config.apifyToken) {
    log.warn("APIFY_TOKEN missing; skipping company resolution", { remaining: missing.length });
    return { leads: out, stats, spend };
  }

  let current = spend;
  const jobCapUsd = apifyJobCapUsd(config);
  const canAffordJob = (n) =>
    !wouldExceedApifyJob(n * config.apifyCentsPerProfile, jobCapUsd);

  for (const part of chunk(missing, config.apifyBatchSize)) {
    if (!canAffordJob(part.length)) {
      stats.skipped_cap += part.length;
      logApifyJobCap(log, "apify", part.length * config.apifyCentsPerProfile, jobCapUsd);
      break;
    }
    stats.attempted += part.length;
    try {
      const result = await apify.scrapeProfiles(part.map((l) => l.engagerLinkedinUrl), {
        maxTotalChargeUsd: jobCapUsd,
      });
      const cents = result.usageTotalUsd
        ? Number(result.usageTotalUsd) * 100
        : part.length * config.apifyCentsPerProfile;
      if (cents > 0) {
        current = await addSpend(supabase, "apify", cents);
        stats.spend_cents += cents;
      }
      log.info("apify run complete", {
        run_id: result.runId,
        count: part.length,
        resolved_items: result.items.length,
        spend_cents: cents,
      });
      for (const lead of part) {
        const item = matchApifyItem(lead, result.items);
        if (applyProfileItem(lead, item)) stats.resolved += 1;
      }
    } catch (err) {
      stats.errors += part.length;
      for (const lead of part) {
        lead.resolveError = String(err.message || "apify failed").slice(0, 500);
      }
    }
  }

  if (apify?.scrapeCompanies) {
    current = await resolveCompanySizes({
      leads: out,
      apify,
      config,
      spend: current,
      supabase,
      log,
      stats,
    });
  }

  return { leads: out, stats, spend: current };
}

export async function resolveCompanySizes({ leads, apify, config, spend, supabase, log, stats }) {
  let current = spend;
  const need = leads.filter(
    (l) => !cleanSizeBand(l.engagerEmployees) && l.companyLinkedinUrl && !l.engagerLinkedinUrl,
  );
  if (!need.length) return current;
  const urls = [...new Set(need.map((l) => l.companyLinkedinUrl).filter(Boolean))];
  const estimate = urls.length * config.apifyCentsPerProfile;
  const jobCapUsd = apifyJobCapUsd(config);
  if (wouldExceedApifyJob(estimate, jobCapUsd)) {
    stats.skipped_cap += need.length;
    logApifyJobCap(log, "apify-company", estimate, jobCapUsd);
    return current;
  }
  try {
    const result = await apify.scrapeCompanies(urls, {
      maxTotalChargeUsd: jobCapUsd,
    });
    const cents = result.usageTotalUsd
      ? Number(result.usageTotalUsd) * 100
      : urls.length * config.apifyCentsPerProfile;
    if (cents > 0) {
      current = await addSpend(supabase, "apify", cents);
      stats.spend_cents += cents;
    }
    log.info("apify company run complete", {
      run_id: result.runId,
      count: urls.length,
      resolved_items: result.items.length,
      spend_cents: cents,
    });
    for (const lead of need) {
      const item = matchCompanyItem(lead, result.items);
      if (!item) continue;
      if (item.employees) {
        lead.engagerEmployees = item.employees;
        stats.resolved += 1;
      }
      if (item.website) {
        lead.engagerCompanyWebsite = item.website;
        lead.companyDomain = domainFromWebsite(item.website) || lead.companyDomain;
      }
      if (item.name && !lead.engagerCompany) {
        lead.engagerCompany = item.name;
        lead.companySource = "linkedin";
      }
    }
  } catch (err) {
    stats.errors += need.length;
    log.warn("apify company scrape failed", {
      error: String(err.message || err).slice(0, 200),
      count: urls.length,
    });
  }
  return current;
}

export function waterfallRowOf(lead) {
  return {
    domain: companyDomainOf(lead) || "",
    company_name: lead.engagerCompany || undefined,
    first_name: lead.engagerFirstName || String(lead.engagerFullName || "").split(/\s+/)[0] || undefined,
    last_name: lead.engagerLastName || undefined,
    title: lead.engagerJobTitle || undefined,
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
  if (hit.employee_range && !cleanSizeBand(lead.engagerEmployees)) {
    lead.engagerEmployees = cleanSizeBand(hit.employee_range) || hit.employee_range;
    changed = true;
  }
  return changed;
}

export async function resolveEmails({ leads, waterfall, config, spend, supabase, log }) {
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

  stats.attempted += rows.length;
  try {
    await waterfall.health();
    await waterfall.ensureClient();
    const started = await waterfall.enrich({
      rows,
      need: "email",
      requireTitleMatch: false,
      background: true,
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
  const domains = [
    ...new Set(
      [...(contacts || []), ...(rows || [])]
        .map((r) => r.domain)
        .filter(Boolean)
        .map((d) => String(d).toLowerCase()),
    ),
  ];
  if (!domains.length) return [];
  return selectInChunks(supabase, table, "domain, company_name, employee_range, website", "domain", domains);
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

function indexCompanies(companies) {
  const map = new Map();
  for (const row of companies || []) {
    const domain = String(row.domain || "").toLowerCase();
    if (domain) map.set(domain, row);
  }
  return map;
}

function logApifyJobCap(log, vendor, estimatedCents, capUsd) {
  log.warn("apify job would exceed per-job cap; skipping this batch", {
    reason: vendor,
    estimated_cents: estimatedCents,
    cap_usd: capUsd,
  });
}

export function applyResolvedFields(lead) {
  return {
    ...lead,
    first_name_n: normFirstName(lead.engagerFirstName),
    company_n: normCompany(lead.engagerCompany),
  };
}
