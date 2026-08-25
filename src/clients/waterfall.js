import { createMcpClient } from "./mcp.js";
import { withBackoff } from "../http.js";
import { sleep } from "../http.js";

export function createWaterfall(config, deps = {}) {
  const mcp = deps.mcp ?? createMcpClient({ url: config.emailWaterfallMcpUrl, fetchImpl: deps.fetchImpl });

  async function health() {
    return withBackoff(() => mcp.callTool("health", {}));
  }

  async function ensureClient() {
    return withBackoff(() =>
      mcp.callTool("ensure_client", {
        client_tag: config.waterfallClientTag,
        display_name: "SalesGlider Growth",
        profile: "owner",
        icp: "MSP, staffing, and PE operators who engage with ICP creators",
      }),
    );
  }

  async function enrich({ rows, need = "email", requireTitleMatch = false, background = true }) {
    const payload = {
      rows: typeof rows === "string" ? rows : JSON.stringify(rows),
      client_tag: config.waterfallClientTag,
      need,
      require_title_match: requireTitleMatch,
      background,
    };
    return withBackoff(() => mcp.callTool("enrich_waterfall", payload));
  }

  async function jobStatus(jobId) {
    return withBackoff(() => mcp.callTool("get_job_status", { job_id: jobId }));
  }

  async function listJobs(limit = 20) {
    return withBackoff(() => mcp.callTool("list_background_jobs", { limit }));
  }

  async function waitForJob(jobId, { timeoutMs = 15 * 60_000, pollMs = 8_000 } = {}) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await jobStatus(jobId);
      const status = String(last?.status || last?.state || "").toLowerCase();
      if (["completed", "complete", "succeeded", "success", "done"].includes(status)) return last;
      if (["failed", "error", "cancelled"].includes(status)) {
        throw new Error(`waterfall job ${status}`);
      }
      await sleep(pollMs);
    }
    throw new Error("waterfall job timeout");
  }

  return { health, ensureClient, enrich, jobStatus, listJobs, waitForJob, mcp };
}
