import { createWaterfall } from "../src/clients/waterfall.js";
import { loadConfig } from "../src/config.js";
import { countsByStatus } from "../src/inbox.js";
import { createLogger } from "../src/logger.js";
import { runParkedResolution } from "../src/parked.js";
import { loadSpend } from "../src/spend.js";
import { createSupabase, throwIfError } from "../src/supabase.js";

const log = createLogger("sg-apply-existing-wf");
const PAGE = 400;

async function fetchParkedDomainPage(supabase, afterId) {
  let q = supabase
    .from("sg_engager_inbox")
    .select("*")
    .in("status", ["needs_email", "needs_company_data"])
    .not("company_domain", "is", null)
    .neq("company_domain", "")
    .order("id", { ascending: true })
    .limit(PAGE);
  if (afterId) q = q.gt("id", afterId);
  const { data, error } = await q;
  throwIfError({ error }, "inbox page");
  return data || [];
}

async function main() {
  const config = loadConfig(process.env, process.argv);
  const supabase = createSupabase(config);
  const spend = await loadSpend(supabase);
  const before = await countsByStatus(supabase);
  console.log(
    JSON.stringify({
      step: "start",
      spend_cents: spend.spendCents,
      cap_cents: config.monthlySpendCapCents,
      max_tier: config.waterfallMaxTier,
      needs_email: Number(before.needs_email || 0),
      needs_company_data: Number(before.needs_company_data || 0),
      pending_verification: Number(before.pending_verification || 0),
    }),
  );

  const deps = {
    supabase,
    config,
    waterfall: createWaterfall(config),
    log,
  };

  let afterId = 0;
  let pages = 0;
  let claimed = 0;
  let updated = 0;
  let capHit = false;
  while (true) {
    const rows = await fetchParkedDomainPage(supabase, afterId);
    if (!rows.length) break;
    afterId = rows[rows.length - 1].id;
    const stats = await runParkedResolution(deps, { rows });
    pages += 1;
    claimed += stats.claimed;
    updated += stats.updated;
    capHit = capHit || stats.cap_hit;
    console.log(
      JSON.stringify({
        step: "page",
        pages,
        claimed: stats.claimed,
        updated: stats.updated,
        unresolvable: stats.unresolvable,
        cap_hit: stats.cap_hit,
      }),
    );
  }

  const after = await countsByStatus(supabase);
  const afterSpend = await loadSpend(supabase);
  console.log(
    JSON.stringify({
      step: "done",
      pages,
      claimed,
      updated,
      cap_hit: capHit,
      spend_cents: afterSpend.spendCents,
      needs_email: Number(after.needs_email || 0),
      needs_company_data: Number(after.needs_company_data || 0),
      pending_verification: Number(after.pending_verification || 0),
      imported: Number(after.imported || 0),
    }),
  );
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
