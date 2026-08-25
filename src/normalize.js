const LEGAL_SUFFIX =
  /[,\s]+(l\.?l\.?c\.?|inc\.?|incorporated|corp\.?|corporation|ltd\.?|limited|l\.?l\.?p\.?|p\.?l\.?l\.?c\.?|p\.?c\.?|co\.?|company|group|holdings?)\s*\.?$/i;

export function titleCase(s) {
  return String(s).replace(/[A-Za-z][A-Za-z'\u2019]*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

export function normFirstName(raw) {
  if (!raw) return null;
  let n = String(raw).trim();
  const nick = n.match(/[("\u201C]([A-Za-z][A-Za-z'\-]+)[)"\u201D]/);
  if (nick) n = nick[1];
  n = n.split(",")[0].trim();
  n = n.replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, "");
  n = n.split(/\s+/)[0];
  n = n.replace(/[^A-Za-z'\-\u2019]/g, "");
  if (n.length === 0) return null;
  if (n === n.toUpperCase() || n === n.toLowerCase()) n = titleCase(n);
  return n;
}

export function normCompany(raw) {
  if (!raw) return null;
  let c = String(raw).trim();
  let prev = "";
  while (prev !== c) {
    prev = c;
    c = c.replace(LEGAL_SUFFIX, "").trim();
  }
  c = c.replace(/[\s,]*(&|and)\s*$/i, "").trim();
  c = c.replace(/[\s,.\-]+$/g, "").trim();
  if (c.length === 0) return String(raw).trim();
  if (c === c.toUpperCase() && /[A-Z]{4,}/.test(c.replace(/[^A-Z]/g, ""))) c = titleCase(c);
  return c;
}

export function companiesMatch(a, b) {
  const left = (normCompany(a) || "").toLowerCase();
  const right = (normCompany(b) || "").toLowerCase();
  if (!left || !right) return true;
  if (left === right) return true;
  return left.includes(right) || right.includes(left);
}

export function linkedinSlug(url) {
  if (!url) return "";
  const m = String(url).toLowerCase().match(/linkedin\.com\/in\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]).replace(/\/+$/, "") : "";
}

export function hashedProfileId(urlOrId) {
  const raw = String(urlOrId || "").trim();
  if (!raw) return "";
  const path = raw.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, "").split(/[/?#]/)[0];
  if (/^ACoAA/i.test(path)) return path;
  return "";
}

export function domainFromWebsite(value) {
  if (!value) return "";
  let raw = String(value).trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function sizeBandStatus(band, company, email, campaignId) {
  if (band && (SIZE_DQ_SET.has(band) || !SIZE_OK_SET.has(band))) return "dq_size";
  if (!band || !company) return "needs_company_data";
  if (!email) return "needs_email";
  if (!campaignId) return "pending_campaign";
  return "pending_verification";
}

const SIZE_OK_SET = new Set(["11 to 50", "51 to 200", "201 to 500"]);
const SIZE_DQ_SET = new Set([
  "1 to 10",
  "501 to 1000",
  "1001 to 5000",
  "5001 to 10000",
  "10000+",
  "10001+",
]);
