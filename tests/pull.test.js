import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runPull } from "../src/pull.js";

describe("runPull", () => {
  it("gates, posts, writes HWM and a first-run report without spending", async () => {
    const now = new Date().toISOString();
    const store = { hwm: [], first: null, inbox: [] };
    const supabase = {
      from(table) {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: table === "sg_pipeline_first_run" ? store.first : null, error: null }),
          upsert: async (rows) => {
            if (table === "sg_pipeline_hwm") store.hwm = Array.isArray(rows) ? rows : [rows];
            return { error: null };
          },
          insert: async (row) => {
            store.first = { id: 1, report: row.report };
            return { error: null };
          },
          then: async (resolve) => {
            if (table === "sg_engager_suppression") {
              return resolve({ data: [{ domain: "trumethods.com", reason: "creator" }], error: null });
            }
            if (table === "sg_pipeline_hwm") return resolve({ data: store.hwm, error: null });
            return resolve({ data: [], error: null });
          },
        };
      },
      async rpc(name) {
        if (name === "sg_pipeline_spend_state") {
          return { data: { month_key: "2026-08", apify_cents: 0, waterfall_cents: 0, verifier_cents: 0 }, error: null };
        }
        return { data: null, error: { message: name } };
      },
    };

    const logs = [];
    const posted = [];
    const counts = await runPull({
      supabase,
      config: {
        recencyDays: 90,
        enrichmentBatchLimit: 100,
        monthlySpendCapCents: 500,
        apifyCentsPerProfile: 0.4,
        waterfallCentsPerRow: 15,
      },
      getleads: {
        async listMonitoredProfiles() {
          return [{ profileId: "01M0BZ5Q1A2569PZPC48XFNMD2", lastScrapedAt: now }];
        },
        async listAllLeads() {
          return {
            pages: 1,
            leads: [
              {
                dedupeKey: "keep",
                leadId: "keep",
                profileId: "01M0BZ5Q1A2569PZPC48XFNMD2",
                authorLinkedinUrl: "https://www.linkedin.com/in/garypica/",
                engagementDate: now,
                capturedAt: now,
                engagerLinkedinUrl: "https://www.linkedin.com/in/pat",
                engagerFirstName: "Pat",
                enrichmentStatus: "failed",
              },
              {
                dedupeKey: "old",
                leadId: "old",
                profileId: "01M0BZ5Q1A2569PZPC48XFNMD2",
                authorLinkedinUrl: "https://www.linkedin.com/in/garypica/",
                engagementDate: "2018-01-01T00:00:00.000Z",
                capturedAt: "2018-01-01T00:00:00.000Z",
                engagerLinkedinUrl: "https://www.linkedin.com/in/old",
                enrichmentStatus: "failed",
              },
            ],
          };
        },
      },
      apify: { async scrapeProfiles() { throw new Error("should not spend"); } },
      waterfall: { async enrich() { throw new Error("should not spend"); } },
      webhook: {
        async postAll(leads) {
          posted.push(leads.length);
          return { posted: leads.length, failed_count: 0, by_lane: { msp: leads.length }, by_status: { needs_company_data: leads.length } };
        },
      },
      log: { info: (m, extra) => logs.push({ m, extra }), warn() {}, error() {} },
    });

    assert.equal(counts.pulled, 2);
    assert.equal(counts.dropped_recency, 1);
    assert.equal(counts.posted, 1);
    assert.equal(posted[0], 1);
    assert.equal(store.hwm.length, 1);
    assert.ok(store.first?.report?.age_histogram);
    assert.equal(store.first.report.dropped_by_recency, 1);
    assert.ok(logs.some((l) => l.m === "first-run report"));
  });
});
