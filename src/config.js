function num(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const TERMINAL_STATUSES = Object.freeze([
  "needs_email",
  "needs_company_data",
  "pending_campaign",
  "dq_size",
  "suppressed",
  "duplicate",
  "verified_bad",
]);

export function loadConfig(env = process.env, argv = process.argv) {
  return {
    supabaseUrl: env.SUPABASE_URL || "",
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || "",
    smartleadApiKey: env.SMARTLEAD_API_KEY || "",
    smartleadBaseUrl: (env.SMARTLEAD_BASE_URL || "https://server.smartlead.ai/api/v1").replace(
      /\/$/,
      "",
    ),
    millionVerifierApiKey: env.MILLIONVERIFIER_API_KEY || "",
    no2bounceApiKey: env.NO2BOUNCE_API_KEY || "",
    monthlySpendCapCents: num(env, "MONTHLY_SPEND_CAP_CENTS", 500),
    mvCentsPerCredit: num(env, "MV_CENTS_PER_CREDIT", 0.178),
    n2bCentsPerCheck: num(env, "N2B_CENTS_PER_CHECK", 0.8),
    sweepIntervalMinutes: num(env, "SWEEP_INTERVAL_MINUTES", 15),
    sweepLimit: num(env, "SWEEP_LIMIT", 500),
    staleVerifyingMinutes: num(env, "STALE_VERIFYING_MINUTES", 45),
    importChunkSize: num(env, "IMPORT_CHUNK_SIZE", 200),
    port: num(env, "PORT", 8080),
    mvPollMs: num(env, "MV_POLL_MS", 10_000),
    mvTimeoutMs: num(env, "MV_TIMEOUT_MS", 30 * 60 * 1000),
    n2bConcurrency: num(env, "N2B_CONCURRENCY", 8),
    once: argv.includes("--once"),
  };
}

export function assertRuntimeConfig(config) {
  const missing = [];
  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!config.smartleadApiKey) missing.push("SMARTLEAD_API_KEY");
  if (!config.millionVerifierApiKey) missing.push("MILLIONVERIFIER_API_KEY");
  if (!config.no2bounceApiKey) missing.push("NO2BOUNCE_API_KEY");
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }
}

export function monthKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
