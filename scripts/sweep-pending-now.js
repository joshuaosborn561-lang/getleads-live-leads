import { createSmartlead } from "../src/clients/smartlead.js";
import { createVerifier } from "../src/clients/verifier.js";
import { loadConfig } from "../src/config.js";
import { countsByStatus } from "../src/inbox.js";
import { createLogger } from "../src/logger.js";
import { runSweep } from "../src/sweep.js";
import { createSupabase } from "../src/supabase.js";

const log = createLogger("sg-sweep-pending");

async function main() {
  const config = loadConfig(process.env, process.argv);
  const supabase = createSupabase(config);
  const before = await countsByStatus(supabase);
  log.info("sweep start", {
    pending_verification: Number(before.pending_verification || 0),
    verified: Number(before.verified || 0),
    staged: Number(before.staged || 0),
    imported: Number(before.imported || 0),
    error: Number(before.error || 0),
  });
  const counts = await runSweep({
    supabase,
    config,
    verifier: createVerifier(config),
    smartlead: createSmartlead(config),
    log,
    ignoreCap: true,
  });
  const after = await countsByStatus(supabase);
  log.info("sweep done", {
    ...counts,
    pending_verification: Number(after.pending_verification || 0),
    verified: Number(after.verified || 0),
    staged: Number(after.staged || 0),
    imported: Number(after.imported || 0),
    error: Number(after.error || 0),
  });
}

main().catch((err) => {
  log.error("sweep failed", { error: String(err.message || err).slice(0, 200) });
  process.exit(1);
});
