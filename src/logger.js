const BLOCKED_KEYS = new Set([
  "email",
  "engager_email",
  "first_name",
  "last_name",
  "first_name_n",
  "engager_first_name",
  "engager_last_name",
  "engager_full_name",
  "company",
  "company_n",
  "engager_company",
  "linkedin",
  "linkedin_profile",
  "engager_linkedin_url",
  "dedupe_key",
  "row",
  "rows",
  "lead",
  "leads",
]);

function stamp() {
  return new Date().toISOString();
}

export function sanitizeLogExtra(extra) {
  if (!extra || typeof extra !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(extra)) {
    if (BLOCKED_KEYS.has(key)) continue;
    if (value && typeof value === "object") continue;
    out[key] = value;
  }
  return out;
}

export function createLogger(name = "sg-engager") {
  return {
    info(message, extra) {
      console.log(JSON.stringify({ ts: stamp(), level: "info", name, message, ...sanitizeLogExtra(extra) }));
    },
    warn(message, extra) {
      console.warn(JSON.stringify({ ts: stamp(), level: "warn", name, message, ...sanitizeLogExtra(extra) }));
    },
    error(message, extra) {
      console.error(JSON.stringify({ ts: stamp(), level: "error", name, message, ...sanitizeLogExtra(extra) }));
    },
  };
}
