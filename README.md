# sg-engager-pipeline

One service from getleads capture to Smartlead import. It is the only process that may write inbox status after `gl-engager-hook`.

```
getleads capture (already running)
   ↓  pull
prospect gates
   ↓
company resolution (Apify)
   ↓
email resolution (Email Finder Waterfall MCP)
   ↓
POST gl-engager-hook
   ↓
verification (Email Verifier Progression MCP)
   ↓
leads_staging → Smartlead import (campaigns stay DRAFTED)
```

Volume is not the goal. Ambiguous leads are dropped or parked. Paid calls never run before the prospect gates.

## Status ownership

| Status | Who writes it | Next step |
| --- | --- | --- |
| `pending_verification` | webhook on insert; pipeline after a parked row is fully resolved | verify sweep |
| `needs_email` | webhook | parked resolution |
| `needs_company_data` | webhook | parked resolution |
| `pending_campaign` | webhook | parked (unrecognized creator) |
| `dq_size` | webhook or parked re-gate | terminal |
| `verifying` | pipeline claim | verifier |
| `suppressed` | pipeline | terminal |
| `duplicate` | pipeline | terminal |
| `verified` | pipeline | stage |
| `verified_bad` | pipeline | terminal |
| `staged` | pipeline | import |
| `imported` | pipeline | terminal |
| `import_mismatch` | pipeline | retry next sweep unless campaign is skipped this run |
| `unresolvable` | pipeline after max resolution attempts | terminal |
| `error` | pipeline after 3-attempt backoff | inspect `routing_note` |

Terminal, never reprocessed: `dq_size`, `pending_campaign`, `suppressed`, `duplicate`, `verified_bad`, `imported`, `unresolvable`.

The webhook is the only insert path into `sg_engager_inbox`. Re-POSTing the same `dedupeKey` is a no-op (`ignoreDuplicates`). `dedupeKey` is getleads `leadId`. Never invent one.

## Loops

- **Pull** every `RUN_INTERVAL_MINUTES` (60): high-water mark per `profileId` on `capturedAt`, gates, optional paid resolve (capped by `ENRICHMENT_BATCH_LIMIT`), webhook batches of 200.
- **Verify** every `VERIFY_SWEEP_INTERVAL_MINUTES` (15): claim `pending_verification`, suppress, dedupe, Email Verifier Progression, stage, import.

A run that pulls zero and imports zero is normal. It logs and exits the tick. No retry loop.

## Spend

`public.sg_pipeline_spend` is month-keyed and split `apify` / `waterfall` / `verifier`. One cap: `MONTHLY_SPEND_CAP_CENTS`. When the next paid call would exceed it, spending stops, rows stay parked, and one log line is written.

Ship the first pass at `ENRICHMENT_BATCH_LIMIT=100` and read `/health` `first_run` before raising the batch or the cap.

## Hard rules

- Never call Smartlead START, PAUSE, or any campaign state endpoint.
- Never add, remove, or pause a getleads monitored profile.
- Never insert inbox rows except through the webhook.
- Never log emails, names, or lead rows. Counts, statuses, job ids, spend, distributions only.
- Never call AI Ark, LeadMagic, FullEnrich, Name to Email, MillionVerifier, or No2Bounce directly.

## Health

`GET /health` returns counts by status, last-run timestamps per profile, month-to-date spend by vendor, and the persisted first-run report.

`GET /feeds/:id.csv` is the short-lived CSV host Email Verifier Progression fetches. Requires `PUBLIC_BASE_URL` (Railway public domain).

## Env

See `.env.example`. Required at runtime: `GETLEADS_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SMARTLEAD_API_KEY`. Paid MCPs need `APIFY_TOKEN` plus the waterfall and verifier URLs.

```bash
npm test
npm start
node src/index.js --once
```
