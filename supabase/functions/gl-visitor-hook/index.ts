import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SECRET = "sg_vis_17b3334f00c0";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nested(obj: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    const value = obj[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return {};
}

function str(...vals: unknown[]): string | null {
  for (const value of vals) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function itemsFrom(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  const body = asRecord(payload);
  for (const key of ["visitors", "leads", "data", "events", "results"]) {
    if (Array.isArray(body[key])) return body[key] as Record<string, unknown>[];
  }
  return [body];
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return new URL(withProto).hostname.replace(/^www\./i, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

function domainOf(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0]?.trim();
  return cleaned ? cleaned.toLowerCase() : null;
}

function linkedinOf(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProto.replace(/\/+$/, "").toLowerCase();
}

async function hashKey(parts: string[]): Promise<string> {
  const material = parts.filter(Boolean).join("|").toLowerCase();
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `vis_${hex.slice(0, 32)}`;
}

function statusFor(email: string | null, linkedin: string | null, company: string | null): string {
  if (!email && !linkedin) return "needs_identity";
  if (!company) return "needs_company";
  if (!email) return "needs_email";
  return "received";
}

async function mapVisitor(it: Record<string, unknown>, siteHint: string | null) {
  const person = nested(it, "person", "visitor", "lead", "contact");
  const company = nested(it, "company", "organization");

  const firstName = str(
    person.first_name,
    person.firstName,
    it.first_name,
    it.firstName,
    it.engagerFirstName,
    it.engager_first_name,
  );
  const lastName = str(
    person.last_name,
    person.lastName,
    it.last_name,
    it.lastName,
    it.engagerLastName,
    it.engager_last_name,
  );
  const fullName = str(
    person.name,
    person.full_name,
    person.fullName,
    it.name,
    it.full_name,
    it.fullName,
    it.engagerFullName,
    it.engager_full_name,
    [firstName, lastName].filter(Boolean).join(" ") || null,
  );
  const emailRaw = str(
    person.work_email,
    person.email,
    person.workEmail,
    it.work_email,
    it.email,
    it.engagerEmail,
    it.engager_email,
  );
  const email = emailRaw ? emailRaw.toLowerCase() : null;
  const linkedin = linkedinOf(str(
    person.linkedin_url,
    person.linkedin,
    person.profile_url,
    person.linkedinUrl,
    it.linkedin_url,
    it.linkedinUrl,
    it.linkedin,
    it.engagerLinkedinUrl,
    it.engager_linkedin_url,
  ));
  const companyName = str(
    company.name,
    company.company_name,
    company.companyName,
    it.company_name,
    it.companyName,
    it.engagerCompany,
    it.engager_company,
  );
  const companyDomain = domainOf(str(
    company.domain,
    company.website,
    company.company_domain,
    it.company_domain,
    it.companyDomain,
    it.domain,
    it.website,
  ));
  const jobTitle = str(
    person.title,
    person.job_title,
    person.headline,
    it.title,
    it.job_title,
    it.jobTitle,
    it.engagerJobTitle,
  );
  const employees = str(
    company.employee_count,
    company.employees,
    company.size,
    company.employee_size_range,
    it.engagerEmployees,
    it.engager_employees,
    it.employees,
  );
  const pageUrl = str(
    it.page_url,
    it.pageUrl,
    it.url,
    it.landing_page,
    it.landingPage,
    it.page,
    nested(it, "session").landing_page,
    nested(it, "session").entry_page,
  );
  const visitorId = str(
    it.visitorId,
    it.visitor_id,
    person.id,
    it.identifiedVisitorId,
    it.sessionId,
    it.session_id,
  );
  const leadId = str(it.leadId, it.lead_id, it.dedupeKey, it.dedupe_key);
  const city = str(person.city, it.city, it.engagerCity, company.city);
  const country = str(person.country, it.country, it.engagerCountry, company.country);
  const siteId = str(
    siteHint,
    it.site,
    it.site_id,
    it.siteId,
    it.config_id,
    hostOf(pageUrl),
    companyDomain,
  );

  const dedupeKey = leadId
    || visitorId
    || email
    || linkedin
    || await hashKey([fullName || "", companyName || "", companyDomain || "", pageUrl || "", siteId || ""]);

  return {
    dedupe_key: dedupeKey,
    visitor_id: visitorId || leadId,
    site_id: siteId,
    first_name: firstName,
    last_name: lastName,
    full_name: fullName,
    email,
    linkedin_url: linkedin,
    job_title: jobTitle,
    company_name: companyName,
    company_domain: companyDomain,
    company_employees: employees,
    page_url: pageUrl,
    city,
    country,
    campaign_id: null,
    campaign_name: null,
    lane: "visitor",
    status: statusFor(email, linkedin, companyName),
    routing_note: "visitor hook; not engager inbox",
    raw: it,
  };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, hook: "gl-visitor-hook" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const siteHint = str(url.searchParams.get("site"), url.searchParams.get("id"));
  const items = itemsFrom(payload);
  const byLane: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const rows = [];
  for (const item of items) {
    const row = await mapVisitor(asRecord(item), siteHint);
    byLane[row.lane] = (byLane[row.lane] ?? 0) + 1;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    rows.push(row);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { error, count } = await supabase
    .from("sg_visitor_inbox")
    .upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true, count: "exact" });

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    received: items.length,
    inserted: count ?? rows.length,
    by_lane: byLane,
    by_status: byStatus,
  }), {
    headers: { "Content-Type": "application/json" },
  });
});
