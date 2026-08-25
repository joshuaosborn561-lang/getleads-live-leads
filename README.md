# SalesGlider engager worker

Background worker that takes `public.sg_engager_inbox` rows from `pending_verification` through verification, `leads_staging`, and Smartlead import.

Deploy target is Railway, in the same project as [verifyfall](https://verifyfall-production.up.railway.app). Share that service's `MILLIONVERIFIER_API_KEY` and `NO2BOUNCE_API_KEY`.

## Sweep (every `SWEEP_INTERVAL_MINUTES`, default 15)

1. **Claim** up to 500 `pending_verification` rows with `SELECT … FOR UPDATE SKIP LOCKED` and mark them `verifying` in the same transaction.
2. **Suppression** against `public.sg_engager_suppression` (created and seeded on bootstrap). Matching domains become `suppressed`. Rows are never deleted.
3. **Dedupe** against Smartlead `GET /campaigns/{id}/leads?email=` and against the inbox on `lower(engager_email)` (first `id` wins). Hits become `duplicate`.
4. **Verify** remaining emails with the MillionVerifier bulk API. `ok` → `verified`. Hard invalid (`invalid`, `disposable`) → `verified_bad`. `catch_all` and `unknown` go to No2Bounce. N2B passes → `verified`. N2B failures → `verified_bad`.
5. **Spend cap.** `MONTHLY_SPEND_CAP_CENTS` (default 500) is persisted in `public.sg_worker_spend`. If the next paid batch would exceed the cap, verification stops, remaining rows go back to `pending_verification`, and one log line is written. Nothing is skipped silently.
6. **Stage** `verified` rows into `public.leads_staging` (email, `first_name_n`, `engager_last_name`, `company_n`, `campaign_id`, plus LinkedIn/location when present). Inbox status becomes `staged`.
7. **Import** staged rows with `POST /campaigns/{id}/leads` in chunks of 200. Success only when `upload_count === submitted`. Mismatch → `import_mismatch` and that campaign is skipped for the rest of the sweep. `upload_count` and `already_added_to_campaign` are not summed.

A sweep that verifies zero and imports zero is a normal idle outcome. Overlapping ticks are skipped; there is no retry loop.

## Hard rules

- Never change campaign status. Never call START, PAUSE, or any campaign state endpoint.
- Never log lead rows, emails, or names. Logs carry counts, statuses, job ids, and spend only.
- Terminal for this worker: `needs_email`, `needs_company_data`, `pending_campaign`, `dq_size`, `suppressed`, `duplicate`, `verified_bad`.
- Writes are idempotent on `dedupe_key`.
- External calls use a 3-attempt backoff, then the row is marked `error` with the message in `routing_note`.

## Env

| Name | Required | Default |
| --- | --- | --- |
| `SUPABASE_URL` | yes | |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | |
| `SMARTLEAD_API_KEY` | yes | |
| `MILLIONVERIFIER_API_KEY` | yes | |
| `NO2BOUNCE_API_KEY` | yes | |
| `MONTHLY_SPEND_CAP_CENTS` | no | `500` |
| `SWEEP_INTERVAL_MINUTES` | no | `15` |
| `PORT` | no | `8080` |

Optional cost knobs: `MV_CENTS_PER_CREDIT` (default `0.178`) and `N2B_CENTS_PER_CHECK` (default `0.8`).

## Railway

Add a service in the verifyfall project, point it at this repo, and share the verifier keys from verifyfall. Set the Supabase and Smartlead vars on the new service. Health check: `GET /health`.

```bash
npm test
npm start          # loop
node src/index.js --once
```
