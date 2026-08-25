import { createSupabase } from "../src/supabase.js";
import { loadConfig } from "../src/config.js";
import { createVerifier } from "../src/clients/verifier.js";
import { createSmartlead } from "../src/clients/smartlead.js";
import { runSweep } from "../src/sweep.js";
import { createLogger } from "../src/logger.js";

const log = createLogger("sg-stage-import");

async function main() {
  const config = loadConfig(process.env, process.argv);
  const counts = await runSweep({
    supabase: createSupabase(config),
    config,
    verifier: createVerifier(config),
    smartlead: createSmartlead(config),
    log,
  });
  console.log(JSON.stringify({ step: "sweep", ...counts }));
}

main().catch((err) => {
  console.log(JSON.stringify({ step: "fatal", error: String(err.message || err).slice(0, 300) }));
  process.exit(1);
});
