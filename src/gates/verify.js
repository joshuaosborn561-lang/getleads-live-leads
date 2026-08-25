import { parseCsv } from "../util/csv.js";
import { normalizeEmail } from "../util/email.js";
import { extractRunId } from "../clients/verifier.js";
import { wouldExceedCap } from "../spend.js";

export function estimateVerifierCents(count, config) {
  return count * config.mvCentsPerCredit + count * config.n2bCentsPerCheck;
}

export function classifyFromSets(email, sendable, rejected) {
  const key = normalizeEmail(email);
  if (sendable.has(key)) return "verified";
  if (rejected.has(key)) return "verified_bad";
  return "unknown";
}

export function emailsFromCsv(text) {
  const rows = parseCsv(text);
  const out = new Set();
  for (const row of rows) {
    const email = normalizeEmail(row.email || row.engager_email || row["e-mail"]);
    if (email) out.add(email);
  }
  return out;
}

export async function verifyRows({
  rows,
  config,
  spendCents,
  verifier,
  putCsv,
  publicBaseUrl,
  fetchImpl = globalThis.fetch,
  onCapHit,
  charge,
}) {
  const stats = {
    verified: 0,
    verified_bad: 0,
    error: 0,
    cap_hit: false,
    released: 0,
    run_id: null,
    spend_added_cents: 0,
    mv_credits: 0,
    n2b_checks: 0,
  };
  const patches = [];
  if (!rows.length) return { stats, patches };

  const estimate = estimateVerifierCents(rows.length, config);
  if (wouldExceedCap(spendCents, estimate, config.monthlySpendCapCents)) {
    stats.cap_hit = true;
    stats.released = rows.length;
    await onCapHit({
      reason: "verifier",
      remaining: rows.length,
      spend_cents: spendCents,
      cap_cents: config.monthlySpendCapCents,
      would_cost_cents: estimate,
    });
    return { stats, patches, releaseKeys: rows.map((r) => r.dedupe_key) };
  }

  if (!publicBaseUrl) {
    return {
      stats: { ...stats, error: rows.length },
      patches: rows.map((row) => ({
        row,
        patch: { status: "error", routing_note: "PUBLIC_BASE_URL missing; cannot host verifier CSV" },
      })),
    };
  }

  const feedId = `vf_${Date.now().toString(36)}`;
  const header = "Email\n";
  const csv = header + rows.map((r) => normalizeEmail(r.engager_email)).join("\n") + "\n";
  await putCsv(feedId, csv);
  const fileUrl = `${publicBaseUrl.replace(/\/$/, "")}/feeds/${feedId}.csv`;

  let runId;
  let run;
  try {
    const started = await verifier.start({
      fileUrl,
      segmentName: `sg-engager-${new Date().toISOString().slice(0, 16)}`,
    });
    runId = extractRunId(started);
    stats.run_id = runId;
    run = await verifier.waitForRun(runId);
  } catch (err) {
    return {
      stats: { ...stats, error: rows.length },
      patches: rows.map((row) => ({
        row,
        patch: { status: "error", routing_note: String(err.message || "verifier failed").slice(0, 500) },
      })),
    };
  }

  stats.mv_credits = Number(run?.mv_credits_used || 0);
  stats.n2b_checks = Number(run?.n2b_credits_used || 0);
  const cents =
    stats.mv_credits * config.mvCentsPerCredit + stats.n2b_checks * config.n2bCentsPerCheck;
  if (cents > 0) {
    stats.spend_added_cents += cents;
    await charge("verifier", cents);
  }

  let sendable = new Set();
  let rejected = new Set();
  try {
    const result = await verifier.results(runId);
    const downloads = result?.downloads || result || {};
    if (downloads.sendable_url) {
      const text = await (await fetchImpl(downloads.sendable_url)).text();
      sendable = emailsFromCsv(text);
    }
    if (downloads.rejected_url) {
      const text = await (await fetchImpl(downloads.rejected_url)).text();
      rejected = emailsFromCsv(text);
    }
  } catch (err) {
    return {
      stats: { ...stats, error: rows.length },
      patches: rows.map((row) => ({
        row,
        patch: {
          status: "error",
          routing_note: String(err.message || "verifier results failed").slice(0, 500),
          mv_file_id: runId,
        },
      })),
    };
  }

  for (const row of rows) {
    const kind = classifyFromSets(row.engager_email, sendable, rejected);
    if (kind === "verified") {
      stats.verified += 1;
      patches.push({
        row,
        patch: {
          status: "verified",
          verification_source: "email-verifier-progression",
          mv_file_id: runId,
          routing_note: null,
        },
      });
    } else if (kind === "verified_bad") {
      stats.verified_bad += 1;
      patches.push({
        row,
        patch: {
          status: "verified_bad",
          verification_source: "email-verifier-progression",
          mv_file_id: runId,
          routing_note: "verifier rejected",
        },
      });
    } else {
      stats.error += 1;
      patches.push({
        row,
        patch: {
          status: "error",
          verification_source: "email-verifier-progression",
          mv_file_id: runId,
          routing_note: "verifier result missing",
        },
      });
    }
  }

  return { stats, patches };
}
