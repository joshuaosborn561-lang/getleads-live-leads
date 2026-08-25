import { mapPool, requestJson, withBackoff } from "../http.js";

const REACHER_URL = "https://api.reacher.email/v0/check_email";

const PASS = new Set(["safe", "valid", "deliverable"]);
const FAIL = new Set(["invalid", "undeliverable", "bounce", "risky", "unknown", "catch_all", "catchall"]);

export function n2bPassed(status) {
  return PASS.has(String(status || "").toLowerCase());
}

export function classifyN2b(payload) {
  const reachable = String(payload?.is_reachable || payload?.result || payload?.status || "").toLowerCase();
  const smtp = payload?.smtp && typeof payload.smtp === "object" ? payload.smtp : {};
  if (smtp.is_catch_all) return "catch_all";
  if (PASS.has(reachable)) return "safe";
  if (FAIL.has(reachable)) return reachable;
  return reachable || "unknown";
}

export function createNo2Bounce(config, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  async function checkOne(email) {
    return withBackoff(async () => {
      const res = await requestJson(REACHER_URL, {
        method: "POST",
        headers: {
          authorization: config.no2bounceApiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ to_email: email }),
        timeoutMs: 45_000,
        fetchImpl,
      });
      return classifyN2b(res.json || {});
    });
  }

  async function verifyMany(emails) {
    const unique = [...new Set(emails.map((e) => String(e || "").trim()).filter(Boolean))];
    const out = new Map();
    await mapPool(unique, config.n2bConcurrency, async (email) => {
      try {
        out.set(email.toLowerCase(), { status: await checkOne(email) });
      } catch (err) {
        out.set(email.toLowerCase(), { error: String(err.message || "n2b failed") });
      }
    });
    return out;
  }

  return { checkOne, verifyMany };
}
