function num(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
}

function str(env, name, fallback = "") {
  const raw = env[name];
  return raw == null || raw === "" ? fallback : String(raw).trim();
}

/** Terminal for the whole pipeline — never reprocessed. */
export const TERMINAL_STATUSES = Object.freeze([
  "dq_size",
  "pending_campaign",
  "suppressed",
  "duplicate",
  "verified_bad",
  "imported",
  "unresolvable",
]);

export const WORKABLE_RESOLUTION = Object.freeze(["needs_email", "needs_company_data"]);

export const SIZE_OK = Object.freeze(["11 to 50", "51 to 200", "201 to 500"]);
export const SIZE_DQ = Object.freeze([
  "1 to 10",
  "501 to 1000",
  "1001 to 5000",
  "5001 to 10000",
  "10000+",
  "10001+",
]);

export function loadConfig(env = process.env, argv = process.argv) {
  const railwayPublic = str(env, "RAILWAY_PUBLIC_DOMAIN");
  return {
    supabaseUrl: str(env, "SUPABASE_URL"),
    supabaseServiceRoleKey: str(env, "SUPABASE_SERVICE_ROLE_KEY"),
    webhookUrl: str(
      env,
      "WEBHOOK_URL",
      "https://azpapwtnrbzywlnxxecz.supabase.co/functions/v1/gl-engager-hook",
    ),
    webhookToken: str(env, "WEBHOOK_TOKEN", "sg_eng_9f4c21ab7de6"),
    getleadsApiKey: str(env, "GETLEADS_API_KEY"),
    getleadsBaseUrl: str(env, "GETLEADS_BASE_URL", "https://app.getleads.io").replace(/\/$/, ""),
    apifyToken: str(env, "APIFY_TOKEN"),
    apifyActor: str(env, "APIFY_ACTOR", "harvestapi/linkedin-profile-scraper"),
    apifyCompanyActor: str(env, "APIFY_COMPANY_ACTOR", "harvestapi/linkedin-company"),
    emailWaterfallMcpUrl: str(
      env,
      "EMAIL_WATERFALL_MCP_URL",
      "https://email-waterfall-production-021b.up.railway.app/mcp",
    ),
    emailVerifierMcpUrl: str(
      env,
      "EMAIL_VERIFIER_MCP_URL",
      "https://verifyfall-production.up.railway.app/mcp",
    ),
    waterfallClientTag: str(env, "WATERFALL_CLIENT_TAG", "salesglider"),
    smartleadApiKey: str(env, "SMARTLEAD_API_KEY"),
    smartleadBaseUrl: str(env, "SMARTLEAD_BASE_URL", "https://server.smartlead.ai/api/v1").replace(
      /\/$/,
      "",
    ),
    smartleadClientId: str(env, "SMARTLEAD_CLIENT_ID", "345263"),
    recencyDays: num(env, "RECENCY_DAYS", 90),
    enrichmentBatchLimit: num(env, "ENRICHMENT_BATCH_LIMIT", 250),
    monthlySpendCapCents: num(env, "MONTHLY_SPEND_CAP_CENTS", 500),
    apifyJobCapUsd: num(env, "APIFY_JOB_CAP_USD", 50),
    runIntervalMinutes: num(env, "RUN_INTERVAL_MINUTES", 60),
    verifySweepIntervalMinutes: num(env, "VERIFY_SWEEP_INTERVAL_MINUTES", 15),
    sweepLimit: num(env, "SWEEP_LIMIT", 500),
    staleVerifyingMinutes: num(env, "STALE_VERIFYING_MINUTES", 45),
    importChunkSize: num(env, "IMPORT_CHUNK_SIZE", 200),
    webhookChunkSize: num(env, "WEBHOOK_CHUNK_SIZE", 200),
    webhookDelayMs: num(env, "WEBHOOK_DELAY_MS", 400),
    maxResolutionAttempts: num(env, "MAX_RESOLUTION_ATTEMPTS", 3),
    apifyBatchSize: num(env, "APIFY_BATCH_SIZE", 50),
    apifyCentsPerProfile: num(env, "APIFY_CENTS_PER_PROFILE", 0.4),
    waterfallCentsPerRow: num(env, "WATERFALL_CENTS_PER_ROW", 15),
    mvCentsPerCredit: num(env, "MV_CENTS_PER_CREDIT", 0.178),
    n2bCentsPerCheck: num(env, "N2B_CENTS_PER_CHECK", 0.8),
    port: num(env, "PORT", 8080),
    publicBaseUrl: str(
      env,
      "PUBLIC_BASE_URL",
      railwayPublic ? `https://${railwayPublic}` : "",
    ).replace(/\/$/, ""),
    once: argv.includes("--once"),
    pullOnly: argv.includes("--pull-only"),
    verifyOnly: argv.includes("--verify-only"),
  };
}

export function assertRuntimeConfig(config) {
  const missing = [];
  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!config.getleadsApiKey) missing.push("GETLEADS_API_KEY");
  if (!config.smartleadApiKey) missing.push("SMARTLEAD_API_KEY");
  if (missing.length) throw new Error(`Missing required env: ${missing.join(", ")}`);
}

export function monthKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
