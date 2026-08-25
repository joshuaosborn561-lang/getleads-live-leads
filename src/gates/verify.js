import {
  MV_HARD_BAD,
  MV_SECOND_PASS,
  billedMvCount,
  indexMvResults,
  lookupMvResult,
} from "../clients/millionverifier.js";
import { n2bPassed } from "../clients/no2bounce.js";
import { wouldExceedCap } from "../spend.js";
import { normalizeEmail } from "../util/email.js";

export function classifyMv(result) {
  const r = String(result || "").toLowerCase();
  if (r === "ok") return "verified";
  if (MV_HARD_BAD.has(r)) return "verified_bad";
  if (MV_SECOND_PASS.has(r)) return "second_pass";
  return "unknown_mv";
}

export function classifyN2bStatus(status) {
  return n2bPassed(status) ? "verified" : "verified_bad";
}

export function estimateMvCents(count, centsPerCredit) {
  return count * centsPerCredit;
}

export function estimateN2bCents(count, centsPerCheck) {
  return count * centsPerCheck;
}

export async function verifyRows({
  rows,
  config,
  spendCents,
  mv,
  n2b,
  onCapHit,
  charge,
}) {
  const stats = {
    verified: 0,
    verified_bad: 0,
    error: 0,
    cap_hit: false,
    released: 0,
    mv_file_id: null,
    mv_credits: 0,
    n2b_checks: 0,
    spend_added_cents: 0,
  };
  const patches = [];

  if (!rows.length) return { stats, patches };

  const mvEstimate = estimateMvCents(rows.length, config.mvCentsPerCredit);
  if (wouldExceedCap(spendCents, mvEstimate, config.monthlySpendCapCents)) {
    stats.cap_hit = true;
    stats.released = rows.length;
    await onCapHit({
      reason: "millionverifier",
      remaining: rows.length,
      spend_cents: spendCents,
      cap_cents: config.monthlySpendCapCents,
      would_cost_cents: mvEstimate,
    });
    return { stats, patches, releaseKeys: rows.map((r) => r.dedupe_key) };
  }

  let fileId;
  let info;
  let index;
  try {
    const uploaded = await mv.upload(rows);
    fileId = uploaded.fileId;
    stats.mv_file_id = fileId;
    info = await mv.poll(fileId);
    const csvRows = await mv.download(fileId);
    index = indexMvResults(csvRows);
  } catch (err) {
    return {
      stats: { ...stats, error: rows.length },
      patches: rows.map((row) => ({
        row,
        patch: { status: "error", routing_note: String(err.message || "mv failed").slice(0, 500) },
      })),
    };
  }

  const credits = Number(info?.credit ?? info?.credits ?? billedMvCount(
    rows.map((row) => lookupMvResult(row, index)),
  ));
  stats.mv_credits = credits;
  if (credits > 0) {
    const cents = credits * config.mvCentsPerCredit;
    stats.spend_added_cents += cents;
    spendCents = (await charge(cents)).spendCents;
  }

  const secondPass = [];
  for (const row of rows) {
    const result = lookupMvResult(row, index);
    const kind = classifyMv(result);
    if (kind === "verified") {
      stats.verified += 1;
      patches.push({
        row,
        patch: {
          status: "verified",
          mv_result: result || "ok",
          verification_source: "millionverifier",
          mv_file_id: fileId,
          routing_note: null,
        },
      });
    } else if (kind === "verified_bad") {
      stats.verified_bad += 1;
      patches.push({
        row,
        patch: {
          status: "verified_bad",
          mv_result: result,
          verification_source: "millionverifier",
          mv_file_id: fileId,
          routing_note: `mv:${result}`,
        },
      });
    } else if (kind === "second_pass") {
      secondPass.push({ row, mvResult: result });
    } else {
      stats.error += 1;
      patches.push({
        row,
        patch: {
          status: "error",
          mv_result: result || null,
          mv_file_id: fileId,
          routing_note: `unrecognized mv result: ${result || "empty"}`,
        },
      });
    }
  }

  if (!secondPass.length) return { stats, patches };

  const n2bEstimate = estimateN2bCents(secondPass.length, config.n2bCentsPerCheck);
  if (wouldExceedCap(spendCents, n2bEstimate, config.monthlySpendCapCents)) {
    stats.cap_hit = true;
    stats.released += secondPass.length;
    await onCapHit({
      reason: "no2bounce",
      remaining: secondPass.length,
      spend_cents: spendCents,
      cap_cents: config.monthlySpendCapCents,
      would_cost_cents: n2bEstimate,
    });
    return {
      stats,
      patches,
      releaseKeys: secondPass.map((x) => x.row.dedupe_key),
    };
  }

  let n2bMap;
  try {
    n2bMap = await n2b.verifyMany(secondPass.map((x) => x.row.engager_email));
  } catch (err) {
    return {
      stats: { ...stats, error: stats.error + secondPass.length },
      patches: [
        ...patches,
        ...secondPass.map(({ row, mvResult }) => ({
          row,
          patch: {
            status: "error",
            mv_result: mvResult,
            mv_file_id: fileId,
            routing_note: String(err.message || "n2b failed").slice(0, 500),
          },
        })),
      ],
    };
  }

  stats.n2b_checks = secondPass.length;
  const n2bCents = secondPass.length * config.n2bCentsPerCheck;
  stats.spend_added_cents += n2bCents;
  await charge(n2bCents);

  for (const { row, mvResult } of secondPass) {
    const email = normalizeEmail(row.engager_email);
    const n2bResult = n2bMap.get(email);
    if (!n2bResult || n2bResult.error) {
      stats.error += 1;
      patches.push({
        row,
        patch: {
          status: "error",
          mv_result: mvResult,
          mv_file_id: fileId,
          routing_note: String(n2bResult?.error || "n2b missing result").slice(0, 500),
        },
      });
      continue;
    }
    const n2bStatus = n2bResult.status;
    const status = classifyN2bStatus(n2bStatus);
    if (status === "verified") stats.verified += 1;
    else stats.verified_bad += 1;
    patches.push({
      row,
      patch: {
        status,
        mv_result: mvResult,
        n2b_status: n2bStatus,
        verification_source: "no2bounce",
        mv_file_id: fileId,
        routing_note: status === "verified_bad" ? `n2b:${n2bStatus}` : null,
      },
    });
  }

  return { stats, patches };
}
