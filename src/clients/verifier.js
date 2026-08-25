import { createMcpClient } from "./mcp.js";
import { sleep, withBackoff } from "../http.js";

export function createVerifier(config, deps = {}) {
  const mcp = deps.mcp ?? createMcpClient({ url: config.emailVerifierMcpUrl, fetchImpl: deps.fetchImpl });

  async function start({ fileUrl, segmentName }) {
    return withBackoff(() =>
      mcp.callTool("start_verification", {
        file_url: fileUrl,
        segment_name: segmentName,
      }),
    );
  }

  async function status(runId) {
    return withBackoff(() => mcp.callTool("get_verification_status", { run_id: runId }));
  }

  async function results(runId) {
    return withBackoff(() => mcp.callTool("get_verification_results", { run_id: runId }));
  }

  async function waitForRun(runId, { timeoutMs = 45 * 60_000, pollMs = 10_000 } = {}) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await status(runId);
      const run = last?.run || last;
      const st = String(run?.status || last?.status || "").toLowerCase();
      if (st === "completed") return run;
      if (["failed", "paused"].includes(st)) {
        const err = new Error(`verifier ${st}`);
        err.run = run;
        throw err;
      }
      await sleep(pollMs);
    }
    throw new Error("verifier timeout");
  }

  return { start, status, results, waitForRun, mcp };
}

export function extractRunId(started) {
  return (
    started?.run_id ||
    started?.id ||
    started?.run?.id ||
    started?.run?.run_id ||
    null
  );
}
