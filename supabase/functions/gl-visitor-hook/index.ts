import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type SB = ReturnType<typeof createClient>;
const SECRET = "sg_vis_17b3334f00c0";
const CHANNEL = "C0BS6H62P3P";
const SL_CLIENT = 345263;

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
  const person = nest(it, "person", "visitor", "lead", "contact");
  const company = nest(it, "company", "organization");
  const visit = nest(it, "visit", "session");
  let first = str(person.first_name, person.firstName, it.first_name, it.firstName);
  let last = str(person.last_name, person.lastName, it.last_name, it.lastName);
  const full = str(person.name, person.full_name, it.name, it.full_name, [first, last].filter(Boolean).join(" ") || null);
  if (!first && full) {
    const p = full.split(/\s+/);
    first = p[0] || null;
    last = last || p.slice(1).join(" ") || null;
  }
  const email = (str(person.work_email, person.email, it.work_email, it.email) || "").toLowerCase() || null;
  const linkedin = liOf(str(person.linkedin_url, person.linkedin, person.profile_url, it.linkedin_url, it.linkedin));
  const companyName = str(company.name, company.company_name, it.company_name, it.engagerCompany);
  const companyDomain = domainOf(str(company.domain, company.website, it.company_domain, it.domain));
  const page = str(visit.page, visit.page_url, visit.url, visit.landing_page, it.page_url, it.url, it.page);
  const visitorId = str(it.visitorId, it.visitor_id, person.id, it.sessionId);
  const leadId = str(it.leadId, it.lead_id, it.dedupeKey, it.dedupe_key);
  const site = str(siteHint, it.site, it.site_id, hostOf(page), companyDomain);
  const status = !email && !linkedin ? "needs_identity" : !companyName ? "needs_company" : !email ? "needs_email" : "received";
  return {
    dedupe_key: leadId || visitorId || email || linkedin || await hashKey([full || "", companyName || "", companyDomain || "", page || "", site || ""]),
    visitor_id: visitorId || leadId,
    site_id: site,
    first_name: first,
    last_name: last,
    full_name: full,
    email,
    linkedin_url: linkedin,
    job_title: str(person.title, person.job_title, person.headline, it.title, it.job_title),
    company_name: companyName,
    company_domain: companyDomain,
    company_employees: str(company.employee_count, company.size, company.employees, it.employees),
    page_url: page,
    visited_at: tsOf(visit.ts, visit.timestamp, visit.visited_at, it.timestamp, it.ts),
    city: str(person.city, it.city, company.city),
    country: str(person.country, it.country, company.country),
    campaign_id: null,
    campaign_name: null,
    lane: "visitor",
    status,
    routing_note: "visitor hook; not engager inbox",
    raw: it,
  };
}
type Row = Awaited<ReturnType<typeof mapVisitor>>;

async function secret(db: SB, name: string) {
  const { data, error } = await db.rpc("get_vault_secret", { p_name: name });
  return error || typeof data !== "string" || !data ? null : data;
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
  let found = false;
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
    if (lead.status < 400 && (p.profileUrl || p.id || p.firstName)) found = true;
  }
  let convs: Record<string, unknown>[] = [];
  for (const filters of [
    { searchString: row.email || row.full_name, leadProfileUrl: row.linkedin_url },
    { search_string: row.email || row.full_name, lead_profile_url: row.linkedin_url },
  ]) {
    const conv = await hr(token, "/inbox/GetConversationsV2", { filters, offset: 0, limit: 10 });
    convs = hrItems(conv.json);
    if (convs.length || conv.status < 400) break;
  }
  for (const it of convs.slice(0, 3)) {
    found = true;
    const who = rec(it.correspondentProfile || it.correspondent || it.lead);
    profile = liOf(str(who.profileUrl, who.linkedinUrl, it.profileUrl, profile)) || profile;
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
  return { found, profile_url: profile, campaigns: [...new Set(campaigns)].slice(0, 6), messages: messages.slice(0, 5) };
}

function card(row: Row, sl: Awaited<ReturnType<typeof matchSmartlead>>, hrMatch: Awaited<ReturnType<typeof matchHeyreach>>) {
  const matched = sl.length > 0 || hrMatch.found;
  const name = row.full_name || [row.first_name, row.last_name].filter(Boolean).join(" ") || "Unknown visitor";
  const li = hrMatch.profile_url || row.linkedin_url;
  const header = matched ? "Website visitor · MATCH" : "Website visitor · no outreach match";
  const who = [
    li ? `*${name}* — <${li}|LinkedIn>` : `*${name}*`,
    row.job_title,
    [row.company_name, row.company_domain, row.company_employees].filter(Boolean).join(" · ") || null,
    row.email ? `\`${row.email}\`` : null,
    row.page_url ? `Landed on: ${row.page_url}` : null,
    row.site_id ? `Site: ${row.site_id}` : null,
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

async function notify(db: SB, row: Row) {
  if (await alreadySlacked(db, row)) return { slack: "deduped", matched: false };
  const slackTok = await secret(db, "slack_salesglider");
  const hrTok = await secret(db, "heyreach_salesglider");
  const sl = await matchSmartlead(db, row);
  const hrMatch = hrTok ? await matchHeyreach(hrTok, row) : { found: false, profile_url: row.linkedin_url, campaigns: [] as string[], messages: [] as string[] };
  const c = card(row, sl, hrMatch);
  let slackTs: string | null = null;
  let slackStatus = slackTok ? "skipped" : "err:no_token";
  if (slackTok) {
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
  await db.from("sg_visitor_inbox").update({
    slack_ts: slackTs,
    match: { smartlead_hits: sl.length, heyreach: hrMatch.found, slack: slackStatus, client_id: SL_CLIENT },
  }).eq("dedupe_key", row.dedupe_key);
  return { slack: slackStatus, matched: c.matched };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, hook: "gl-visitor-hook" }), { headers: { "Content-Type": "application/json" } });
  }
  let payload: unknown;
  try { payload = await req.json(); }
  catch { return new Response(JSON.stringify({ ok: false, error: "invalid json" }), { status: 400, headers: { "Content-Type": "application/json" } }); }

  const rows = [];
  const byLane: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const item of itemsFrom(payload)) {
    const row = await mapVisitor(rec(item), str(url.searchParams.get("site"), url.searchParams.get("id")));
    byLane[row.lane] = (byLane[row.lane] ?? 0) + 1;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    rows.push(row);
  }
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error, count } = await db.from("sg_visitor_inbox").upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true, count: "exact" });
  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  const notifyRes = [];
  for (const row of rows) {
    try { notifyRes.push(await notify(db, row)); }
    catch { notifyRes.push({ slack: "err:notify", matched: false }); }
  }
  return new Response(JSON.stringify({
    ok: true, received: rows.length, inserted: count ?? rows.length, by_lane: byLane, by_status: byStatus, notify: notifyRes,
  }), { headers: { "Content-Type": "application/json" } });
});
