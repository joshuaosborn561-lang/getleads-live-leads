import { throwIfError } from "./supabase.js";
import { TERMINAL_STATUSES } from "./config.js";

export async function bootstrapSchema(supabase) {
  const { error } = await supabase.rpc("sg_pipeline_bootstrap");
  if (error) throw new Error(`bootstrap: ${error.message}`);
}

export async function reclaimStale(supabase, staleMinutes) {
  const { data, error } = await supabase.rpc("sg_engager_reclaim_stale", {
    p_minutes: staleMinutes,
  });
  if (error) throw new Error(`reclaim: ${error.message}`);
  return Number(data || 0);
}

export async function claimPending(supabase, limit) {
  const { data, error } = await supabase.rpc("claim_sg_engager_inbox", {
    p_limit: limit,
  });
  if (error) throw new Error(`claim: ${error.message}`);
  return data || [];
}

export async function markByDedupeKeys(supabase, keys, patch, fromStatuses) {
  const unique = [...new Set(keys.filter(Boolean))];
  if (!unique.length) return 0;
  let q = supabase.from("sg_engager_inbox").update(patch).in("dedupe_key", unique);
  if (fromStatuses?.length) q = q.in("status", fromStatuses);
  const { error, count } = await q.select("id", { count: "exact", head: true });
  throwIfError({ error }, "inbox update");
  return count ?? unique.length;
}

export async function releaseToPending(supabase, keys) {
  return markByDedupeKeys(
    supabase,
    keys,
    { status: "pending_verification", routing_note: null },
    ["verifying"],
  );
}

export async function fetchByStatus(supabase, statuses, extraFilter = {}) {
  let q = supabase.from("sg_engager_inbox").select("*").in("status", statuses);
  const orders = extraFilter.orders || [["id", { ascending: true }]];
  for (const [column, options] of orders) {
    q = q.order(column, options);
  }
  if (extraFilter.limit) q = q.limit(extraFilter.limit);
  const { data, error } = await q;
  throwIfError({ error }, "inbox select");
  return data || [];
}

export async function fetchInboxByEmails(supabase, emails) {
  const unique = [...new Set(emails.map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))];
  if (!unique.length) return [];
  const { data, error } = await supabase.rpc("sg_engager_inbox_by_emails", {
    p_emails: unique,
  });
  throwIfError({ error }, "inbox email lookup");
  return data || [];
}

export async function countsByStatus(supabase) {
  const { data, error } = await supabase.rpc("sg_pipeline_status_counts");
  if (error) {
    const fallback = await supabase.from("sg_engager_inbox").select("status");
    throwIfError(fallback, "inbox counts");
    const map = {};
    for (const row of fallback.data || []) {
      map[row.status || "unknown"] = (map[row.status || "unknown"] || 0) + 1;
    }
    return map;
  }
  const map = {};
  for (const row of data || []) map[row.status] = Number(row.n || 0);
  return map;
}

export async function loadHwm(supabase) {
  const { data, error } = await supabase.from("sg_pipeline_hwm").select("*");
  throwIfError({ error }, "hwm select");
  return data || [];
}

export async function upsertHwm(supabase, rows) {
  if (!rows?.length) return 0;
  const { error } = await supabase.from("sg_pipeline_hwm").upsert(rows, { onConflict: "profile_id" });
  throwIfError({ error }, "hwm upsert");
  return rows.length;
}

export async function saveFirstRunReport(supabase, report) {
  const { data: existing, error: readErr } = await supabase
    .from("sg_pipeline_first_run")
    .select("id")
    .eq("id", 1)
    .maybeSingle();
  throwIfError({ error: readErr }, "first run read");
  if (existing) return false;
  const { error } = await supabase.from("sg_pipeline_first_run").insert({ id: 1, report });
  if (error && /duplicate|unique/i.test(error.message)) return false;
  throwIfError({ error }, "first run insert");
  return true;
}

export async function loadFirstRunReport(supabase) {
  const { data, error } = await supabase.from("sg_pipeline_first_run").select("report, created_at").eq("id", 1).maybeSingle();
  throwIfError({ error }, "first run load");
  return data || null;
}

export async function putFeed(supabase, id, csv) {
  const path = `${id}.csv`;
  if (supabase.storage?.from) {
    try {
      const uploaded = await supabase.storage.from("sg-engager-feeds").upload(path, csv, {
        contentType: "text/csv; charset=utf-8",
        upsert: true,
      });
      if (!uploaded?.error) {
        const { data } = supabase.storage.from("sg-engager-feeds").getPublicUrl(path);
        if (data?.publicUrl) return data.publicUrl;
      }
    } catch {
      // fall through to the in-process CSV host
    }
  }
  const { error } = await supabase.from("sg_pipeline_feeds").upsert({ id, csv }, { onConflict: "id" });
  throwIfError({ error }, "feed upsert");
  return null;
}

export async function getFeed(supabase, id) {
  const { data, error } = await supabase.from("sg_pipeline_feeds").select("csv").eq("id", id).maybeSingle();
  throwIfError({ error }, "feed get");
  return data?.csv || null;
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

export function inboxToLead(row) {
  return {
    dedupeKey: row.dedupe_key,
    leadId: row.lead_id,
    profileId: row.profile_id,
    authorLinkedinUrl: row.author_linkedin_url,
    authorDisplayName: row.author_display_name,
    engagementType: row.engagement_type,
    engagementDate: row.engagement_date,
    engagerFirstName: row.engager_first_name,
    engagerLastName: row.engager_last_name,
    engagerFullName: row.engager_full_name,
    engagerLinkedinUrl: row.engager_linkedin_url,
    engagerEmail: row.engager_email,
    engagerCompany: row.engager_company,
    engagerEmployees: row.engager_employees,
    engagerCity: row.engager_city,
    engagerCountry: row.engager_country,
    engagerSeniority: row.engager_seniority,
    engagerFunction: row.engager_function,
    engagerJobTitle: row.engager_job_title,
    engagerCompanyWebsite: row.company_domain ? `https://${row.company_domain}` : null,
    enrichmentStatus: row.enrichment_status,
    campaignId: row.campaign_id,
    status: row.status,
    resolutionAttempts: row.resolution_attempts || 0,
  };
}
