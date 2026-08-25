import http from "node:http";
import { pathToFileURL } from "node:url";
import { assertRuntimeConfig, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createMillionVerifier } from "./clients/millionverifier.js";
import { createNo2Bounce } from "./clients/no2bounce.js";
import { createSmartlead } from "./clients/smartlead.js";
import { bootstrapSchema } from "./inbox.js";
import { createSupabase } from "./supabase.js";
import { emptyCounts, runSweep } from "./sweep.js";

const log = createLogger();

function startHealthServer(port, getState) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      const body = JSON.stringify({ ok: true, ...getState() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
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
    last_sweep: null,
    last_counts: emptyCounts(),
    running: false,
  };
  const server = startHealthServer(config.port, () => ({
    last_sweep: state.last_sweep,
    last_counts: state.last_counts,
    running: state.running,
  }));

  const supabase = createSupabase(config);
  await bootstrapSchema(supabase);

  const deps = {
    supabase,
    config,
    mv: createMillionVerifier(config),
    n2b: createNo2Bounce(config),
    smartlead: createSmartlead(config),
    log,
  };

  async function tick() {
    if (state.running) {
      log.warn("sweep already running; skipping overlapping tick");
      return state.last_counts;
    }
    state.running = true;
    try {
      const counts = await runSweep(deps);
      state.last_counts = counts;
      state.last_sweep = new Date().toISOString();
      return counts;
    } catch (err) {
      log.error("sweep failed", { error: err.message });
      throw err;
    } finally {
      state.running = false;
    }
  }

  await tick();
  if (config.once) {
    server.close();
    return state.last_counts;
  }

  const intervalMs = config.sweepIntervalMinutes * 60_000;
  setInterval(() => {
    tick().catch(() => {});
  }, intervalMs);
  log.info("worker loop started", { sweep_interval_minutes: config.sweepIntervalMinutes });
  return { server, tick };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log.error("fatal", { error: err.message });
    process.exit(1);
  });
}
