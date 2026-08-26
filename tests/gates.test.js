import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSmartlead, extractUploadCount, formatLocation, leadInCampaign, toSmartleadLead } from "../src/clients/smartlead.js";
import { classifyFromSets, estimateVerifierCents, verifyRows } from "../src/gates/verify.js";
import { applyInboxDedupe } from "../src/gates/dedupe.js";
import { applySuppression } from "../src/gates/suppression.js";
import { chunk, groupByCampaign, importStaged } from "../src/gates/import.js";
import { toStagingRow } from "../src/gates/stage.js";
import { wouldExceedCap } from "../src/spend.js";
import { sanitizeLogExtra } from "../src/logger.js";
import { withBackoff } from "../src/http.js";
import { createMcpClient } from "../src/clients/mcp.js";
import { putFeed } from "../src/inbox.js";

function row(overrides = {}) {
  return {
    id: 1,
    dedupe_key: "d1",
    status: "verifying",
    engager_email: "pat@acme.com",
    first_name_n: "Pat",
    engager_last_name: "Lee",
    company_n: "Acme",
    campaign_id: 3847939,
    campaign_name: "SG MSP",
    engager_linkedin_url: "https://linkedin.com/in/pat",
    engager_city: "Austin",
    engager_country: "US",
    ...overrides,
  };
}

describe("suppression", () => {
  it("marks matching domains and leaves others", () => {
    const map = new Map([
      ["trumethods.com", "creator"],
      ["crelate.com", "competitor"],
    ]);
    const { suppressed, remaining } = applySuppression(
      [row({ engager_email: "a@trumethods.com" }), row({ id: 2, dedupe_key: "d2", engager_email: "b@ok.com" })],
      map,
    );
    assert.equal(suppressed.length, 1);
    assert.equal(suppressed[0].patch.status, "suppressed");
    assert.match(suppressed[0].patch.routing_note, /creator domain trumethods.com/);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].engager_email, "b@ok.com");
  });
});

describe("inbox dedupe", () => {
  it("first id wins within the batch and against earlier inbox rows", () => {
    const existing = [{ id: 5, engager_email: "same@co.com" }];
    const { duplicates, remaining } = applyInboxDedupe(
      [
        row({ id: 10, dedupe_key: "a", engager_email: "same@co.com" }),
        row({ id: 11, dedupe_key: "b", engager_email: "SAME@co.com" }),
        row({ id: 12, dedupe_key: "c", engager_email: "fresh@co.com" }),
      ],
      existing,
    );
    assert.equal(duplicates.length, 2);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].dedupe_key, "c");
  });

  it("does not treat a junk one-character email as a duplicate key", () => {
    const { duplicates, remaining } = applyInboxDedupe(
      [
        row({ id: 10, dedupe_key: "a", engager_email: "x" }),
        row({ id: 11, dedupe_key: "b", engager_email: "x" }),
      ],
      [{ id: 1, engager_email: "x" }],
    );
    assert.equal(duplicates.length, 0);
    assert.equal(remaining.length, 2);
  });
});

describe("verifier mapping", () => {
  it("classifies sendable vs rejected without logging addresses", () => {
    assert.equal(classifyFromSets("pat@acme.com", new Set(["pat@acme.com"]), new Set()), "verified");
    assert.equal(classifyFromSets("bad@acme.com", new Set(), new Set(["bad@acme.com"])), "verified_bad");
    assert.equal(classifyFromSets("miss@acme.com", new Set(), new Set()), "unknown");
  });

  it("rejects Railway feed URLs that VerifyFall cannot fetch", async () => {
    const result = await verifyRows({
      rows: [row()],
      config: { monthlySpendCapCents: 500, mvCentsPerCredit: 0.178, n2bCentsPerCheck: 0.8 },
      spendCents: 0,
      verifier: { start() { throw new Error("should not start"); } },
      putCsv: async () => "https://sg-engager-pipeline-production.up.railway.app/feeds/vf_x.csv",
      publicBaseUrl: "https://sg-engager-pipeline-production.up.railway.app",
      onCapHit: async () => {},
      charge: async () => ({ spendCents: 0 }),
    });
    assert.equal(result.stats.error, 1);
    assert.match(result.patches[0].patch.routing_note, /not Railway/);
  });

  it("stops before the verifier when the cap would be exceeded", async () => {
    const logs = [];
    const result = await verifyRows({
      rows: [row(), row({ id: 2, dedupe_key: "d2" })],
      config: { monthlySpendCapCents: 500, mvCentsPerCredit: 300, n2bCentsPerCheck: 0.8 },
      spendCents: 100,
      verifier: { start() { throw new Error("should not start"); } },
      putCsv() { throw new Error("should not write csv"); },
      publicBaseUrl: "https://example.test",
      onCapHit: async (info) => logs.push(info),
      charge: async () => ({ spendCents: 100 }),
    });
    assert.equal(result.stats.cap_hit, true);
    assert.equal(result.releaseKeys.length, 2);
    assert.equal(logs[0].reason, "verifier");
    assert.ok(logs[0].would_cost_cents > 400);
  });

  it("can ignore the spend cap for an authorized verifier pass", async () => {
    let started = false;
    const result = await verifyRows({
      rows: [row()],
      config: { monthlySpendCapCents: 1, mvCentsPerCredit: 300, n2bCentsPerCheck: 0.8 },
      spendCents: 100,
      ignoreCap: true,
      verifier: {
        async start() {
          started = true;
          return { run_id: "22222222-2222-2222-2222-222222222222" };
        },
        async waitForRun() { return { status: "completed", mv_credits_used: 0, n2b_credits_used: 0 }; },
        async results() { return { downloads: { sendable_url: "https://files.test/sendable.csv", rejected_url: "https://files.test/rejected.csv" } }; },
      },
      putCsv: async () => "https://files.test/feeds/vf.csv",
      fetchImpl: async (url) => {
        if (String(url).includes("sendable")) return { text: async () => "Email\npat@acme.com\n" };
        return { text: async () => "Email\n" };
      },
      onCapHit: async () => { throw new Error("should not hit cap"); },
      charge: async () => ({ spendCents: 100 }),
    });
    assert.equal(started, true);
    assert.equal(result.stats.verified, 1);
    assert.equal(result.stats.cap_hit, false);
  });

  it("maps verifier CSVs and charges billed credits", async () => {
    const charges = [];
    const feeds = new Map();
    const verifier = {
      async start() { return { run_id: "11111111-1111-1111-1111-111111111111" }; },
      async waitForRun() { return { status: "completed", mv_credits_used: 2, n2b_credits_used: 1 }; },
      async results() {
        return {
          downloads: {
            sendable_url: "https://files.test/sendable.csv",
            rejected_url: "https://files.test/rejected.csv",
          },
        };
      },
    };
    const fetchImpl = async (url) => {
      if (String(url).includes("sendable")) return { text: async () => "Email\npat@acme.com\nca@acme.com\n" };
      return { text: async () => "Email\nbad@acme.com\n" };
    };
    const result = await verifyRows({
      rows: [
        row({ id: 1, dedupe_key: "a", engager_email: "pat@acme.com" }),
        row({ id: 2, dedupe_key: "b", engager_email: "ca@acme.com" }),
        row({ id: 3, dedupe_key: "c", engager_email: "bad@acme.com" }),
      ],
      config: { monthlySpendCapCents: 500, mvCentsPerCredit: 0.178, n2bCentsPerCheck: 0.8 },
      spendCents: 0,
      verifier,
      publicBaseUrl: "https://pipeline.test",
      putCsv: async (id, csv) => {
        feeds.set(id, csv);
        return `https://files.test/feeds/${id}.csv`;
      },
      fetchImpl,
      onCapHit: async () => {},
      charge: async (_vendor, cents) => {
        charges.push(cents);
        return { spendCents: cents };
      },
    });
    const byKey = Object.fromEntries(result.patches.map((p) => [p.row.dedupe_key, p.patch.status]));
    assert.deepEqual(byKey, { a: "verified", b: "verified", c: "verified_bad" });
    assert.equal(result.stats.run_id, "11111111-1111-1111-1111-111111111111");
    assert.ok(feeds.size === 1);
    assert.ok(Math.abs(charges[0] - (2 * 0.178 + 0.8)) < 1e-9);
  });
});

describe("stage + import", () => {
  it("maps staging fields from normalized inbox columns", () => {
    const staged = toStagingRow(row());
    assert.equal(staged.email, "pat@acme.com");
    assert.equal(staged.first_name, "Pat");
    assert.equal(staged.last_name, "Lee");
    assert.equal(staged.company_name, "Acme");
    assert.equal(staged.campaign_id, 3847939);
    assert.equal(staged.linkedin_profile, "https://linkedin.com/in/pat");
    assert.equal(staged.location, "Austin, US");
    assert.equal(staged.source_dedupe_key, "d1");
  });

  it("accepts a chunk only when upload_count equals submitted", async () => {
    const smartlead = {
      async addLeads(_id, list) {
        return { uploadCount: list.length, submitted: list.length };
      },
    };
    const ok = await importStaged({
      rows: [row({ status: "staged", email: "pat@acme.com", first_name: "Pat" })],
      smartlead,
      chunkSize: 200,
    });
    assert.equal(ok.imported.length, 1);
    assert.equal(ok.imported[0].patch.status, "imported");
  });

  it("marks import_mismatch and stops that campaign when upload_count differs", async () => {
    const calls = [];
    const smartlead = {
      async addLeads(id, list) {
        calls.push({ id, n: list.length });
        return { uploadCount: list.length - 1, submitted: list.length };
      },
    };
    const rows = [
      row({ id: 1, dedupe_key: "a", campaign_id: 9, email: "a@x.com" }),
      row({ id: 2, dedupe_key: "b", campaign_id: 9, email: "b@x.com" }),
      row({ id: 3, dedupe_key: "c", campaign_id: 9, email: "c@x.com" }),
    ];
    const result = await importStaged({
      rows,
      smartlead,
      chunkSize: 2,
    });
    assert.equal(result.mismatches.length, 2);
    assert.equal(result.imported.length, 0);
    assert.deepEqual(result.skippedCampaigns, [9]);
    assert.equal(calls.length, 1);
  });

  it("does not treat already_added as extra credit toward success", () => {
    assert.equal(extractUploadCount({ upload_count: 2, already_added_to_campaign: 2 }), 2);
    assert.equal(extractUploadCount({ added_count: 2 }), null);
  });

  it("checks Smartlead membership from lead_campaign_data", () => {
    assert.equal(leadInCampaign({}, 3847939), false);
    assert.equal(leadInCampaign({ id: 1 }, 3847939), false);
    assert.equal(
      leadInCampaign({ lead_campaign_data: [{ campaign_id: 3847939 }] }, 3847939),
      true,
    );
    assert.equal(
      leadInCampaign({ lead_campaign_data: [{ campaign_id: 1 }] }, 3847939),
      false,
    );
  });

  it("looks up Smartlead leads by email instead of the campaign lead list", async () => {
    const calls = [];
    const smartlead = createSmartlead(
      { smartleadBaseUrl: "https://server.smartlead.ai/api/v1", smartleadApiKey: "k" },
      {
        fetchImpl: async (url) => {
          calls.push(String(url));
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ lead_campaign_data: [{ campaign_id: 9 }] }),
          };
        },
      },
    );
    assert.equal(await smartlead.campaignHasEmail(9, "pat@acme.com"), true);
    assert.match(calls[0], /\/leads\/\?/);
    assert.ok(!calls[0].includes("/campaigns/9/leads"));
  });

  it("chunks at 200", () => {
    assert.equal(chunk(new Array(401).fill(1), 200).map((c) => c.length).join(","), "200,200,1");
    assert.equal(groupByCampaign([row({ campaign_id: 1 }), row({ campaign_id: 2 })]).size, 2);
  });
});

describe("spend + location + logs + backoff", () => {
  it("detects a cap breach", () => {
    assert.equal(wouldExceedCap(400, 101, 500), true);
    assert.equal(wouldExceedCap(400, 100, 500), false);
    assert.ok(Math.abs(estimateVerifierCents(10, { mvCentsPerCredit: 0.178, n2bCentsPerCheck: 0.8 }) - 9.78) < 1e-9);
  });

  it("builds location and smartlead lead without inventing fields", () => {
    assert.equal(formatLocation(row()), "Austin, US");
    const lead = toSmartleadLead(toStagingRow(row()));
    assert.equal(lead.linkedin_profile, "https://linkedin.com/in/pat");
    assert.equal(lead.location, "Austin, US");
  });

  it("strips emails and names from log extras", () => {
    const extra = sanitizeLogExtra({
      email: "hidden@x.com",
      first_name: "Pat",
      verified: 3,
      spend_cents: 1.2,
    });
    assert.deepEqual(extra, { verified: 3, spend_cents: 1.2 });
  });

  it("uploads the verifier CSV via storage REST and confirms a public GET", async () => {
    const calls = [];
    const csv = "Email\na@b.com\n";
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || "GET", body: options.body || "" });
      if ((options.method || "GET") === "POST") {
        return { ok: true, status: 200, text: async () => "" };
      }
      return { ok: true, status: 200, text: async () => csv };
    };
    const url = await putFeed(
      {},
      "vf_x",
      csv,
      { supabaseUrl: "https://proj.supabase.co", supabaseKey: "key", fetchImpl },
    );
    assert.equal(url, "https://proj.supabase.co/storage/v1/object/public/sg-engager-feeds/vf_x.csv");
    assert.equal(calls[0].method, "POST");
    assert.match(calls[0].url, /\/object\/sg-engager-feeds\/vf_x\.csv$/);
    assert.equal(calls[1].method, "GET");
    assert.equal(calls[0].body, csv);
  });

  it("does not retry HTTP 400 from the verifier fetch", async () => {
    let n = 0;
    await assert.rejects(
      () =>
        withBackoff(
          async () => {
            n += 1;
            throw new Error("HTTP 400 GET");
          },
          { attempts: 3, delaysMs: [0, 0, 0] },
        ),
      /HTTP 400 GET/,
    );
    assert.equal(n, 1);
  });

  it("initializes the MCP session before the first tools/call", async () => {
    const calls = [];
    const fetchImpl = async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.method);
      const headers = new Headers();
      if (body.method === "initialize") headers.set("mcp-session-id", "sess-1");
      return {
        ok: true,
        status: 200,
        headers,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? 1,
            result: body.method === "tools/call" ? { content: [{ type: "text", text: "{\"ok\":true}" }] } : {},
          }),
      };
    };
    const mcp = createMcpClient({ url: "https://mcp.test/mcp", fetchImpl });
    const result = await mcp.callTool("start_verification", { file_url: "https://files.test/a.csv", segment_name: "x" });
    assert.deepEqual(calls, ["initialize", "notifications/initialized", "tools/call"]);
    assert.deepEqual(result, { ok: true });
  });

  it("retries three times then throws", async () => {
    let n = 0;
    await assert.rejects(
      () =>
        withBackoff(
          async () => {
            n += 1;
            throw new Error("nope");
          },
          { attempts: 3, delaysMs: [0, 0, 0] },
        ),
      /nope/,
    );
    assert.equal(n, 3);
  });
});
