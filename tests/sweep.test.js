import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyCounts, runSweep } from "../src/sweep.js";

function createFake({ claimed = [], verified = [], staged = [], spend = 0 } = {}) {
  const inbox = [...claimed, ...verified, ...staged];
  const store = {
    inbox,
    staging: [],
    suppression: [
      { domain: "trumethods.com", reason: "creator" },
      { domain: "crelate.com", reason: "competitor" },
    ],
    spend,
    patches: [],
  };

  const supabase = {
    async rpc(name, args = {}) {
      if (name === "sg_engager_reclaim_stale") return { data: 0, error: null };
      if (name === "claim_sg_engager_inbox") {
        const out = store.inbox.filter((r) => r.status === "pending_verification").slice(0, args.p_limit ?? 500);
        for (const row of out) row.status = "verifying";
        return { data: out.map((r) => ({ ...r })), error: null };
      }
      if (name === "sg_engager_inbox_by_emails") {
        const set = new Set((args.p_emails || []).map((e) => e.toLowerCase()));
        return {
          data: store.inbox
            .filter((r) => set.has(String(r.engager_email || "").toLowerCase()))
            .map((r) => ({ id: r.id, dedupe_key: r.dedupe_key, engager_email: r.engager_email, status: r.status })),
          error: null,
        };
      }
      if (name === "sg_engager_spend_state") return { data: { month_key: "2026-08", spend_cents: store.spend }, error: null };
      if (name === "sg_engager_add_spend") {
        store.spend += Number(args.p_cents || 0);
        return { data: store.spend, error: null };
      }
      return { data: null, error: { message: `unknown rpc ${name}` } };
    },
    from(table) {
      return {
        select() {
          return this;
        },
        in(col, values) {
          this._in = { col, values };
          return this;
        },
        order() {
          return this;
        },
        update(patch) {
          this._patch = patch;
          return this;
        },
        upsert(row) {
          store.staging.push(row);
          return Promise.resolve({ error: null });
        },
        then(resolve) {
          if (table === "sg_engager_suppression") {
            return resolve({ data: store.suppression, error: null });
          }
          if (this._patch) {
            const keys = new Set(this._in?.values || []);
            for (const row of store.inbox) {
              if (keys.has(row.dedupe_key)) Object.assign(row, this._patch);
            }
            store.patches.push({ patch: this._patch, keys: [...keys] });
            return resolve({ error: null, count: keys.size });
          }
          const statuses = this._in?.values || [];
          const data = store.inbox.filter((r) => statuses.includes(r.status));
          return resolve({ data, error: null });
        },
      };
    },
  };

  return { supabase, store };
}

describe("runSweep", () => {
  it("logs an idle sweep when nothing verifies or imports", async () => {
    const { supabase } = createFake();
    const logs = [];
    const counts = await runSweep({
      supabase,
      config: {
        sweepLimit: 500,
        staleVerifyingMinutes: 45,
        monthlySpendCapCents: 500,
        mvCentsPerCredit: 0.178,
        n2bCentsPerCheck: 0.8,
        importChunkSize: 200,
      },
      mv: {},
      n2b: {},
      smartlead: {},
      log: { info: (m, extra) => logs.push({ m, extra }), warn() {}, error() {} },
    });
    assert.deepEqual(counts.verified, 0);
    assert.deepEqual(counts.imported, 0);
    assert.equal(logs[0].m, "idle sweep");
    assert.equal(emptyCounts().claimed, 0);
  });

  it("suppresses, verifies, stages, and imports without touching campaign state", async () => {
    const { supabase, store } = createFake({
      claimed: [
        {
          id: 1,
          dedupe_key: "keep",
          status: "pending_verification",
          engager_email: "ok@acme.com",
          first_name_n: "Ok",
          engager_last_name: "Lead",
          company_n: "Acme",
          campaign_id: 3847939,
          campaign_name: "SG MSP",
        },
        {
          id: 2,
          dedupe_key: "blocked",
          status: "pending_verification",
          engager_email: "x@trumethods.com",
          campaign_id: 3847939,
        },
      ],
    });
    const smartleadCalls = [];
    const counts = await runSweep({
      supabase,
      config: {
        sweepLimit: 500,
        staleVerifyingMinutes: 45,
        monthlySpendCapCents: 500,
        mvCentsPerCredit: 0.178,
        n2bCentsPerCheck: 0.8,
        importChunkSize: 200,
      },
      mv: {
        async upload() { return { fileId: "77" }; },
        async poll() { return { status: "finished", credit: 1 }; },
        async download() { return [{ inbox_id: "1", email: "ok@acme.com", result: "ok" }]; },
      },
      n2b: { async verifyMany() { return new Map(); } },
      smartlead: {
        async campaignHasEmail() { return false; },
        async addLeads(id, list) {
          smartleadCalls.push({ id, n: list.length, keys: Object.keys(list[0] || {}) });
          return { uploadCount: list.length };
        },
      },
      log: { info() {}, warn() {}, error() {} },
    });
    assert.equal(counts.suppressed, 1);
    assert.equal(counts.verified, 1);
    assert.equal(counts.staged, 1);
    assert.equal(counts.imported, 1);
    assert.equal(store.inbox.find((r) => r.dedupe_key === "blocked").status, "suppressed");
    assert.equal(store.inbox.find((r) => r.dedupe_key === "keep").status, "imported");
    assert.equal(store.staging[0].first_name, "Ok");
    assert.equal(store.staging[0].source_dedupe_key, "keep");
    assert.equal(smartleadCalls[0].id, 3847939);
    assert.ok(!JSON.stringify(smartleadCalls).includes("/start"));
  });
});
