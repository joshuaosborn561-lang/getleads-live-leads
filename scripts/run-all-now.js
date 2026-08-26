import { createSmartlead } from "../src/clients/smartlead.js";
import { createVerifier } from "../src/clients/verifier.js";
import { createWaterfall } from "../src/clients/waterfall.js";
import { loadConfig } from "../src/config.js";
import { countsByStatus } from "../src/inbox.js";
import { createLogger } from "../src/logger.js";
import { runParkedResolution } from "../src/parked.js";
import { loadSpend } from "../src/spend.js";
import { createSupabase } from "../src/supabase.js";
import { runSweep } from "../src/sweep.js";

const log = createLogger("sg-run-all");

function sweepSummary(counts) {
  return {
    claimed: counts.claimed,
    duplicate: counts.duplicate,
    verified: counts.verified,
    verified_bad: counts.verified_bad,
    staged: counts.staged,
    imported: counts.imported,
    error: counts.error,
    cap_hit: counts.cap_hit,
    run_id: counts.run_id,
  };
}

async function main() {
  const config = loadConfig(process.env, process.argv);
  const supabase = createSupabase(config);
  const deps = {
    supabase,
    config,
    waterfall: createWaterfall(config),
    verifier: createVerifier(config),
    smartlead: createSmartlead(config),
    log,
  };

  let batches = 0;
  for (let i = 1; i <= 20; i += 1) {
    const spend = await loadSpend(supabase);
    const statuses = await countsByStatus(supabase);
    const parked = Number(statuses.needs_company_data || 0) + Number(statuses.needs_email || 0);
    console.log(
      JSON.stringify({
        step: "batch_start",
        i,
        parked,
        pending_verification: Number(statuses.pending_verification || 0),
        imported: Number(statuses.imported || 0),
        spend_cents: spend.spendCents,
        cap_cents: config.monthlySpendCapCents,
      }),
    );
    if (parked <= 0) break;
    if (spend.spendCents >= config.monthlySpendCapCents) {
      console.log(JSON.stringify({ step: "cap_stop", spend_cents: spend.spendCents }));
      break;
    }

    const parkedStats = await runParkedResolution(deps);
    const sweepStats = await runSweep(deps);
    batches += 1;
    console.log(
      JSON.stringify({
        step: "batch_done",
        i,
        parked: parkedStats,
        sweep: sweepSummary(sweepStats),
      }),
    );
    if (parkedStats.cap_hit || sweepStats.cap_hit) break;
    if (parkedStats.claimed === 0) break;
  }

  const finalStatuses = await countsByStatus(supabase);
  const finalSpend = await loadSpend(supabase);
  console.log(
    JSON.stringify({
      step: "done",
      batches,
      statuses: finalStatuses,
      spend_cents: finalSpend.spendCents,
      apify_cents: finalSpend.apify_cents,
      waterfall_cents: finalSpend.waterfall_cents,
      verifier_cents: finalSpend.verifier_cents,
    }),
  );
}

main().catch((err) => {
  console.log(JSON.stringify({ step: "fatal", error: String(err.message || err).slice(0, 300) }));
  process.exit(1);
});
