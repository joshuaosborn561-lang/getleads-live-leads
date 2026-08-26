/**
 * Re-import VerifyFall-stamped rows that failed on Smartlead HTTP 429.
 * Skips the per-lead Smartlead GET that caused the 429s. Campaigns stay drafted.
 */
import { createSmartlead } from "../src/clients/smartlead.js";
import { loadConfig, SIZE_OK } from "../src/config.js";
import { applyPatches } from "../src/sweep.js";
import { countsByStatus } from "../src/inbox.js";
import { createLogger } from "../src/logger.js";
import { importStaged } from "../src/gates/import.js";
import { stageVerified } from "../src/gates/stage.js";
import { cleanSizeBand } from "../src/normalize.js";
import { createSupabase, throwIfError } from "../src/supabase.js";
import { isEmail } from "../src/util/email.js";

const log = createLogger("sg-retry-import");
const PAGE = 400;
const NOTES = new Set(["smartlead: HTTP 429 GET", "HTTP 429 POST"]);

async function fetchRetryable(supabase) {
  const out = [];
  let afterId = 0;
  while (true) {
    let q = supabase
      .from("sg_engager_inbox")
      .select("*")
      .eq("status", "error")
      .eq("verification_source", "email-verifier-progression")
      .order("id", { ascending: true })
      .limit(PAGE);
    if (afterId) q = q.gt("id", afterId);
    const { data, error } = await q;
    throwIfError({ error }, "inbox page");
    const rows = data || [];
    if (!rows.length) break;
    afterId = rows[rows.length - 1].id;
    for (const row of rows) {
      if (!NOTES.has(String(row.routing_note || "").trim())) continue;
      if (!SIZE_OK.includes(cleanSizeBand(row.engager_employees) || "")) continue;
      if (!isEmail(row.engager_email) || !row.campaign_id) continue;
      out.push(row);
    }
  }
  return out;
}

async function main() {
  const config = loadConfig(process.env, process.argv);
  const supabase = createSupabase(config);
  const smartlead = createSmartlead(config);
  const before = await countsByStatus(supabase);
  const rows = await fetchRetryable(supabase);
  log.info("retry import start", {
    retryable: rows.length,
    campaigns: new Set(rows.map((r) => r.campaign_id)).size,
    imported: Number(before.imported || 0),
    error: Number(before.error || 0),
  });
  if (!rows.length) return;

  const staged = await stageVerified(supabase, rows);
  await applyPatches(supabase, staged.errors);
  log.info("staged", { ok: staged.staged.length, errors: staged.errors.length });

  const imported = await importStaged({
    rows: staged.staged.map((item) => item.row),
    smartlead,
    chunkSize: 40,
    pauseMs: 8_000,
    retry429: 5,
    onMismatch: (info) => {
      log.warn("smartlead import_mismatch; stopping campaign for this run", info);
    },
  });
  await applyPatches(supabase, imported.imported);
  await applyPatches(supabase, imported.mismatches);
  await applyPatches(supabase, imported.errors);

  const after = await countsByStatus(supabase);
  log.info("retry import done", {
    imported_now: imported.imported.length,
    mismatch: imported.mismatches.length,
    errors: imported.errors.length,
    imported: Number(after.imported || 0),
    error: Number(after.error || 0),
    staged: Number(after.staged || 0),
    import_mismatch: Number(after.import_mismatch || 0),
  });
}

main().catch((err) => {
  log.error("retry import failed", { error: String(err.message || err).slice(0, 200) });
  process.exit(1);
});
