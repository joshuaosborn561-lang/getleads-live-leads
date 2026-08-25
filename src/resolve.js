import { chunk } from "./clients/webhook.js";
import { applyEmploymentCurrency } from "./gates/prospect.js";
import { cleanSizeBand, domainFromWebsite, linkedinSlug, normCompany, normFirstName } from "./normalize.js";
import { addSpend, wouldExceedCap } from "./spend.js";
import { emailDomain, normalizeEmail } from "./util/email.js";

export function needsCompany(lead) {
  return !String(lead.engagerCompany || "").trim() || !cleanSizeBand(lead.engagerEmployees);
}

export function needsEmail(lead) {
  return !normalizeEmail(lead.engagerEmail);
}

export function companyDomainOf(lead) {
  if (lead.companyDomain) return lead.companyDomain;
  const fromSite = domainFromWebsite(lead.engagerCompanyWebsite);
  if (fromSite) return fromSite;
  const fromEmail = emailDomain(normalizeEmail(lead.engagerEmail));
  if (fromEmail && !isFreemail(fromEmail)) return fromEmail;
  return "";
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
  const slug = linkedinSlug(lead.engagerLinkedinUrl);
  return (
    items.find((item) => item.linkedinUrl && linkedinSlug(item.linkedinUrl) === slug) ||
    items.find((item) => item.publicIdentifier && item.publicIdentifier.toLowerCase() === slug) ||
    items.find((item) => item.query && String(item.query).includes(slug)) ||
    null
  );
}

export async function resolveCompanies({ leads, apify, config, spend, supabase, log, cap }) {
  const stats = { attempted: 0, resolved: 0, skipped_cap: 0, errors: 0, spend_cents: 0 };
  const out = leads.map((l) => ({ ...l }));
  const missing = out.filter((l) => needsCompany(l) && l.engagerLinkedinUrl);
  if (!missing.length) return { leads: out, stats, spend };
  if (!config.apifyToken && !apify?.scrapeProfiles) return { leads: out, stats, spend };
  if (!config.apifyToken) {
    log.warn("APIFY_TOKEN missing; skipping company resolution", { remaining: missing.length });
    return { leads: out, stats, spend };
  }

  let current = spend;
  const remainingBudget = () => cap - current.spendCents;
  const canAfford = (n) =>
    !wouldExceedCap(current.spendCents, n * config.apifyCentsPerProfile, cap);

  for (const part of chunk(missing, config.apifyBatchSize)) {
    if (!canAfford(part.length) || remainingBudget() <= 0) {
      stats.skipped_cap += part.length;
      await logCap(log, "apify", current, cap, part.length * config.apifyCentsPerProfile);
      break;
    }
    stats.attempted += part.length;
    try {
      const result = await apify.scrapeProfiles(part.map((l) => l.engagerLinkedinUrl), {
        maxTotalChargeUsd: Math.max(0.05, (part.length * config.apifyCentsPerProfile) / 100 + 0.1),
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
        if (!item?.company && !item?.employees) continue;
        if (item.company) {
          const currency = applyEmploymentCurrency(lead, item.company);
          lead.engagerCompany = currency.company;
          lead.employmentMismatch = currency.mismatch;
          lead.companySource = currency.source;
        }
        if (item.employees) lead.engagerEmployees = item.employees;
        if (item.title) lead.engagerJobTitle = item.title;
        if (item.city) lead.engagerCity = item.city;
        if (item.country) lead.engagerCountry = item.country;
        if (item.website) lead.engagerCompanyWebsite = item.website;
        lead.companyDomain = domainFromWebsite(item.website) || lead.companyDomain;
        if (item.company || item.employees) stats.resolved += 1;
      }
    } catch (err) {
      stats.errors += part.length;
      for (const lead of part) {
        lead.resolveError = String(err.message || "apify failed").slice(0, 500);
      }
    }
  }

  return { leads: out, stats, spend: current };
}

export async function resolveEmails({ leads, waterfall, config, spend, supabase, log, cap }) {
  const stats = { attempted: 0, resolved: 0, skipped_cap: 0, skipped_no_domain: 0, errors: 0, spend_cents: 0, job_id: null };
  const out = leads.map((l) => ({ ...l }));
  const missing = out.filter((l) => !needsCompany(l) && needsEmail(l) && (l.engagerFirstName || l.engagerFullName));
  if (!missing.length) return { leads: out, stats, spend };

  let current = spend;
  const rows = [];
  const indexed = [];
  for (const lead of missing) {
    const domain = companyDomainOf(lead);
    if (!domain) {
      stats.skipped_no_domain += 1;
      continue;
    }
    rows.push({
      domain,
      company_name: lead.engagerCompany,
      first_name: lead.engagerFirstName || String(lead.engagerFullName || "").split(/\s+/)[0] || null,
      last_name: lead.engagerLastName || null,
      title: lead.engagerJobTitle || null,
      linkedin_url: lead.engagerLinkedinUrl || null,
    });
    indexed.push(lead);
  }
  if (!rows.length) return { leads: out, stats, spend: current };
  if (!config.emailWaterfallMcpUrl) return { leads: out, stats, spend: current };

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
    });
    const jobId = started?.job_id || started?.id || started?.jobId || null;
    stats.job_id = jobId;
    if (jobId) await waterfall.waitForJob(jobId);
    const contacts = await readWaterfallContacts(supabase, config.waterfallClientTag, rows);
    const cents = Number(started?.cost_cents || started?.spend_cents || 0) || estimate;
    current = await addSpend(supabase, "waterfall", cents);
    stats.spend_cents += cents;
    log.info("waterfall job complete", { job_id: jobId, count: rows.length, matched: contacts.length, spend_cents: cents });
    const byKey = indexContacts(contacts);
    for (const lead of indexed) {
      const domain = companyDomainOf(lead);
      const first = (lead.engagerFirstName || "").toLowerCase();
      const last = (lead.engagerLastName || "").toLowerCase();
      const hit =
        byKey.get(`${domain}|${first}|${last}`) ||
        byKey.get(`${domain}|${first}|`) ||
        null;
      if (hit?.email) {
        lead.engagerEmail = hit.email;
        lead.emailSource = hit.source_tier || "waterfall";
        stats.resolved += 1;
      }
    }
  } catch (err) {
    stats.errors += rows.length;
    log.warn("waterfall failed", { error: String(err.message || err).slice(0, 200), count: rows.length });
    for (const lead of indexed) {
      lead.resolveError = String(err.message || "waterfall failed").slice(0, 500);
    }
  }

  return { leads: out, stats, spend: current };
}

export async function readWaterfallContacts(supabase, clientTag, rows) {
  const table = `${clientTag}_wf_contacts`;
  const domains = [...new Set(rows.map((r) => r.domain).filter(Boolean))];
  if (!domains.length) return [];
  const { data, error } = await supabase.from(table).select("domain, first_name, last_name, email, source_tier").in("domain", domains);
  if (error) throw new Error(`waterfall contacts: ${error.message}`);
  return (data || []).filter((r) => r.email);
}

function indexContacts(contacts) {
  const map = new Map();
  for (const row of contacts) {
    const domain = String(row.domain || "").toLowerCase();
    const first = String(row.first_name || "").toLowerCase();
    const last = String(row.last_name || "").toLowerCase();
    if (domain && first && last) map.set(`${domain}|${first}|${last}`, row);
    if (domain && first) map.set(`${domain}|${first}|`, row);
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
