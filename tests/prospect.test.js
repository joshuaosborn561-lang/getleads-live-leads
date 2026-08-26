import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newerThanHwm, normalizeLead } from "../src/clients/getleads.js";
// cleanEmployees is covered via normalizeLead
import { toWebhookLead } from "../src/clients/webhook.js";
import { applyEmploymentCurrency, applyProspectGates, histogramBucket, isNoiseTitle } from "../src/gates/prospect.js";
import {
  bandFromEmployeeCount,
  companiesMatch,
  hashedProfileId,
  normCompany,
  normFirstName,
  sizeBandStatus,
} from "../src/normalize.js";
import { filterNewLeads } from "../src/pull.js";
import {
  applyWaterfallHit,
  companyDomainOf,
  matchApifyItem,
  needsCompany,
  needsEmail,
  resolveCompanies,
  resolveEmails,
  shouldWaterfall,
} from "../src/resolve.js";
import { mapApifyCompany, mapApifyProfile } from "../src/clients/apify.js";
import { nextParkedStatus } from "../src/parked.js";

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
    assert.equal(sizeBandStatus("11 to 50", "Acme", "x", 1), "needs_email");
    assert.equal(sizeBandStatus(null, null, null, 1), "needs_company_data");
    assert.equal(sizeBandStatus("—", "Acme", "a@x.com", 1), "needs_company_data");
  });

  it("maps HarvestAPI employee ranges onto hook size bands", () => {
    assert.equal(bandFromEmployeeCount(42, { start: 11, end: 50 }), "11 to 50");
    assert.equal(bandFromEmployeeCount(16985, { start: 10001, end: null }), "10001+");
    assert.equal(bandFromEmployeeCount(7, null), "1 to 10");
    assert.equal(bandFromEmployeeCount(null, null), null);
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
  it("treats em-dash employee bands as missing", () => {
    assert.equal(normalizeLead({ leadId: "x", engagerEmployees: "—" }).engagerEmployees, null);
    assert.equal(normalizeLead({ leadId: "x", engagerEmployees: "11 to 50" }).engagerEmployees, "11 to 50");
  });

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

  it("reads company domain from a website and treats placeholder size as missing", () => {
    assert.equal(needsCompany({ engagerCompany: "" }), true);
    assert.equal(needsCompany({ engagerCompany: "Acme", engagerEmployees: "—" }), true);
    assert.equal(needsCompany({ engagerCompany: "Acme", engagerEmployees: "11 to 50" }), false);
    assert.equal(companyDomainOf({ engagerCompanyWebsite: "https://www.acme.com/about" }), "acme.com");
    assert.equal(companyDomainOf({ engagerEmail: "pat@gmail.com", engagerCompany: "Acme" }), "");
  });

  it("reads company size and website from the nested HarvestAPI company object", () => {
    const mapped = mapApifyProfile({
      linkedinUrl: "https://www.linkedin.com/in/pat-lee",
      currentPosition: [
        {
          companyName: "Acme Inc",
          position: "VP Sales",
          company: {
            name: "Acme Inc",
            website: "https://www.acme.com",
            employeeCount: 42,
            employeeCountRange: { start: 11, end: 50 },
          },
        },
      ],
    });
    assert.equal(mapped.company, "Acme Inc");
    assert.equal(mapped.employees, "11 to 50");
    assert.equal(mapped.website, "https://www.acme.com");
    assert.equal(mapped.title, "VP Sales");
    const hashed = mapApifyProfile({
      id: "ACoAAA8BYqEBCGLg_vT_ca6mMEqkpp9nVffJ3hc",
      linkedinUrl: "https://www.linkedin.com/in/jane-doe",
      publicIdentifier: "jane-doe",
      originalQuery: { profileId: "ACoAAA8BYqEBCGLg_vT_ca6mMEqkpp9nVffJ3hc" },
      currentPosition: [
        {
          companyName: "Acme Inc",
          companyLinkedinUrl: "https://www.linkedin.com/company/acme-inc",
        },
      ],
    });
    assert.equal(hashed.profileId, "ACoAAA8BYqEBCGLg_vT_ca6mMEqkpp9nVffJ3hc");
    assert.equal(hashed.companyLinkedinUrl, "https://www.linkedin.com/company/acme-inc");
    const matched = matchApifyItem(
      { engagerLinkedinUrl: "https://www.linkedin.com/in/ACoAAA8BYqEBCGLg_vT_ca6mMEqkpp9nVffJ3hc" },
      [hashed],
    );
    assert.equal(matched.company, "Acme Inc");
    assert.equal(
      mapApifyCompany({
        linkedinUrl: "https://www.linkedin.com/company/acme-inc",
        universalName: "acme-inc",
        website: "https://acme.com",
        employeeCount: 120,
        employeeCountRange: { start: 51, end: 200 },
      }).employees,
      "51 to 200",
    );
  });

  it("does not scrape Apify when a person LinkedIn URL is present", async () => {
    const calls = [];
    const result = await resolveCompanies({
      leads: [
        {
          dedupeKey: "x",
          engagerCompany: "Acme",
          engagerEmployees: null,
          engagerLinkedinUrl: "https://www.linkedin.com/in/pat-lee",
        },
      ],
      apify: {
        async scrapeProfiles(urls) {
          calls.push(urls.length);
          return { items: [], usageTotalUsd: 0, runId: "run1" };
        },
        async scrapeCompanies(urls) {
          calls.push(urls.length);
          return { items: [], usageTotalUsd: 0, runId: "c1" };
        },
      },
      config: { apifyToken: "t", apifyBatchSize: 50, apifyCentsPerProfile: 0.4 },
      spend: { spendCents: 0 },
      supabase: { async rpc() { return { data: { month_key: "2026-08", apify_cents: 0, waterfall_cents: 0, verifier_cents: 0 }, error: null }; } },
      log: { info() {}, warn() {} },
      cap: 500,
    });
    assert.equal(calls.length, 0);
    assert.ok(result.stats.skipped_aiark >= 1);
  });

  it("treats junk getleads emails as missing and waterfalls with an existing Apify domain", async () => {
    const person = {
      engagerFirstName: "Pat",
      engagerLastName: "Lee",
      engagerCompany: "Acme",
      engagerEmployees: "11 to 50",
      engagerEmail: "x",
      engagerLinkedinUrl: "https://www.linkedin.com/in/pat-lee",
      companyDomain: "acme.com",
    };
    assert.equal(needsEmail(person), true);
    assert.equal(needsCompany(person), false);
    assert.equal(shouldWaterfall(person), true);
    assert.equal(companyDomainOf(person), "acme.com");

    const sent = [];
    let jobStarted = false;
    const result = await resolveEmails({
      leads: [person],
      waterfall: {
        async health() { return { ok: true }; },
        async ensureClient() { return { ok: true }; },
        async enrich({ rows }) {
          jobStarted = true;
          sent.push(rows);
          return { job_id: "job-1" };
        },
        async waitForJob() { return { status: "completed" }; },
      },
      config: { emailWaterfallMcpUrl: "https://example.test/mcp", waterfallClientTag: "salesglider", waterfallCentsPerRow: 15 },
      spend: { spendCents: 0 },
      supabase: {
        from(table) {
          return {
            select() {
              return {
                in(_col, values) {
                  if (table.endsWith("_wf_contacts")) {
                    return {
                      data: jobStarted
                        ? [
                            {
                              domain: "acme.com",
                              first_name: "Pat",
                              last_name: "Lee",
                              email: "pat@acme.com",
                              source_tier: "aiark",
                              linkedin_url: "https://www.linkedin.com/in/pat-lee",
                            },
                          ]
                        : [],
                      error: null,
                    };
                  }
                  return { data: values?.[0] ? [{ domain: values[0], company_name: "Acme", employee_range: null }] : [], error: null };
                },
              };
            },
          };
        },
        async rpc(name, args) {
          return {
            data: { month_key: "2026-08", apify_cents: 0, waterfall_cents: args?.p_cents || 0, verifier_cents: 0 },
            error: null,
          };
        },
      },
      log: { info() {}, warn() {} },
      cap: 5000,
    });
    assert.equal(sent[0][0].domain, "acme.com");
    assert.equal(sent[0][0].linkedin_url, "https://www.linkedin.com/in/pat-lee");
    assert.equal(result.leads[0].engagerEmail, "pat@acme.com");
    assert.equal(result.stats.resolved, 1);
  });

  it("can match a waterfall contact by LinkedIn URL and copy the work-email domain", () => {
    const lead = {
      engagerLinkedinUrl: "https://www.linkedin.com/in/pat-lee",
      engagerFirstName: "Pat",
    };
    const changed = applyWaterfallHit(lead, {
      email: "pat@acme.com",
      source_tier: "aiark",
      linkedin_url: "https://www.linkedin.com/in/pat-lee",
    });
    assert.equal(changed, true);
    assert.equal(lead.engagerEmail, "pat@acme.com");
    assert.equal(lead.companyDomain, "acme.com");
    assert.equal(lead.companySource, "aiark");
  });

  it("sends one waterfall row per LinkedIn person", async () => {
    const sent = [];
    await resolveEmails({
      leads: [
        {
          engagerFirstName: "Pat",
          engagerLastName: "Lee",
          engagerCompany: "Acme",
          engagerEmployees: "11 to 50",
          engagerEmail: "x",
          engagerLinkedinUrl: "https://www.linkedin.com/in/pat-lee",
          companyDomain: "acme.com",
        },
        {
          engagerFirstName: "Pat",
          engagerLastName: "Lee",
          engagerCompany: "Acme",
          engagerEmployees: "11 to 50",
          engagerEmail: "x",
          engagerLinkedinUrl: "https://www.linkedin.com/in/pat-lee",
          companyDomain: "acme.com",
        },
      ],
      waterfall: {
        async health() { return { ok: true }; },
        async ensureClient() { return { ok: true }; },
        async enrich({ rows }) {
          sent.push(rows);
          return { job_id: "job-2" };
        },
        async waitForJob() { return { status: "completed" }; },
      },
      config: { emailWaterfallMcpUrl: "https://example.test/mcp", waterfallClientTag: "salesglider", waterfallCentsPerRow: 15 },
      spend: { spendCents: 0 },
      supabase: {
        from() {
          return { select() { return { in() { return { data: [], error: null }; } }; } };
        },
        async rpc() {
          return { data: { month_key: "2026-08", apify_cents: 0, waterfall_cents: 15, verifier_cents: 0 }, error: null };
        },
      },
      log: { info() {}, warn() {} },
      cap: 5000,
    });
    assert.equal(sent[0].length, 1);
  });

  it("re-gates parked placeholder bands as missing size, not dq_size", () => {
    assert.equal(
      nextParkedStatus(
        { engager_company: "Acme", engager_employees: "—", engager_email: "a@x.com", campaign_id: 1 },
        {},
      ),
      "needs_company_data",
    );
    assert.equal(
      nextParkedStatus(
        { engager_company: "Acme", engager_email: "a@x.com", campaign_id: 1 },
        { engagerEmployees: "11 to 50" },
      ),
      "pending_verification",
    );
    assert.equal(
      nextParkedStatus(
        { engager_company: "Acme", engager_employees: "11 to 50", engager_email: "x", campaign_id: 1 },
        {},
      ),
      "needs_email",
    );
  });
});
