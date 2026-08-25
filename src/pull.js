import { newerThanHwm } from "./clients/getleads.js";
import { applyProspectGates } from "./gates/prospect.js";
import { loadSuppressionMap } from "./gates/suppression.js";
import { loadHwm, saveFirstRunReport, upsertHwm } from "./inbox.js";
import { applyResolvedFields, resolveCompanies, resolveEmails } from "./resolve.js";
import { loadSpend } from "./spend.js";

export function emptyPullCounts() {
  return {
    pulled: 0,
    new: 0,
    dropped_recency: 0,
    dropped_self: 0,
    dropped_noise: 0,
    dropped_suppression: 0,
    posted: 0,
    failed_count: 0,
    company_resolved: 0,
    email_resolved: 0,
    cap_hit: false,
    by_lane: {},
    by_status: {},
  };
}

export function filterNewLeads(leads, hwmRows) {
  const hwm = new Map((hwmRows || []).map((r) => [r.profile_id, r.captured_at_hwm]));
  const fresh = [];
  const maxByProfile = new Map();
  for (const lead of leads) {
    const profileId = lead.profileId;
    if (!profileId) continue;
    if (lead.capturedAt) {
      const prev = maxByProfile.get(profileId);
      if (!prev || new Date(lead.capturedAt) > new Date(prev)) maxByProfile.set(profileId, lead.capturedAt);
    }
    if (newerThanHwm(lead, hwm.get(profileId))) fresh.push(lead);
  }
  return { fresh, maxByProfile };
}

export async function runPull({ supabase, config, getleads, apify, waterfall, webhook, log }) {
  const counts = emptyPullCounts();
  const profiles = await getleads.listMonitoredProfiles();
  log.info("getleads profiles", { count: profiles.length });

  const hwmRows = await loadHwm(supabase);
  const isFirstRun = hwmRows.length === 0;
  const { leads, pages } = await getleads.listAllLeads({
    limit: 200,
    onPage: ({ pages: p, pulled }) => {
      if (p === 1 || p % 10 === 0) log.info("getleads page", { pages: p, pulled });
    },
  });
  counts.pulled = leads.length;
  log.info("getleads pulled", { pulled: leads.length, pages, first_run: isFirstRun });

  const { fresh, maxByProfile } = filterNewLeads(leads, hwmRows);
  counts.new = fresh.length;

  const suppression = await loadSuppressionMap(supabase);
  const gated = applyProspectGates(fresh, { recencyDays: config.recencyDays, suppression });
  counts.dropped_recency = gated.drops.recency;
  counts.dropped_self = gated.drops.self;
  counts.dropped_noise = gated.drops.noise;
  counts.dropped_suppression = gated.drops.suppression;

  log.info("prospect gates", {
    kept: gated.kept.length,
    dropped_recency: gated.drops.recency,
    dropped_self: gated.drops.self,
    dropped_noise: gated.drops.noise,
    dropped_suppression: gated.drops.suppression,
  });

  let working = gated.kept.slice();
  const spend = await loadSpend(supabase);
  const resolveLimit = config.enrichmentBatchLimit;
  const toResolve = working.slice(0, resolveLimit);
  const leftover = working.slice(resolveLimit);
  let capHit = false;

  const company = await resolveCompanies({
    leads: toResolve,
    apify,
    config,
    spend,
    supabase,
    log,
    cap: config.monthlySpendCapCents,
  });
  counts.company_resolved = company.stats.resolved;
  capHit = capHit || company.stats.skipped_cap > 0;

  const email = await resolveEmails({
    leads: company.leads,
    waterfall,
    config,
    spend: company.spend,
    supabase,
    log,
    cap: config.monthlySpendCapCents,
  });
  counts.email_resolved = email.stats.resolved;
  capHit = capHit || email.stats.skipped_cap > 0;
  counts.cap_hit = capHit;
  working = [...email.leads.map(applyResolvedFields), ...leftover];

  const posted = await webhook.postAll(working, {
    onBatch: (info) => {
      if (!info.ok) log.warn("webhook batch failed after retries", { count: info.count });
      else log.info("webhook batch", { count: info.count, by_lane: info.body?.by_lane, by_status: info.body?.by_status });
    },
  });
  counts.posted = posted.posted;
  counts.failed_count = posted.failed_count;
  counts.by_lane = posted.by_lane;
  counts.by_status = posted.by_status;

  const now = new Date().toISOString();
  const hwmUpserts = [...maxByProfile.entries()].map(([profileId, captured]) => {
    const profile = profiles.find((p) => p.profileId === profileId) || {};
    return {
      profile_id: profileId,
      captured_at_hwm: captured,
      last_scraped_at: profile.lastScrapedAt || null,
      last_run_at: now,
      last_pulled: leads.filter((l) => l.profileId === profileId).length,
    };
  });
  await upsertHwm(supabase, hwmUpserts);

  if (isFirstRun) {
    const report = {
      total_pulled: counts.pulled,
      new: counts.new,
      dropped_by_recency: counts.dropped_recency,
      age_histogram: gated.ageHistogram,
      dropped_by_self: counts.dropped_self,
      dropped_by_noise: counts.dropped_noise,
      dropped_by_suppression: counts.dropped_suppression,
      by_enrichment_status: gated.byEnrichment,
      by_size_band: gated.bySizeBand,
      resolution: {
        company: company.stats,
        email: { ...email.stats, job_id: email.stats.job_id },
      },
      webhook: { by_lane: posted.by_lane, by_status: posted.by_status, posted: posted.posted, failed_count: posted.failed_count },
      imported: 0,
    };
    const saved = await saveFirstRunReport(supabase, report);
    log.info("first-run report", { saved, total_pulled: report.total_pulled, dropped_recency: report.dropped_by_recency });
    counts.first_run = report;
  }

  const idle = counts.pulled === 0 || (counts.new === 0 && counts.posted === 0);
  log.info(idle ? "idle pull" : "pull complete", counts);
  return counts;
}
