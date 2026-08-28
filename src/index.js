import http from "node:http";
import { pathToFileURL } from "node:url";
import { createApify } from "./clients/apify.js";
import { createGetleads } from "./clients/getleads.js";
import { createSmartlead } from "./clients/smartlead.js";
import { createVerifier } from "./clients/verifier.js";
import { createWaterfall } from "./clients/waterfall.js";
import { createWebhook } from "./clients/webhook.js";
import { assertRuntimeConfig, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { bootstrapSchema, countsByStatus, getFeed, loadFirstRunReport, loadHwm } from "./inbox.js";
import { runParkedResolution } from "./parked.js";
import { emptyPullCounts, runPull } from "./pull.js";
import { loadSpend } from "./spend.js";
import { createSupabase } from "./supabase.js";
import { emptyCounts, runSweep } from "./sweep.js";

const log = createLogger("sg-engager-pipeline");

function startServer(port, { getState, getFeedCsv }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/health" || url.pathname === "/") {
      const body = JSON.stringify({ ok: true, service: "sg-engager-pipeline", ...getState() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    const feed = url.pathname.match(/^\/feeds\/([A-Za-z0-9._-]+)\.csv$/);
    if (feed) {
      try {
        const csv = await getFeedCsv(feed[1]);
        if (!csv) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        });
        res.end(csv);
      } catch (err) {
        res.writeHead(500);
        res.end(String(err.message || "error"));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => {
    log.info("health server listening", { port });
  });
  return server;
}

export async function main(env = process.env, argv = process.argv) {
  const config = loadConfig(env, argv);
  assertRuntimeConfig(config);

  const state = {
    last_pull: null,
    last_sweep: null,
    last_pull_counts: emptyPullCounts(),
    last_sweep_counts: emptyCounts(),
    pull_running: false,
    sweep_running: false,
    status_counts: {},
    spend: null,
    profiles: [],
    first_run: null,
  };

  const supabase = createSupabase(config);

  const server = startServer(config.port, {
    getState: () => ({
      last_pull: state.last_pull,
      last_sweep: state.last_sweep,
      last_pull_counts: state.last_pull_counts,
      last_sweep_counts: state.last_sweep_counts,
      pull_running: state.pull_running,
      sweep_running: state.sweep_running,
      status_counts: state.status_counts,
      spend: state.spend,
      profiles: state.profiles,
      first_run: state.first_run,
    }),
    getFeedCsv: (id) => getFeed(supabase, id),
  });

  await bootstrapSchema(supabase);

  const deps = {
    supabase,
    config,
    getleads: createGetleads(config),
    apify: createApify(config),
    waterfall: createWaterfall(config),
    verifier: createVerifier(config),
    webhook: createWebhook(config),
    smartlead: createSmartlead(config),
    log,
  };

  async function refreshHealth() {
    try {
      state.status_counts = await countsByStatus(supabase);
      state.spend = await loadSpend(supabase);
      state.profiles = await loadHwm(supabase);
      const first = await loadFirstRunReport(supabase);
      state.first_run = first?.report || null;
    } catch (err) {
      log.warn("health refresh failed", { error: err.message });
    }
  }

  async function pullTick() {
    if (state.pull_running) {
      log.warn("pull already running; skipping overlapping tick");
      return state.last_pull_counts;
    }
    state.pull_running = true;
    try {
      const counts = await runPull(deps);
      await runParkedResolution(deps);
      state.last_pull_counts = counts;
      state.last_pull = new Date().toISOString();
      await refreshHealth();
      return counts;
    } catch (err) {
      log.error("pull failed", { error: err.message });
      throw err;
    } finally {
      state.pull_running = false;
    }
  }

  async function sweepTick() {
    if (state.sweep_running) {
      log.warn("sweep already running; skipping overlapping tick");
      return state.last_sweep_counts;
    }
    state.sweep_running = true;
    try {
      const counts = await runSweep(deps);
      state.last_sweep_counts = counts;
      state.last_sweep = new Date().toISOString();
      await refreshHealth();
      return counts;
    } catch (err) {
      log.error("sweep failed", { error: err.message });
      throw err;
    } finally {
      state.sweep_running = false;
    }
  }

  await refreshHealth();

  if (!config.verifyOnly) await pullTick();
  if (!config.pullOnly) await sweepTick();

  if (config.once) {
    server.close();
    return { pull: state.last_pull_counts, sweep: state.last_sweep_counts };
  }

  setInterval(() => {
    pullTick().catch(() => {});
  }, config.runIntervalMinutes * 60_000);
  setInterval(() => {
    sweepTick().catch(() => {});
  }, config.verifySweepIntervalMinutes * 60_000);

  log.info("pipeline loops started", {
    run_interval_minutes: config.runIntervalMinutes,
    verify_sweep_interval_minutes: config.verifySweepIntervalMinutes,
    enrichment_batch_limit: config.enrichmentBatchLimit,
    monthly_spend_cap_cents: config.monthlySpendCapCents,
    apify_job_cap_usd: config.apifyJobCapUsd,
  });
  return { server, pullTick, sweepTick };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log.error("fatal", { error: err.message });
    process.exit(1);
  });
}
