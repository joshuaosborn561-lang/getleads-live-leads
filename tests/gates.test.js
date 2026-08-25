import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractUploadCount, formatLocation, toSmartleadLead } from "../src/clients/smartlead.js";
import { classifyMv, classifyN2bStatus, estimateMvCents, verifyRows } from "../src/gates/verify.js";
import { applyInboxDedupe } from "../src/gates/dedupe.js";
import { applySuppression } from "../src/gates/suppression.js";
import { chunk, groupByCampaign, importStaged } from "../src/gates/import.js";
import { toStagingRow } from "../src/gates/stage.js";
import { wouldExceedCap } from "../src/spend.js";
import { sanitizeLogExtra } from "../src/logger.js";
import { withBackoff } from "../src/http.js";

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
});

describe("verify mapping", () => {
  it("maps mv and n2b outcomes", () => {
    assert.equal(classifyMv("ok"), "verified");
    assert.equal(classifyMv("invalid"), "verified_bad");
    assert.equal(classifyMv("disposable"), "verified_bad");
    assert.equal(classifyMv("catch_all"), "second_pass");
    assert.equal(classifyMv("unknown"), "second_pass");
    assert.equal(classifyN2bStatus("safe"), "verified");
    assert.equal(classifyN2bStatus("invalid"), "verified_bad");
  });

  it("stops before MillionVerifier when the cap would be exceeded", async () => {
    const logs = [];
    const result = await verifyRows({
      rows: [row(), row({ id: 2, dedupe_key: "d2" })],
      config: { monthlySpendCapCents: 500, mvCentsPerCredit: 300, n2bCentsPerCheck: 0.8 },
      spendCents: 100,
      mv: { upload() { throw new Error("should not upload"); } },
      n2b: {},
      onCapHit: async (info) => logs.push(info),
      charge: async () => ({ spendCents: 100 }),
    });
    assert.equal(result.stats.cap_hit, true);
    assert.equal(result.releaseKeys.length, 2);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].reason, "millionverifier");
    assert.ok(logs[0].would_cost_cents > 400);
  });

  it("routes catch_all through No2Bounce and charges billed MV credits", async () => {
    const charges = [];
    const mv = {
      async upload() { return { fileId: "940" }; },
      async poll() { return { status: "finished", credit: 1 }; },
      async download() {
        return [
          { inbox_id: "1", email: "pat@acme.com", result: "ok" },
          { inbox_id: "2", email: "ca@acme.com", result: "catch_all" },
          { inbox_id: "3", email: "bad@acme.com", result: "invalid" },
        ];
      },
    };
    const n2b = {
      async verifyMany() {
        return new Map([["ca@acme.com", { status: "safe" }]]);
      },
    };
    const result = await verifyRows({
      rows: [
        row({ id: 1, dedupe_key: "a", engager_email: "pat@acme.com" }),
        row({ id: 2, dedupe_key: "b", engager_email: "ca@acme.com" }),
        row({ id: 3, dedupe_key: "c", engager_email: "bad@acme.com" }),
      ],
      config: { monthlySpendCapCents: 500, mvCentsPerCredit: 0.178, n2bCentsPerCheck: 0.8 },
      spendCents: 0,
      mv,
      n2b,
      onCapHit: async () => {},
      charge: async (cents) => {
        charges.push(cents);
        return { spendCents: charges.reduce((a, b) => a + b, 0) };
      },
    });
    const byKey = Object.fromEntries(result.patches.map((p) => [p.row.dedupe_key, p.patch.status]));
    assert.deepEqual(byKey, { a: "verified", b: "verified", c: "verified_bad" });
    assert.equal(result.stats.mv_file_id, "940");
    assert.equal(charges[0], 0.178);
    assert.equal(charges[1], 0.8);
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

  it("chunks at 200", () => {
    assert.equal(chunk(new Array(401).fill(1), 200).map((c) => c.length).join(","), "200,200,1");
    assert.equal(groupByCampaign([row({ campaign_id: 1 }), row({ campaign_id: 2 })]).size, 2);
  });
});

describe("spend + location + logs + backoff", () => {
  it("detects a cap breach", () => {
    assert.equal(wouldExceedCap(400, 101, 500), true);
    assert.equal(wouldExceedCap(400, 100, 500), false);
    assert.ok(Math.abs(estimateMvCents(10, 0.178) - 1.78) < 1e-9);
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
