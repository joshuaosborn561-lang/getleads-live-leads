function parseSseOrJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (raw.startsWith("{") || raw.startsWith("[")) return JSON.parse(raw);
  const chunks = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("data:")) chunks.push(line.slice(5).trim());
  }
  if (!chunks.length) return null;
  return JSON.parse(chunks.join("\n"));
}

export function unwrapToolResult(payload) {
  if (payload == null) return null;
  if (payload.error) {
    const err = new Error(payload.error.message || "mcp error");
    err.code = payload.error.code;
    throw err;
  }
  const result = payload.result ?? payload;
  if (result?.isError) {
    const text = extractText(result);
    throw new Error(text || "mcp tool error");
  }
  const text = extractText(result);
  if (text == null) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractText(result) {
  const content = result?.content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && (c.type === "text" || c.text))
      .map((c) => c.text)
      .join("");
  }
  if (typeof result === "string") return result;
  return null;
}

export function createMcpClient({ url, headers = {}, fetchImpl = globalThis.fetch, timeoutMs = 60_000 }) {
  let nextId = 1;

  async function rpc(method, params, { notification = false, timeout = timeoutMs } = {}) {
    const body = notification
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: nextId++, method, params };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (notification) return { status: res.status };
      const parsed = parseSseOrJson(text);
      if (!res.ok) {
        const err = new Error(`MCP HTTP ${res.status} ${method}`);
        err.status = res.status;
        err.body = parsed ?? text;
        throw err;
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  async function callTool(name, args = {}, options = {}) {
    const payload = await rpc("tools/call", { name, arguments: args }, options);
    return unwrapToolResult(payload);
  }

  return { rpc, callTool };
}
