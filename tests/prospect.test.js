import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newerThanHwm, normalizeLead } from "../src/clients/getleads.js";
import { toWebhookLead } from "../src/clients/webhook.js";
import { applyEmploymentCurrency, applyProspectGates, histogramBucket, isNoiseTitle } from "../src/gates/prospect.js";
import { companiesMatch, hashedProfileId, normCompany, normFirstName, sizeBandStatus } from "../src/normalize.js";
import { filterNewLeads } from "../src/pull.js";
import { companyDomainOf, needsCompany } from "../src/resolve.js";

function lead(overrides = {}) {
  return {
    dedupeKey: "abc",
    leadId: "abc",
    profileId: "01M0BZ5Q1A2569PZPC48XFNMD2",
    authorLinkedinUrl: "https://www.linkedin.com/in/garypica/",
    engagementDate: new Date().toISOString(),
    capturedAt: new Date().toISOString(),
    engagerFirstName: "Pat",
    engagerLastName: "Lee",
    engagerLinkedinUrl: "https://www.linkedin.com/in/pat-lee",
    enrichmentStatus: "failed",
    ...overrides,
  };
}

describe("prospect gates", () => {
  it("drops stale engagement, self, noise, and suppressed domains", () => {
    const now = new Date("2026-08-25T00:00:00.000Z");
    const suppression = new Map([["trumethods.com", "creator"]]);
    const { kept, drops, ageHistogram } = applyProspectGates(
      [
        lead({ engagementDate: "2018-01-01T00:00:00.000Z", leadId: "old", dedupeKey: "old" }),
        lead({ engagerLinkedinUrl: "https://www.linkedin.com/in/garypica", leadId: "self", dedupeKey: "self" }),
        lead({ engagerJobTitle: "MBA student", leadId: "noise", dedupeKey: "noise" }),
        lead({ engagerEmail: "x@trumethods.com", leadId: "sup", dedupeKey: "sup" }),
        lead({ leadId: "keep", dedupeKey: "keep" }),
      ],
      { recencyDays: 90, suppression, now },
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0].dedupeKey, "keep");
    assert.equal(drops.recency, 1);
    assert.equal(drops.self, 1);
    assert.equal(drops.noise, 1);
    assert.equal(drops.suppression, 1);
    assert.ok(ageHistogram["5y_plus"] >= 1);
  });

  it("does not drop enrichment-failed name-only leads", () => {
    const { kept } = applyProspectGates([lead({ enrichmentStatus: "failed" })], {
      recencyDays: 90,
      suppression: new Map(),
    });
    assert.equal(kept.length, 1);
  });

  it("trusts LinkedIn when employers disagree", () => {
    const result = applyEmploymentCurrency(
      { engagerCompany: "OldCo LLC" },
      "NewCo Inc",
    );
    assert.equal(result.company, "NewCo Inc");
    assert.equal(result.mismatch, true);
    assert.equal(result.source, "linkedin");
    assert.equal(companiesMatch("Acme Inc.", "Acme"), true);
  });
});

describe("normalize + size", () => {
  it("matches the hook first-name and company rules", () => {
    assert.equal(normFirstName("DR. PAT (TRICIA) SMITH"), "Tricia");
    assert.equal(normCompany("ACME CORPORATION"), "Acme");
    assert.equal(sizeBandStatus("11 to 50", "Acme", "a@x.com", 1), "pending_verification");
    assert.equal(sizeBandStatus("1 to 10", "Acme", "a@x.com", 1), "dq_size");
    assert.equal(sizeBandStatus("11 to 50", "Acme", null, 1), "needs_email");
    assert.equal(sizeBandStatus(null, null, null, 1), "needs_company_data");
  });

  it("splits hashed LinkedIn ids", () => {
    assert.equal(
      hashedProfileId("https://www.linkedin.com/in/ACoAAA8BYqEBCGLg_vT_ca6mMEqkpp9nVffJ3hc"),
      "ACoAAA8BYqEBCGLg_vT_ca6mMEqkpp9nVffJ3hc",
    );
    assert.equal(hashedProfileId("https://www.linkedin.com/in/jane-doe"), "");
  });

  it("maps histogram buckets", () => {
    assert.equal(histogramBucket(10), "0_30");
    assert.equal(histogramBucket(90), "31_90");
    assert.equal(histogramBucket(400), "1y_2y");
    assert.equal(isNoiseTitle("looking for my next role"), true);
  });
});

describe("pull cursor + webhook map", () => {
  it("uses getleads leadId as dedupeKey and keeps only rows newer than HWM", () => {
    const raw = normalizeLead({
      leadId: "fffc59088618b8abdd62fb75a4b74491",
      profileId: "01M0VF673N01E9FG7W51VDGX0A",
      capturedAt: "2026-08-25T03:29:49.718Z",
      engagementDate: "2026-08-25T03:29:49.716Z",
      authorLinkedinUrl: "https://www.linkedin.com/in/peterlehrman/",
    });
    assert.equal(raw.dedupeKey, raw.leadId);
    assert.equal(newerThanHwm(raw, "2026-08-25T03:29:49.718Z"), false);
    assert.equal(newerThanHwm(raw, "2026-08-24T00:00:00.000Z"), true);

    const { fresh } = filterNewLeads(
      [raw, { ...raw, capturedAt: "2026-08-20T00:00:00.000Z", leadId: "old", dedupeKey: "old" }],
      [{ profile_id: raw.profileId, captured_at_hwm: "2026-08-24T00:00:00.000Z" }],
    );
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].leadId, raw.leadId);

    const mapped = toWebhookLead(raw);
    assert.equal(mapped.dedupeKey, raw.leadId);
    assert.equal(mapped.profileId, raw.profileId);
    assert.ok(mapped.authorLinkedinUrl);
  });

  it("requires a domain before email resolution", () => {
    assert.equal(needsCompany({ engagerCompany: "" }), true);
    assert.equal(companyDomainOf({ engagerCompanyWebsite: "https://www.acme.com/about" }), "acme.com");
    assert.equal(companyDomainOf({ engagerEmail: "pat@gmail.com", engagerCompany: "Acme" }), "");
  });
});
