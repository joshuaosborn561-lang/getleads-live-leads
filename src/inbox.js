import { throwIfError } from "./supabase.js";
import { TERMINAL_STATUSES } from "./config.js";

export async function bootstrapSchema(supabase) {
  const { error } = await supabase.rpc("sg_engager_bootstrap");
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

export async function markError(supabase, keys, message) {
  return markByDedupeKeys(
    supabase,
    keys,
    { status: "error", routing_note: String(message || "error").slice(0, 500) },
    ["verifying", "verified", "staged", "import_mismatch"],
  );
}

export async function fetchByStatus(supabase, statuses, extraFilter = {}) {
  let q = supabase.from("sg_engager_inbox").select("*").in("status", statuses).order("id", { ascending: true });
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

export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}
