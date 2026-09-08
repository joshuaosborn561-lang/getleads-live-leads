import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type SB = ReturnType<typeof createClient>;
const SECRET = "sg_vis_17b3334f00c0";
const CHANNEL = "C0BS6H62P3P";
const SL_CLIENT = 345263;
const CAMPAIGN_ID = 3916543;
const CAMPAIGN_NAME = "SalesGlider Warm Web Visitors";

const rec = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const nest = (o: Record<string, unknown>, ...ks: string[]) => {
  for (const k of ks) {
    const v = o[k];
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  }
  return {};
};
const str = (...vals: unknown[]) => {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
};
const PHONE_KEY = /^(phone|mobile|cell|cellphone|phones|personcellphone|phone_number|phonenumber|mobile_phone|mobilephone|direct_dial|directdial|work_phone|cell_phone|personal_phone)$/i;
const valuesOf = (...vals: unknown[]) => {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (v == null) return;
    if (typeof v === "number" && Number.isFinite(v)) {
      out.push(String(v));
      return;
    }
    if (typeof v !== "string") {
      if (Array.isArray(v)) v.forEach(push);
      else if (typeof v === "object") {
        const r = rec(v);
        push(r.value ?? r.email ?? r.phone ?? r.number);
      }
      return;
    }
    const t = v.trim();
    if (!t) return;
    if (t.startsWith("[") || t.startsWith("{")) {
      try {
        push(JSON.parse(t));
        return;
      } catch { /* plain string */ }
    }
    for (const part of t.split(/[,;|]/)) {
      const p = part.trim();
      if (p) out.push(p);
    }
  };
  vals.forEach(push);
  return out;
};
const firstEmail = (...vals: unknown[]) => {
  for (const v of valuesOf(...vals)) {
    const e = v.toLowerCase();
    if (e.includes("@")) return e;
  }
  return null;
};
const phoneOf = (...objs: Record<string, unknown>[]) => {
  for (const o of objs) {
    const v = valuesOf(
      o.personCellphone, o.person_cellphone, o.phones, o.phone, o.mobile, o.cell, o.cellphone,
      o.phone_number, o.phoneNumber, o.mobile_phone, o.mobilePhone, o.direct_dial, o.directDial,
      o.work_phone, o.cell_phone, o.cellPhone, o.personal_phone,
    ).find((p) => /[0-9]{7,}/.test(p));
    if (v) return v;
    const custom = o.custom_fields ?? o.customFields ?? o.custom;
    if (Array.isArray(custom)) {
      for (const item of custom) {
        const r = rec(item);
        const name = str(r.name, r.key, r.field);
        if (name && PHONE_KEY.test(name.replace(/[\s-]/g, "_"))) {
          const cv = str(r.value, r.val);
          if (cv) return cv;
        }
      }
    } else if (custom && typeof custom === "object") {
      const nested = phoneOf(rec(custom));
      if (nested) return nested;
    }
  }
  return null;
};
const itemsFrom = (payload: unknown) => {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  const b = rec(payload);
  for (const k of ["visitors", "leads", "data", "events", "results"]) {
    if (Array.isArray(b[k])) return b[k] as Record<string, unknown>[];
  }
  return [b];
};
const hostOf = (url: string | null) => {
  if (!url) return null;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./i, "").toLowerCase() || null;
  } catch { return null; }
};
const domainOf = (raw: string | null) => {
  if (!raw) return null;
  const c = raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0]?.trim();
  return c ? c.toLowerCase() : null;
};
const liOf = (raw: string | null) => {
  if (!raw) return null;
  const t = raw.trim();
  return (/^https?:\/\//i.test(t) ? t : `https://${t}`).replace(/\/+$/, "").toLowerCase();
};
const tsOf = (...vals: unknown[]) => {
  for (const v of vals) {
    if (typeof v !== "string" || !v.trim()) continue;
    const d = new Date(v.trim());
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
};
const hashKey = async (parts: string[]) => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.filter(Boolean).join("|").toLowerCase()));
  return `vis_${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32)}`;
};
const strip = (raw: string | null) =>
  (raw || "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const clip = (raw: string, max = 700) => {
  const t = raw.replace(/[ \t]+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const quote = (raw: string) => clip(raw, 600).split("\n").map((l) => `> ${l}`).join("\n");

async function mapVisitor(it: Record<string, unknown>, siteHint: string | null) {
  const person = nest(it, "person", "visitor", "contact");
  const lead = nest(it, "lead");
  const src = { ...lead, ...it, ...person };
  const company = nest(it, "company", "organization");
  const visit = nest(it, "visit", "session");
  let first = str(src.personFirstName, src.first_name, src.firstName, person.first_name, person.firstName);
  let last = str(src.personLastName, src.last_name, src.lastName, person.last_name, person.lastName);
  const full = str(
    src.personFullName, src.full_name, src.name, person.name, person.full_name,
    [first, last].filter(Boolean).join(" ") || null,
  );
  if (!first && full) {
    const p = full.split(/\s+/);
    first = p[0] || null;
    last = last || p.slice(1).join(" ") || null;
  }
  const email = firstEmail(
    src.personEmail, src.work_email, src.email, src.businessEmails,
    person.work_email, person.email, src.personalEmails,
  );
  const phone = phoneOf(src, person, lead, nest(it, "visitor"), it);
  const linkedin = liOf(str(
    src.personLinkedinUrl, src.linkedin_url, src.linkedin, src.profile_url,
    person.linkedin_url, person.linkedin, person.profile_url,
  ));
  const companyName = str(src.companyName, src.company_name, company.name, company.company_name, it.engagerCompany);
  const companyDomain = domainOf(str(src.companyDomain, src.company_domain, company.domain, company.website, src.domain, it.domain));
  const page = str(src.pageUrl, src.page_url, visit.page, visit.page_url, visit.url, visit.landing_page, it.page, it.url);
  const visitorId = str(src.visitorId, src.visitor_id, src.sessionId, person.id);
  const leadId = str(src.leadId, src.lead_id, src.dedupeKey, src.dedupe_key);
  const site = str(siteHint, src.site, src.site_id, hostOf(page), companyDomain, domainOf(str(src.domain, it.domain)));
  const status = !email && !linkedin ? "needs_identity" : !companyName ? "needs_company" : !email ? "needs_email" : "received";
  return {
    dedupe_key: leadId || visitorId || email || linkedin || await hashKey([full || "", companyName || "", companyDomain || "", page || "", site || ""]),
    visitor_id: visitorId || leadId,
    site_id: site,
    first_name: first,
    last_name: last,
    full_name: full,
    email,
    phone,
    linkedin_url: linkedin,
    job_title: str(src.personTitle, src.title, src.job_title, src.headline, person.title, person.job_title, person.headline),
    company_name: companyName,
    company_domain: companyDomain,
    company_employees: str(src.companyEmployees, src.company_employees, company.employee_count, company.size, company.employees),
    page_url: page,
    visited_at: tsOf(src.visitedAt, src.capturedAt, src.visited_at, visit.ts, visit.timestamp, visit.visited_at, it.timestamp, it.ts),
    city: str(src.personalCity, src.companyCity, src.city, person.city, company.city),
    seniority: str(src.seniority, src.personSeniority, src.seniority_level),
    department: str(src.personDepartment, src.department, src.function),
    industry: str(src.companyIndustry, src.industry, company.industry),
    country: str(src.personalCountry, src.companyCountry, src.country, person.country, company.country),
    campaign_id: CAMPAIGN_ID,
    campaign_name: CAMPAIGN_NAME,
    lane: "visitor",
    status,
    routing_note: "visitor hook; campaign 3916543",
    raw: it,
  };
}
type Row = Awaited<ReturnType<typeof mapVisitor>>;
type ImportRes = { imported: boolean; reason: string };

async function secret(db: SB, name: string) {
  const { data, error } = await db.rpc("get_vault_secret", { p_name: name });
  return error || typeof data !== "string" || !data ? null : data;
}

async function importVisitor(db: SB, row: Row, slHits: number): Promise<ImportRes> {
  row.campaign_id = CAMPAIGN_ID;
  row.campaign_name = CAMPAIGN_NAME;
  if (!row.email) return { imported: false, reason: "no_email" };
  if (slHits > 0) return { imported: false, reason: "already_in_smartlead" };
  const key = await secret(db, "smartlead_salesglider");
  if (!key) return { imported: false, reason: "no_smartlead_token" };
  try {
    const u = new URL(`https://server.smartlead.ai/api/v1/campaigns/${CAMPAIGN_ID}/leads`);
    u.searchParams.set("api_key", key);
    const lead: Record<string, unknown> = {
      email: row.email,
      first_name: row.first_name,
      last_name: row.last_name,
      company_name: row.company_name,
    };
    if (row.linkedin_url) lead.linkedin_profile = row.linkedin_url;
    if (row.phone) lead.phone_number = row.phone;
    if (row.company_domain) lead.website = row.company_domain;
    const loc = [row.city, row.country].filter(Boolean).join(", ");
    if (loc) lead.location = loc;
    const res = await fetch(u.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lead_list: [lead] }),
    });
    const body = rec(await res.json().catch(() => ({})));
    const upload = Number(body.upload_count ?? rec(body.data).upload_count ?? 0);
    if (res.ok && upload >= 1) return { imported: true, reason: "imported" };
    if (res.ok) return { imported: false, reason: "duplicate_or_rejected" };
    return { imported: false, reason: `http_${res.status}` };
  } catch {
    return { imported: false, reason: "import_error" };
  }
}

function applyImportStatus(row: Row, importRes: ImportRes) {
  if (importRes.imported) {
    row.status = "imported";
    row.routing_note = `imported to ${CAMPAIGN_NAME}`;
    return;
  }
  if (importRes.reason === "already_in_smartlead") {
    row.routing_note = "skipped import; already in SalesGlider Smartlead";
    return;
  }
  if (importRes.reason === "duplicate_or_rejected") {
    row.status = "duplicate";
    row.routing_note = "smartlead upload_count=0";
    return;
  }
  if (importRes.reason === "no_email" && row.status === "received") {
    row.status = "needs_email";
    row.routing_note = "visitor hook; no email to import";
  }
}

async function matchSmartlead(db: SB, row: Row) {
  const hits: Record<string, unknown>[] = [];
  if (row.email) {
    const { data } = await db.from("leads")
      .select("id,title,company,company_size,status,category,campaigns(name,smartlead_campaign_id)")
      .eq("smartlead_client_id", SL_CLIENT).ilike("email", row.email).limit(5);
    hits.push(...(data || []));
  }
  if (!hits.length && row.first_name && row.last_name && row.company_name) {
    const { data } = await db.from("leads")
      .select("id,title,company,company_size,status,category,campaigns(name,smartlead_campaign_id)")
      .eq("smartlead_client_id", SL_CLIENT)
      .ilike("first_name", row.first_name).ilike("last_name", row.last_name).ilike("company", row.company_name)
      .limit(3);
    if ((data || []).length === 1) hits.push(...data!);
  }
  const out = [];
  for (const lead of hits) {
    const { data: messages } = await db.from("messages")
      .select("subject,body,sequence_number,sent_at").eq("lead_id", String(lead.id)).eq("direction", "outbound")
      .order("sent_at", { ascending: true }).limit(5);
    const { data: sends } = await db.from("sends")
      .select("step_number,sent,opened,replied,bounced").eq("lead_id", String(lead.id))
      .order("step_number", { ascending: true }).limit(8);
    const camp = rec(Array.isArray(lead.campaigns) ? lead.campaigns[0] : lead.campaigns);
    out.push({
      campaign: str(camp.name),
      status: str(lead.status),
      category: str(lead.category),
      messages: (messages || []).map((m) => ({ step: m.sequence_number, subject: str(m.subject), body: clip(strip(str(m.body))) })),
      sends: (sends || []).map((s) => ({ step: s.step_number, sent: !!s.sent, opened: !!s.opened, replied: !!s.replied, bounced: !!s.bounced })),
    });
  }
  return out;
}

async function hr(token: string, path: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.heyreach.io/api/public${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": token },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const hrItems = (json: unknown) => {
  const o = rec(json);
  if (Array.isArray(o.items)) return o.items as Record<string, unknown>[];
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  return [];
};
const ours = (v: unknown) => ["ME", "US", "YOU", "SENDER", "OUTBOUND", "FROM_US", "THE_SENDER"].includes(String(v || "").toUpperCase());

async function matchHeyreach(token: string, row: Row) {
  const campaigns: string[] = [];
  const messages: string[] = [];
  let profile = row.linkedin_url;
  let phone: string | null = null;
  let found = false;
  if (!row.email && !row.linkedin_url) {
    return { found, profile_url: profile, phone, campaigns, messages };
  }
  const camps = await hr(token, "/campaign/GetCampaignsForLead", { email: row.email, profileUrl: row.linkedin_url });
  if (camps.status < 400) {
    for (const it of hrItems(camps.json)) {
      found = true;
      const n = str(it.name, it.campaignName, rec(it.campaign).name);
      if (n) campaigns.push(n);
    }
  }
  if (row.linkedin_url) {
    const lead = await hr(token, "/lead/GetLead", { profileUrl: row.linkedin_url });
    const p = rec(hrItems(lead.json)[0] || rec(lead.json).lead || lead.json);
    profile = liOf(str(p.profileUrl, rec(p.linkedInUserProfile).profileUrl)) || profile;
    phone = phone || phoneOf(p, rec(p.linkedInUserProfile));
    if (lead.status < 400 && (p.profileUrl || p.id || p.firstName)) found = true;
  }
  let convs: Record<string, unknown>[] = [];
  const search = row.email || row.linkedin_url;
  for (const filters of [
    { searchString: search, leadProfileUrl: row.linkedin_url },
    { search_string: search, lead_profile_url: row.linkedin_url },
  ]) {
    if (!search) break;
    const conv = await hr(token, "/inbox/GetConversationsV2", { filters, offset: 0, limit: 10 });
    convs = hrItems(conv.json);
    if (convs.length || conv.status < 400) break;
  }
  for (const it of convs.slice(0, 3)) {
    found = true;
    const who = rec(it.correspondentProfile || it.correspondent || it.lead);
    profile = liOf(str(who.profileUrl, who.linkedinUrl, it.profileUrl, profile)) || profile;
    phone = phone || phoneOf(who, rec(it));
    const cn = str(it.campaignName, rec(it.campaign).name);
    if (cn) campaigns.push(cn);
    const last = str(it.lastMessageText, it.lastMessage);
    if (last && ours(str(it.lastMessageSender, it.lastMessageFrom))) messages.push(clip(strip(last)));
    const accountId = it.accountId ?? it.linkedInAccountId;
    const conversationId = it.id ?? it.conversationId;
    if (accountId && conversationId) {
      for (const path of ["/inbox/GetChatroom", "/inbox/GetConversation"]) {
        const room = await hr(token, path, { accountId, conversationId, linkedInAccountId: accountId });
        const msgs = Array.isArray(rec(room.json).messages) ? rec(room.json).messages as Record<string, unknown>[] : hrItems(room.json);
        for (const m of msgs) {
          const body = str(m.text, m.body, m.content, m.message);
          const sender = str(m.sender, m.from, m.direction, m.messageSender);
          if (body && (ours(sender) || sender == null)) messages.push(clip(strip(body)));
        }
        if (room.status < 400) break;
      }
    }
  }
  return { found, profile_url: profile, phone, campaigns: [...new Set(campaigns)].slice(0, 6), messages: messages.slice(0, 5) };
}

function importLine(importRes: ImportRes) {
  if (importRes.imported) return `Smartlead import: ${CAMPAIGN_NAME}`;
  if (importRes.reason === "already_in_smartlead") return "Smartlead import: skipped (already in a SalesGlider campaign)";
  if (importRes.reason === "no_email") return "Smartlead import: skipped (no email)";
  if (importRes.reason === "duplicate_or_rejected") return "Smartlead import: skipped (duplicate or rejected)";
  return `Smartlead import: skipped (${importRes.reason})`;
}

function card(
  row: Row,
  sl: Awaited<ReturnType<typeof matchSmartlead>>,
  hrMatch: Awaited<ReturnType<typeof matchHeyreach>>,
  importRes: ImportRes,
) {
  const matched = sl.length > 0 || hrMatch.found;
  const name = row.full_name || [row.first_name, row.last_name].filter(Boolean).join(" ") || "Unknown visitor";
  const li = row.linkedin_url || (hrMatch.found ? hrMatch.profile_url : null);
  const header = matched ? "Website visitor · MATCH" : importRes.imported ? "Website visitor · imported" : "Website visitor · no outreach match";
  const extra = rec(row as unknown as Record<string, unknown>);
  const who = [
    `*${name}*`,
    li ? `LinkedIn: <${li}|open profile>` : "LinkedIn: _not found_",
    [row.job_title, extra.seniority, extra.department].filter(Boolean).join(" · ") || null,
    [row.company_name, row.company_domain, row.company_employees, extra.industry].filter(Boolean).join(" · ") || null,
    row.email ? `\`${row.email}\`` : null,
    row.phone ? `Cell: ${row.phone}` : "Cell: _not provided_",
    row.page_url ? `Landed on: ${row.page_url}` : null,
    row.site_id ? `Site: ${row.site_id}` : null,
    importLine(importRes),
  ].filter(Boolean).join("\n");
  const slTxt = sl.length
    ? sl.map((h) => {
      const send = (h.sends || []).map((s) => `Step ${s.step}: ${["sent", "opened", "replied", "bounced"].filter((k) => (s as Record<string, boolean>)[k]).join(", ") || "queued"}`).join(" · ");
      const copy = (h.messages || []).map((m) => `Email ${m.step ?? ""}${m.subject ? ` — ${m.subject}` : ""}\n${m.body ? quote(m.body) : ""}`.trim()).join("\n");
      return `*${h.campaign || "Campaign"}*${h.status ? ` · ${h.status}` : ""}${h.category ? ` · ${h.category}` : ""}${send ? `\n${send}` : ""}\n${copy || "_In campaign, no outbound copy synced yet._"}`;
    }).join("\n\n")
    : "_No SalesGlider Smartlead lead._";
  const hrTxt = hrMatch.found
    ? `${hrMatch.campaigns.length ? `Campaigns: ${hrMatch.campaigns.join(", ")}\n` : ""}${hrMatch.messages.length ? hrMatch.messages.map(quote).join("\n") : "_Matched, but no LinkedIn copy returned._"}`
    : "_No SalesGlider HeyReach match._";
  return {
    matched,
    fallback: `${header}: ${name}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: header, emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: clip(who, 2800) } },
      { type: "section", text: { type: "mrkdwn", text: clip(`*Smartlead (SalesGlider)*\n${slTxt}`, 2800) } },
      { type: "section", text: { type: "mrkdwn", text: clip(`*HeyReach (SalesGlider)*\n${hrTxt}`, 2800) } },
    ],
  };
}

async function alreadySlacked(db: SB, row: Row) {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  let q = db.from("sg_visitor_inbox").select("id", { count: "exact", head: true }).not("slack_ts", "is", null).gte("received_at", since);
  q = row.email ? q.eq("email", row.email) : row.linkedin_url ? q.eq("linkedin_url", row.linkedin_url) : q.eq("dedupe_key", row.dedupe_key);
  const { count } = await q;
  return (count ?? 0) > 0;
}

async function qualifyLocal(db: SB, row: Row) {
  const apply = (hit: Record<string, unknown> | null | undefined) => {
    if (!hit) return;
    row.linkedin_url = row.linkedin_url || liOf(str(hit.linkedin_url, hit.linkedin, hit.profile_url));
    row.job_title = row.job_title || str(hit.job_title, hit.title);
    row.company_name = row.company_name || str(hit.company_name);
    row.phone = row.phone || phoneOf(hit);
  };
  if (row.email) {
    const { data: wf } = await db.from("salesglider_wf_contacts")
      .select("linkedin_url,job_title,cellphone,domain").ilike("email", row.email).limit(3);
    for (const h of wf || []) apply({ ...h, phone: h.cellphone });
    const { data: nb } = await db.from("name_bank")
      .select("linkedin_url,job_title").ilike("resolved_email", row.email).limit(3);
    for (const h of nb || []) apply(h);
    const { data: px } = await db.from("pixel_visitor_events")
      .select("linkedin_url,title,company_name").ilike("work_email", row.email).limit(3);
    for (const h of px || []) apply({ ...h, job_title: h.title });
  }
  if (!row.linkedin_url && row.first_name && row.last_name && row.company_domain) {
    const { data } = await db.from("salesglider_wf_contacts")
      .select("linkedin_url,job_title,cellphone")
      .ilike("first_name", row.first_name).ilike("last_name", row.last_name).ilike("domain", row.company_domain)
      .limit(3);
    if ((data || []).length === 1) apply({ ...data![0], phone: data![0].cellphone });
    const { data: nb } = await db.from("name_bank")
      .select("linkedin_url,job_title")
      .ilike("first_name", row.first_name).ilike("last_name", row.last_name).ilike("domain", row.company_domain)
      .limit(3);
    if ((nb || []).length === 1) apply(nb![0]);
  }
  if ((!row.company_name || !row.company_employees) && row.company_domain) {
    const { data } = await db.from("salesglider_wf_companies")
      .select("company_name,employee_range").ilike("domain", row.company_domain).limit(1);
    row.company_name = row.company_name || str(data?.[0]?.company_name);
    row.company_employees = row.company_employees || str(data?.[0]?.employee_range);
  }
}

async function persistVisitor(db: SB, row: Row, slHits: number, heyreach: boolean, slackStatus: string, slackTs: string | null, importRes: ImportRes) {
  const patch: Record<string, unknown> = {
    phone: row.phone,
    linkedin_url: row.linkedin_url,
    job_title: row.job_title,
    company_name: row.company_name,
    company_employees: row.company_employees,
    campaign_id: CAMPAIGN_ID,
    campaign_name: CAMPAIGN_NAME,
    status: row.status,
    routing_note: row.routing_note,
    match: {
      smartlead_hits: slHits,
      heyreach,
      slack: slackStatus,
      client_id: SL_CLIENT,
      campaign_id: CAMPAIGN_ID,
      import: importRes.reason,
      has_phone: !!row.phone,
      has_linkedin: !!row.linkedin_url,
    },
  };
  if (slackTs) patch.slack_ts = slackTs;
  await db.from("sg_visitor_inbox").update(patch).eq("dedupe_key", row.dedupe_key);
}

async function notify(db: SB, row: Row) {
  const slacked = await alreadySlacked(db, row);
  const slackTok = await secret(db, "slack_salesglider");
  const hrTok = await secret(db, "heyreach_salesglider");
  await qualifyLocal(db, row);
  const sl = await matchSmartlead(db, row);
  const hrMatch = hrTok ? await matchHeyreach(hrTok, row) : { found: false, profile_url: row.linkedin_url, phone: null as string | null, campaigns: [] as string[], messages: [] as string[] };
  row.linkedin_url = row.linkedin_url || (hrMatch.found ? hrMatch.profile_url : null);
  if (!row.phone) {
    const slKey = await secret(db, "smartlead_salesglider");
    if (slKey && row.email) {
      try {
        const u = new URL("https://server.smartlead.ai/api/v1/leads/");
        u.searchParams.set("api_key", slKey);
        u.searchParams.set("email", row.email);
        const res = await fetch(u.toString());
        const j = rec(await res.json().catch(() => ({})));
        const lead = rec((j.data as Record<string, unknown>[] | undefined)?.[0] || j.lead || j);
        row.phone = phoneOf(lead, rec(lead.custom_fields), rec(lead.lead));
        row.linkedin_url = row.linkedin_url || liOf(str(lead.linkedin_profile, lead.linkedin, rec(lead.custom_fields).linkedin));
      } catch { /* leave empty */ }
    }
  }
  row.phone = row.phone || hrMatch.phone;
  const importRes = await importVisitor(db, row, sl.length);
  applyImportStatus(row, importRes);
  const c = card(row, sl, hrMatch, importRes);
  let slackTs: string | null = null;
  let slackStatus = slacked ? "deduped" : slackTok ? "skipped" : "err:no_token";
  if (!slacked && slackTok) {
    try {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { authorization: `Bearer ${slackTok}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel: CHANNEL, text: c.fallback, unfurl_links: false, blocks: c.blocks }),
      });
      const body = rec(await res.json().catch(() => ({})));
      slackTs = str(body.ts);
      slackStatus = body.ok === true ? "ok" : `err:${str(body.error) || res.status}`;
    } catch { slackStatus = "err:network"; }
  }
  await persistVisitor(db, row, sl.length, hrMatch.found, slackStatus, slackTs, importRes);
  return { slack: slackStatus, matched: c.matched, imported: importRes.imported, import: importRes.reason };
}

async function backfill(db: SB) {
  const { data, error } = await db.from("sg_visitor_inbox")
    .select("dedupe_key,visitor_id,site_id,first_name,last_name,full_name,email,phone,linkedin_url,job_title,company_name,company_domain,company_employees,page_url,visited_at,city,country,status")
    .not("email", "is", null)
    .neq("status", "imported");
  if (error) return { ok: false, error: error.message };
  const stats = { considered: data?.length || 0, imported: 0, skipped: 0, already_in_smartlead: 0, errors: 0 };
  for (const raw of data || []) {
    const row = {
      ...raw,
      campaign_id: CAMPAIGN_ID,
      campaign_name: CAMPAIGN_NAME,
      lane: "visitor",
      routing_note: raw.status,
      seniority: null,
      department: null,
      industry: null,
      raw: {},
    } as Row;
    if (!firstEmail(row.email)) {
      stats.skipped += 1;
      continue;
    }
    try {
      await qualifyLocal(db, row);
      const sl = await matchSmartlead(db, row);
      const importRes = await importVisitor(db, row, sl.length);
      applyImportStatus(row, importRes);
      await persistVisitor(db, row, sl.length, false, "backfill", null, importRes);
      if (importRes.imported) stats.imported += 1;
      else if (importRes.reason === "already_in_smartlead") stats.already_in_smartlead += 1;
      else stats.skipped += 1;
    } catch {
      stats.errors += 1;
    }
  }
  return { ok: true, campaign_id: CAMPAIGN_ID, ...stats };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  if (req.method === "GET") {
    return new Response(JSON.stringify({
      ok: true,
      hook: "gl-visitor-hook",
      campaign_id: CAMPAIGN_ID,
      campaign_name: CAMPAIGN_NAME,
      client_id: SL_CLIENT,
    }), { headers: { "Content-Type": "application/json" } });
  }
  let payload: unknown;
  try { payload = await req.json(); }
  catch { return new Response(JSON.stringify({ ok: false, error: "invalid json" }), { status: 400, headers: { "Content-Type": "application/json" } }); }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  if (rec(payload).action === "backfill") {
    const result = await backfill(db);
    return new Response(JSON.stringify(result), { status: result.ok ? 200 : 500, headers: { "Content-Type": "application/json" } });
  }

  const rows = [];
  const byLane: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const item of itemsFrom(payload)) {
    const row = await mapVisitor(rec(item), str(url.searchParams.get("site"), url.searchParams.get("id")));
    byLane[row.lane] = (byLane[row.lane] ?? 0) + 1;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    rows.push(row);
  }
  const stored = rows.map((row) => {
    const { seniority: _s, department: _d, industry: _i, ...rest } = row as Row & Record<string, unknown>;
    return rest;
  });
  const { error, count } = await db.from("sg_visitor_inbox").upsert(stored, { onConflict: "dedupe_key", ignoreDuplicates: false, count: "exact" });
  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  const notifyRes = [];
  for (const row of rows) {
    try { notifyRes.push(await notify(db, row)); }
    catch { notifyRes.push({ slack: "err:notify", matched: false, imported: false, import: "err:notify" }); }
  }
  return new Response(JSON.stringify({
    ok: true, received: rows.length, inserted: count ?? rows.length, by_lane: byLane, by_status: byStatus, notify: notifyRes,
  }), { headers: { "Content-Type": "application/json" } });
});
