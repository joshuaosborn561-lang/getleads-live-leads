import { putFeed } from "../src/inbox.js";
import { createSupabase } from "../src/supabase.js";
import { loadConfig } from "../src/config.js";
import { createVerifier } from "../src/clients/verifier.js";
import { createSmartlead } from "../src/clients/smartlead.js";
import { runSweep } from "../src/sweep.js";
import { createLogger } from "../src/logger.js";

const log = createLogger("sg-verify-now");

async function main() {
  const config = loadConfig(process.env, process.argv);
  const supabase = createSupabase(config);

  const reset = await supabase
    .from("sg_engager_inbox")
    .update({ status: "pending_verification", routing_note: null }, { count: "exact" })
    .eq("status", "error")
    .eq("routing_note", "HTTP 400 GET")
    .select("id");
  console.log(JSON.stringify({ step: "reset", n: reset.count ?? reset.data?.length ?? 0, error: reset.error?.message || null }));

  const probeId = `vf_preflight_${Date.now().toString(36)}`;
  const probe = await putFeed(supabase, probeId, "Email\npreflight@example.com\n", {
    supabaseUrl: config.supabaseUrl,
    supabaseKey: config.supabaseServiceRoleKey,
  });
  const probeHost = new URL(probe).hostname;
  const probeGet = await fetch(probe);
  const probeText = await probeGet.text();
  console.log(
    JSON.stringify({
      step: "preflight",
      host: probeHost,
      get: probeGet.status,
      header_ok: /^Email/i.test(probeText),
    }),
  );
  if (!probeGet.ok) throw new Error(`preflight GET ${probeGet.status}`);

  const counts = await runSweep({
    supabase,
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
