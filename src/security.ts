import { isIP } from "node:net";
import type { CaptureOptions } from "./types.js";

const SENSITIVE_NAME = /(password|passwd|secret|token|authorization|api[_-]?key|access[_-]?key|session|cookie|credential|client[_-]?secret|jwt|bearer|signature|(?:^|[_-])code(?:$|[_-]))/i;

export function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;

  const family = isIP(hostname);
  if (family === 4) return hostname.split(".")[0] === "127";
  if (family === 6) return hostname === "::1";
  return false;
}

export function assertLocalHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid absolute http:// or https:// URL.");
  }
  if (!isLoopbackUrl(value)) {
    throw new Error("BugReplay currently captures localhost URLs only (localhost, *.localhost, or a 127.0.0.0/8 address).");
  }
  return url;
}

export function sanitizeUrl(value: string, options: Pick<CaptureOptions, "includeQueryValues">): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";

    if (!options.includeQueryValues) {
      url.search = "";
      url.hash = "";
    } else {
      for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_NAME.test(key)) url.searchParams.set(key, "[redacted]");
      }
      url.hash = redactSensitiveText(url.hash).replace(/\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g, "[redacted-token]");
    }
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

export function sanitizeText(value: string): string {
  return redactSensitiveText(value)
    .replace(/\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g, "[redacted-token]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (match) => sanitizeUrl(match, { includeQueryValues: false }));
}

export function shouldRedactInput(input: {
  type?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  ariaLabel?: string;
}): boolean {
  return input.type?.toLowerCase() === "password" ||
    SENSITIVE_NAME.test(input.name ?? "") ||
    SENSITIVE_NAME.test(input.id ?? "") ||
    SENSITIVE_NAME.test(input.autocomplete ?? "") ||
    SENSITIVE_NAME.test(input.ariaLabel ?? "");
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/((?:password|passwd|secret|token|authorization|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
}
