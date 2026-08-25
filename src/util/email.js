export function normalizeEmail(value) {
  if (value == null) return "";
  return String(value).trim().toLowerCase();
}

export function emailDomain(value) {
  const email = normalizeEmail(value);
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return "";
  return email.slice(at + 1);
}

export function isEmail(value) {
  const email = normalizeEmail(value);
  return Boolean(email && email.includes("@") && emailDomain(email));
}
