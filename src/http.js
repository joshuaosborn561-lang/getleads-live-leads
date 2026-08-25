export class HttpError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withBackoff(fn, { attempts = 3, delaysMs = [500, 1500, 3500] } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn(i);
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        await sleep(delaysMs[i] ?? delaysMs[delaysMs.length - 1]);
      }
    }
  }
  throw lastError;
}

export async function requestJson(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 30_000,
    fetchImpl = globalThis.fetch,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      throw new HttpError(`HTTP ${res.status} ${method}`, {
        status: res.status,
        body: json ?? text,
      });
    }
    return { status: res.status, json, text, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

export async function requestText(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 60_000,
    fetchImpl = globalThis.fetch,
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new HttpError(`HTTP ${res.status} ${method}`, {
        status: res.status,
        body: text,
      });
    }
    return { status: res.status, text, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

export async function mapPool(items, concurrency, worker) {
  if (!items.length) return [];
  const limit = Math.max(1, concurrency);
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
