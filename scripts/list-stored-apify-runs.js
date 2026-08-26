/**
 * Read-only: list recent HarvestAPI profile/company runs already paid in Apify.
 * Does not start new scrapes.
 */
import { ApifyClient } from "apify-client";

const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) {
  console.error("APIFY_TOKEN missing");
  process.exit(1);
}

const client = new ApifyClient({ token: TOKEN });
const actors = [
  { name: "profile", id: "harvestapi~linkedin-profile-scraper" },
  { name: "company", id: "harvestapi~linkedin-company" },
];

for (const actor of actors) {
  const list = await client.actor(actor.id).runs().list({ limit: 15, desc: true });
  console.log(`=== ${actor.name} ===`);
  for (const run of list.items || []) {
    const started = run.startedAt ? new Date(run.startedAt).toISOString() : "";
    const ds = run.defaultDatasetId || "";
    let count = "?";
    if (ds) {
      try {
        const info = await client.dataset(ds).get();
        count = String(info?.itemCount ?? "?");
      } catch {
        count = "err";
      }
    }
    console.log(
      [run.id, run.status, started, `items=${count}`, `dataset=${ds}`, `usageUsd=${run.usageTotalUsd ?? "?"}`].join(" ")
    );
  }
}
