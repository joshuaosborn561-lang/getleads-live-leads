import { requestJson, requestText, withBackoff } from "../http.js";
import { parseCsv, toCsv } from "../util/csv.js";

const UPLOAD_URL = "https://bulkapi.millionverifier.com/bulkapi/v2/upload";
const INFO_URL = "https://bulkapi.millionverifier.com/bulkapi/v2/fileinfo";
const DOWNLOAD_URL = "https://bulkapi.millionverifier.com/bulkapi/v2/download";

export const MV_BILLED = new Set(["ok", "invalid", "disposable"]);
export const MV_HARD_BAD = new Set(["invalid", "disposable"]);
export const MV_SECOND_PASS = new Set(["catch_all", "catchall", "unknown"]);

export function createMillionVerifier(config, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sleepFn = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function upload(rows) {
    const csv = toCsv(
      rows.map((row) => ({ inbox_id: row.id, email: row.engager_email })),
      ["inbox_id", "email"],
    );
    const url = `${UPLOAD_URL}?key=${encodeURIComponent(config.millionVerifierApiKey)}&remove_duplicates=0`;
    return withBackoff(async () => {
      const form = new FormData();
      form.append("file_contents", new Blob([csv], { type: "text/csv" }), "sg-engager.csv");
      const res = await requestJson(url, {
        method: "POST",
        body: form,
        timeoutMs: 60_000,
        fetchImpl,
      });
      const fileId = res.json?.file_id;
      if (!fileId) {
        throw new Error("MillionVerifier upload missing file_id");
      }
      return { fileId: String(fileId), raw: res.json };
    });
  }

  async function poll(fileId) {
    const started = Date.now();
    while (Date.now() - started < config.mvTimeoutMs) {
      const info = await withBackoff(async () => {
        const url = `${INFO_URL}?key=${encodeURIComponent(config.millionVerifierApiKey)}&file_id=${encodeURIComponent(fileId)}`;
        const res = await requestJson(url, { fetchImpl, timeoutMs: 30_000 });
        if (!res.json) throw new Error("MillionVerifier fileinfo empty");
        return res.json;
      });
      const status = String(info.status || "").toLowerCase();
      if (status === "finished") return info;
      if (status === "error" || status === "canceled") {
        throw new Error(`MillionVerifier file ${status}`);
      }
      await sleepFn(config.mvPollMs);
    }
    throw new Error("MillionVerifier poll timed out");
  }

  async function download(fileId) {
    const url = `${DOWNLOAD_URL}?key=${encodeURIComponent(config.millionVerifierApiKey)}&file_id=${encodeURIComponent(fileId)}&filter=all`;
    const res = await withBackoff(() => requestText(url, { fetchImpl, timeoutMs: 60_000 }));
    return parseCsv(res.text);
  }

  return { upload, poll, download };
}

export function indexMvResults(csvRows) {
  const byId = new Map();
  const byEmail = new Map();
  for (const row of csvRows) {
    const result = String(row.result || row.status || "").trim().toLowerCase();
    const id = Number(row.inbox_id || row.id);
    const email = String(row.email || "").trim().toLowerCase();
    const item = { result, email, id: Number.isFinite(id) ? id : null };
    if (item.id != null) byId.set(item.id, item);
    if (email) byEmail.set(email, item);
  }
  return { byId, byEmail };
}

export function lookupMvResult(row, index) {
  const byId = index.byId.get(Number(row.id));
  if (byId) return byId.result;
  const email = String(row.engager_email || "").trim().toLowerCase();
  return index.byEmail.get(email)?.result || "";
}

export function billedMvCount(results) {
  return results.filter((r) => MV_BILLED.has(r)).length;
}
