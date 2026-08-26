import { chunk } from "../src/clients/webhook.js";
import { createVerifier } from "../src/clients/verifier.js";
import { loadConfig, SIZE_OK } from "../src/config.js";
import { verifyRows } from "../src/gates/verify.js";
import { countsByStatus, markByDedupeKeys, putFeed } from "../src/inbox.js";
import { createLogger } from "../src/logger.js";
import { cleanSizeBand } from "../src/normalize.js";
import { addSpend, loadSpend } from "../src/spend.js";
import { createSupabase, throwIfError } from "../src/supabase.js";
import { isEmail, normalizeEmail } from "../src/util/email.js";

const log = createLogger("sg-verify-unverified");
const PAGE = 400;
const BATCH = 500;
const SOURCE_STATUSES = [
  "needs_company_data",
  "needs_email",
  "dq_size",
  "duplicate",
  "error",
  "pending_verification",
  "verifying",
];

function uniqueByEmail(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const email = normalizeEmail(row.engager_email);
    if (!isEmail(email) || seen.has(email)) continue;
    seen.add(email);
    out.push(row);
  }
  return out;
}

function shouldPromoteVerified(row) {
  const band = cleanSizeBand(row.engager_employees);
  return Boolean(row.campaign_id && row.engager_company && SIZE_OK.includes(band));
}

function patchForRow(row, kind, runId) {
  const base = {
    verification_source: "email-verifier-progression",
    mv_file_id: runId,
  };
  if (kind === "verified_bad") {
    return { ...base, status: "verified_bad", routing_note: "verifier rejected" };
  }
  if (kind === "verified") {
    if (shouldPromoteVerified(row)) {
      return { ...base, status: "verified", routing_note: null };
    }
    return { ...base, routing_note: "verifier sendable; parked until size/campaign ready" };
  }
  return { ...base, routing_note: "verifier result missing" };
}

async function fetchUnverified(supabase) {
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
      if (!isEmail(row.engager_email)) continue;
      if (row.verification_source || row.mv_file_id) continue;
      out.push(row);
    }
  }
  return out;
}

async function applyKind(supabase, rows, kind, runId) {
  const groups = new Map();
  for (const row of rows) {
    const patch = patchForRow(row, kind, runId);
    const key = JSON.stringify(patch);
    if (!groups.has(key)) groups.set(key, { patch, keys: [] });
    groups.get(key).keys.push(row.dedupe_key);
  }
  let n = 0;
  for (const { patch, keys } of groups.values()) {
    n += await markByDedupeKeys(supabase, keys, patch);
  }
  return n;
}

async function main() {
  const config = loadConfig(process.env, process.argv);
  const supabase = createSupabase(config);
  const verifier = createVerifier(config);
  const spend = await loadSpend(supabase);
  const before = await countsByStatus(supabase);
  const allRows = await fetchUnverified(supabase);
  const unique = uniqueByEmail(allRows);
  log.info("verify pass start", {
    spend_cents: spend.spendCents,
    cap_cents: config.monthlySpendCapCents,
    candidate_rows: allRows.length,
    unique_emails: unique.length,
    batches: Math.ceil(unique.length / BATCH),
    needs_company_data: Number(before.needs_company_data || 0),
    verified: Number(before.verified || 0),
    verified_bad: Number(before.verified_bad || 0),
  });

  const byEmail = new Map();
  for (const row of allRows) {
    const email = normalizeEmail(row.engager_email);
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email).push(row);
  }

  let verified = 0;
  let verifiedBad = 0;
  let parkedSendable = 0;
  let missing = 0;
  let errors = 0;
  let bookedCents = 0;
  let batchNo = 0;
  for (const batch of chunk(unique, BATCH)) {
    batchNo += 1;
    log.info("verify batch start", { batch: batchNo, email_count: batch.length });
    const result = await verifyRows({
      rows: batch,
      config,
      spendCents: spend.spendCents,
      ignoreCap: true,
      verifier,
      publicBaseUrl: config.publicBaseUrl,
      putCsv: async (id, csv) =>
        putFeed(supabase, id, csv, {
          supabaseUrl: config.supabaseUrl,
          supabaseKey: config.supabaseServiceRoleKey,
        }),
      onCapHit: async () => {},
      charge: (vendor, cents) => addSpend(supabase, vendor, cents),
    });
    bookedCents += Number(result.stats.spend_added_cents || 0);
    if (result.stats.error && !result.stats.run_id) {
      errors += result.stats.error;
      log.warn("verify batch failed before results", {
        batch: batchNo,
        error_count: result.stats.error,
      });
      continue;
    }
    const runId = result.stats.run_id;
    for (const item of result.patches || []) {
      const email = normalizeEmail(item.row.engager_email);
      const matches = byEmail.get(email) || [item.row];
      const kind =
        item.patch.status === "verified"
          ? "verified"
          : item.patch.status === "verified_bad"
            ? "verified_bad"
            : "unknown";
      await applyKind(supabase, matches, kind, runId);
      if (kind === "verified_bad") verifiedBad += matches.length;
      else if (kind === "verified") {
        const promoted = matches.filter(shouldPromoteVerified).length;
        verified += promoted;
        parkedSendable += matches.length - promoted;
      } else missing += matches.length;
    }
    log.info("verify batch done", {
      batch: batchNo,
      run_id: runId,
      spend_added_cents: result.stats.spend_added_cents,
      mv_credits: result.stats.mv_credits,
      n2b_checks: result.stats.n2b_checks,
    });
  }

  const after = await countsByStatus(supabase);
  const afterSpend = await loadSpend(supabase);
  log.info("verify pass done", {
    unique_emails: unique.length,
    verified,
    parked_sendable: parkedSendable,
    verified_bad: verifiedBad,
    missing,
    errors,
    booked_cents: bookedCents,
    spend_cents: afterSpend.spendCents,
    cap_cents: config.monthlySpendCapCents,
    pending_verification: Number(after.pending_verification || 0),
    verified_now: Number(after.verified || 0),
    verified_bad_now: Number(after.verified_bad || 0),
    needs_company_data: Number(after.needs_company_data || 0),
  });
}

main().catch((err) => {
  log.error("verify pass failed", { error: String(err.message || err).slice(0, 200) });
  process.exit(1);
});
