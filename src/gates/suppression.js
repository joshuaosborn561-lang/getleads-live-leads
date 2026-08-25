import { emailDomain, normalizeEmail } from "../util/email.js";

export const SEED_DOMAINS = [
  { domain: "trumethods.com", reason: "creator" },
  { domain: "technologymarketingtoolkit.com", reason: "creator" },
  { domain: "tallannresources.com", reason: "creator" },
  { domain: "staffingmastery.com", reason: "creator" },
  { domain: "salesglidergrowth.com", reason: "creator" },
  { domain: "crelate.com", reason: "competitor" },
  { domain: "haleymarketing.com", reason: "competitor" },
  { domain: "axial.net", reason: "competitor" },
  { domain: "dealroom.net", reason: "competitor" },
  { domain: "mascience.com", reason: "competitor" },
];

export function suppressionNote(reason, domain) {
  return `suppressed: ${reason} domain ${domain}`;
}

export async function loadSuppressionMap(supabase) {
  const { data, error } = await supabase.from("sg_engager_suppression").select("domain, reason");
  if (error) throw new Error(`suppression load: ${error.message}`);
  const map = new Map();
  for (const row of data || []) {
    map.set(String(row.domain).toLowerCase(), row.reason || "suppressed");
  }
  return map;
}

export function applySuppression(rows, suppression) {
  const suppressed = [];
  const remaining = [];
  for (const row of rows) {
    const domain = emailDomain(normalizeEmail(row.engager_email));
    const reason = domain ? suppression.get(domain) : null;
    if (reason) {
      suppressed.push({
        row,
        patch: {
          status: "suppressed",
          routing_note: suppressionNote(reason, domain),
        },
      });
    } else {
      remaining.push(row);
    }
  }
  return { suppressed, remaining };
}
