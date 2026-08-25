import { CREATOR_SLUGS } from "../creators.js";
import { companiesMatch, linkedinSlug, normCompany } from "../normalize.js";
import { emailDomain, normalizeEmail } from "../util/email.js";

export const NOISE_PATTERNS = [
  /\bstudent\b/i,
  /\bintern\b/i,
  /\bretired\b/i,
  /seeking opportunities/i,
  /open to work/i,
  /looking for my next/i,
];

export const AGE_BUCKETS = [
  { key: "0_30", maxDays: 30 },
  { key: "31_90", maxDays: 90 },
  { key: "91_180", maxDays: 180 },
  { key: "181_365", maxDays: 365 },
  { key: "1y_2y", maxDays: 730 },
  { key: "2y_5y", maxDays: 1825 },
  { key: "5y_plus", maxDays: Infinity },
];

export function emptyDropCounts() {
  return {
    recency: 0,
    self: 0,
    noise: 0,
    suppression: 0,
    no_dedupe_key: 0,
  };
}

export function emptyHistogram() {
  return Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, 0]));
}

export function ageDays(engagementDate, now = new Date()) {
  if (!engagementDate) return null;
  const t = new Date(engagementDate).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

export function histogramBucket(days) {
  if (days == null || days < 0) return "unknown";
  for (const bucket of AGE_BUCKETS) {
    if (days <= bucket.maxDays) return bucket.key;
  }
  return "5y_plus";
}

export function isNoiseTitle(...parts) {
  const text = parts.filter(Boolean).join(" ");
  if (!text) return false;
  return NOISE_PATTERNS.some((re) => re.test(text));
}

export function isCreatorSelf(lead) {
  const engagerSlug = linkedinSlug(lead.engagerLinkedinUrl);
  const authorSlug = linkedinSlug(lead.authorLinkedinUrl);
  if (engagerSlug && CREATOR_SLUGS.has(engagerSlug)) return true;
  if (engagerSlug && authorSlug && engagerSlug === authorSlug) return true;
  return false;
}

export function titleFields(lead) {
  return [
    lead.engagerJobTitle,
    lead.engagerHeadline,
    lead.engagerSeniority,
    lead.engagerFunction,
    lead.engager_job_title,
    lead.engager_seniority,
  ];
}

export function applyProspectGates(leads, { recencyDays = 90, suppression, now } = {}) {
  const kept = [];
  const drops = emptyDropCounts();
  const ageHistogram = emptyHistogram();
  ageHistogram.unknown = 0;
  const byEnrichment = {};
  const bySizeBand = {};

  const bump = (map, key) => {
    const k = key || "unknown";
    map[k] = (map[k] || 0) + 1;
  };

  for (const lead of leads) {
    if (!lead.dedupeKey && !lead.leadId) {
      drops.no_dedupe_key += 1;
      continue;
    }
    const days = ageDays(lead.engagementDate, now);
    bump(ageHistogram, histogramBucket(days));
    bump(byEnrichment, lead.enrichmentStatus || (lead.engagerEmail ? "succeeded" : "failed"));
    bump(bySizeBand, lead.engagerEmployees || "unknown");

    if (days == null || days > recencyDays) {
      drops.recency += 1;
      continue;
    }
    if (isCreatorSelf(lead)) {
      drops.self += 1;
      continue;
    }
    if (isNoiseTitle(...titleFields(lead))) {
      drops.noise += 1;
      continue;
    }
    const domain = emailDomain(normalizeEmail(lead.engagerEmail));
    if (domain && suppression?.has(domain)) {
      drops.suppression += 1;
      continue;
    }
    kept.push(lead);
  }

  return { kept, drops, ageHistogram, byEnrichment, bySizeBand };
}

export function applyEmploymentCurrency(lead, linkedinCompany) {
  const enriched = lead.engagerCompany;
  if (!linkedinCompany || !enriched) {
    return {
      company: linkedinCompany || enriched || null,
      mismatch: false,
      source: linkedinCompany ? "linkedin" : enriched ? "enrichment" : null,
    };
  }
  if (companiesMatch(linkedinCompany, enriched)) {
    return { company: linkedinCompany, mismatch: false, source: "linkedin" };
  }
  return { company: linkedinCompany, mismatch: true, source: "linkedin" };
}

export function flagEmploymentOnLead(lead, linkedinCompany) {
  const result = applyEmploymentCurrency(lead, linkedinCompany);
  return {
    ...lead,
    engagerCompany: result.company || lead.engagerCompany,
    employmentMismatch: result.mismatch,
    companySource: result.source,
    company_n: result.company ? normCompany(result.company) : lead.company_n,
  };
}
