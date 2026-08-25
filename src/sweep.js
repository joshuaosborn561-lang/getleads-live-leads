import { applyInboxDedupe, applySmartleadDedupe } from "./gates/dedupe.js";
import { importStaged } from "./gates/import.js";
import { stageVerified } from "./gates/stage.js";
import { applySuppression, loadSuppressionMap } from "./gates/suppression.js";
import { verifyRows } from "./gates/verify.js";
import {
  claimPending,
  fetchByStatus,
  fetchInboxByEmails,
  markByDedupeKeys,
  reclaimStale,
  releaseToPending,
} from "./inbox.js";
import { addSpend, loadSpend } from "./spend.js";

export function emptyCounts() {
  return {
    claimed: 0,
    suppressed: 0,
    duplicate: 0,
    verified: 0,
    verified_bad: 0,
    staged: 0,
    imported: 0,
    import_mismatch: 0,
    error: 0,
    released: 0,
    cap_hit: false,
    mv_file_id: null,
    spend_cents: 0,
  };
}

export async function applyPatches(supabase, items) {
  if (!items?.length) return 0;
  const groups = new Map();
  for (const item of items) {
    const key = JSON.stringify(item.patch);
    if (!groups.has(key)) groups.set(key, { patch: item.patch, keys: [] });
    groups.get(key).keys.push(item.row.dedupe_key);
  }
  let n = 0;
  for (const { patch, keys } of groups.values()) {
    n += await markByDedupeKeys(supabase, keys, patch);
  }
  return n;
}

export async function runSweep({ supabase, config, mv, n2b, smartlead, log }) {
  const counts = emptyCounts();

  counts.reclaimed = await reclaimStale(supabase, config.staleVerifyingMinutes);
  const claimed = await claimPending(supabase, config.sweepLimit);
  counts.claimed = claimed.length;

  if (claimed.length) {
    const suppression = await loadSuppressionMap(supabase);
    const { suppressed, remaining: afterSup } = applySuppression(claimed, suppression);
    await applyPatches(supabase, suppressed);
    counts.suppressed = suppressed.length;

    const existing = await fetchInboxByEmails(
      supabase,
      afterSup.map((r) => r.engager_email),
    );
    const { duplicates: inboxDupes, remaining: afterInbox } = applyInboxDedupe(afterSup, existing);
    await applyPatches(supabase, inboxDupes);
    counts.duplicate += inboxDupes.length;

    const {
      duplicates: slDupes,
      remaining: afterSl,
      errors: slErrors,
    } = await applySmartleadDedupe(afterInbox, smartlead);
    await applyPatches(supabase, slDupes);
    counts.duplicate += slDupes.length;
    if (slErrors.length) {
      await applyPatches(
        supabase,
        slErrors.map((row) => ({
          row,
          patch: { status: "error", routing_note: String(row.__error).slice(0, 500) },
        })),
      );
      counts.error += slErrors.length;
    }

    const spend = await loadSpend(supabase);
    counts.spend_cents = spend.spendCents;
    let capLogged = false;
    const onCapHit = async (info) => {
      if (capLogged) return;
      capLogged = true;
      counts.cap_hit = true;
      log.warn("monthly spend cap hit; leaving remaining rows at pending_verification", info);
    };

    const verified = await verifyRows({
      rows: afterSl,
      config,
      spendCents: spend.spendCents,
      mv,
      n2b,
      onCapHit,
      charge: (cents) => addSpend(supabase, cents),
    });
    counts.verified += verified.stats.verified;
    counts.verified_bad += verified.stats.verified_bad;
    counts.error += verified.stats.error;
    counts.released += verified.stats.released;
    counts.cap_hit = counts.cap_hit || verified.stats.cap_hit;
    counts.mv_file_id = verified.stats.mv_file_id;
    if (verified.releaseKeys?.length) {
      await releaseToPending(supabase, verified.releaseKeys);
    }
    await applyPatches(supabase, verified.patches);
    if (verified.stats.spend_added_cents) {
      counts.spend_cents += verified.stats.spend_added_cents;
    }
  }

  const toStage = await fetchByStatus(supabase, ["verified"]);
  if (toStage.length) {
    const staged = await stageVerified(supabase, toStage);
    await applyPatches(supabase, staged.staged);
    await applyPatches(supabase, staged.errors);
    counts.staged += staged.staged.length;
    counts.error += staged.errors.length;
  }

  const toImport = await fetchByStatus(supabase, ["staged", "import_mismatch"]);
  if (toImport.length) {
    const imported = await importStaged({
      rows: toImport,
      smartlead,
      chunkSize: config.importChunkSize,
      onMismatch: (info) => {
        log.warn("smartlead import_mismatch; stopping campaign for this sweep", info);
      },
    });
    await applyPatches(supabase, imported.imported);
    await applyPatches(supabase, imported.mismatches);
    await applyPatches(supabase, imported.errors);
    counts.imported += imported.imported.length;
    counts.import_mismatch += imported.mismatches.length;
    counts.error += imported.errors.length;
  }

  const idle = counts.verified === 0 && counts.imported === 0;
  log.info(idle ? "idle sweep" : "sweep complete", counts);
  return counts;
}
