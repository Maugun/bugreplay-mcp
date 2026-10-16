import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { isLoopbackUrl, sanitizeText, sanitizeUrl } from "./security.js";
import { readStoredCase } from "./storage.js";
import type { CaptureEvent, ReplayIssue, ReplayResult, StoredCase } from "./types.js";

export async function replayCase(root: string, caseId: string): Promise<ReplayResult> {
  const stored = await readStoredCase(root, caseId);
  if (!isLoopbackUrl(stored.manifest.startUrl)) {
    throw new Error("This capture does not have a replayable localhost start URL.");
  }

  const startedAt = new Date().toISOString();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const blockedExternal = new Set<string>();
  const issues: ReplayIssue[] = [];
  const pageIndexes = new Map<Page, number>();
  const pagesByIndex = new Map<number, Page>();
  let nextPageIndex = 0;

  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:") || isLoopbackUrl(url)) {
      await route.continue();
      return;
    }
    blockedExternal.add(sanitizeUrl(url, stored.manifest.options));
    await route.abort("blockedbyclient");
  });

  context.on("page", (page) => {
    attachReplayPage(page, nextPageIndex++, pageIndexes, pagesByIndex, issues, stored);
  });

  const skipped: ReplayResult["actions"]["skipped"] = [];
  const failed: ReplayResult["actions"]["failed"] = [];
  const actions = stored.events.filter((event): event is Extract<CaptureEvent, { kind: "action" }> => event.kind === "action");
  let completed = 0;
  let screenshot: string | undefined;

  try {
    const page = await context.newPage();
    if (!pagesByIndex.has(0)) attachReplayPage(page, nextPageIndex++, pageIndexes, pagesByIndex, issues, stored);
    await page.goto(stored.manifest.startUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });

    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      const page = pagesByIndex.get(action.pageIndex);
      if (!page || page.isClosed()) {
        failed.push({ actionIndex: index, reason: `Recorded browser tab ${action.pageIndex + 1} is not open during replay.` });
        continue;
      }
      if ((action.action === "fill" || action.action === "select") && (action.redacted || action.value === undefined)) {
        skipped.push({ actionIndex: index, reason: `The ${action.action} value was redacted during capture.` });
        continue;
      }

      try {
        const locator = page.locator(action.selector);
        const count = await locator.count();
        if (count !== 1) {
          throw new Error(`Selector matched ${count} elements; replay requires exactly one.`);
        }
        switch (action.action) {
          case "click":
            await locator.click({ timeout: 5_000 });
            break;
          case "fill":
            await locator.fill(action.value ?? "", { timeout: 5_000 });
            break;
          case "check":
            await locator.check({ timeout: 5_000 });
            break;
          case "uncheck":
            await locator.uncheck({ timeout: 5_000 });
            break;
          case "select":
            await locator.selectOption(action.value ?? "", { timeout: 5_000 });
            break;
        }
        completed += 1;
        await page.waitForTimeout(100);
      } catch (error) {
        failed.push({ actionIndex: index, reason: sanitizeText(errorMessage(error)).slice(0, 1000) });
      }
    }

    if (stored.manifest.options.captureScreenshots) {
      const lastPage = pagesByIndex.get(0);
      if (lastPage && !lastPage.isClosed()) {
        const fileName = `replay-${Date.now()}-${randomUUID().slice(0, 8)}.png`;
        await lastPage.screenshot({ path: path.join(stored.directory, fileName), timeout: 5_000 }).catch(() => undefined);
        screenshot = fileName;
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  return {
    caseId,
    startedAt,
    finishedAt: new Date().toISOString(),
    actions: { recorded: actions.length, completed, skipped, failed },
    issues,
    blockedExternalRequests: [...blockedExternal],
    screenshot,
    complete: skipped.length === 0 && failed.length === 0 && completed === actions.length,
  };
}

export async function verifyFix(root: string, caseId: string): Promise<{
  replay: ReplayResult;
  comparison: {
    baselineIssueCount: number;
    replayIssueCount: number;
    resolved: string[];
    stillPresent: string[];
    newIssues: string[];
    likelyImproved: boolean;
  };
  notes: string[];
}> {
  const stored = await readStoredCase(root, caseId);
  const replay = await replayCase(root, caseId);
  const baseline = stored.events.map(toIssue).filter((issue): issue is ReplayIssue => issue !== undefined);
  const before = groupIssues(baseline);
  const after = groupIssues(replay.issues);
  const resolved: string[] = [];
  const stillPresent: string[] = [];
  const newIssues: string[] = [];

  for (const [key, count] of before) {
    const remaining = after.get(key) ?? 0;
    if (remaining < count) resolved.push(`${key} (${count - remaining} fewer)`);
    if (remaining > 0) stillPresent.push(`${key} (${remaining})`);
  }
  for (const [key, count] of after) {
    if (!before.has(key)) newIssues.push(`${key} (${count})`);
  }

  const notes: string[] = [];
  if (stored.manifest.urlStateRedacted) notes.push("The initial URL contained query or hash state that was redacted; replay started from the sanitized URL.");
  if (replay.actions.skipped.length > 0) notes.push("Some form values were redacted, so the replay may not follow the original path completely.");
  if (replay.blockedExternalRequests.length > 0) notes.push("External network requests were blocked during replay. Only loopback requests are allowed.");

  return {
    replay,
    comparison: {
      baselineIssueCount: baseline.length,
      replayIssueCount: replay.issues.length,
      resolved,
      stillPresent,
      newIssues,
      likelyImproved: resolved.length > 0 && newIssues.length === 0 && stillPresent.length === 0 && replay.complete && replay.blockedExternalRequests.length === 0,
    },
    notes,
  };
}

function attachReplayPage(
  page: Page,
  index: number,
  pageIndexes: Map<Page, number>,
  pagesByIndex: Map<number, Page>,
  issues: ReplayIssue[],
  stored: StoredCase,
): void {
  if (pageIndexes.has(page)) return;
  pageIndexes.set(page, index);
  pagesByIndex.set(index, page);
  page.on("console", (message) => {
    if (message.type() === "error") issues.push({ kind: "console", text: sanitizeText(message.text()).slice(0, 1000), url: sanitizeUrl(page.url(), stored.manifest.options) });
  });
  page.on("pageerror", (error) => {
    issues.push({ kind: "page_error", text: sanitizeText(error.message).slice(0, 1000), url: sanitizeUrl(page.url(), stored.manifest.options) });
  });
  page.on("requestfailed", (request) => {
    if (!isLoopbackUrl(request.url())) return;
    issues.push({
      kind: "request_failed",
      text: sanitizeText(request.failure()?.errorText ?? "Request failed").slice(0, 1000),
      url: sanitizeUrl(request.url(), stored.manifest.options),
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && isLoopbackUrl(response.url())) {
      issues.push({
        kind: "http_error",
        text: `${response.request().method()} ${sanitizeUrl(response.url(), stored.manifest.options)}`,
        url: sanitizeUrl(response.url(), stored.manifest.options),
        status: response.status(),
      });
    }
  });
}

function toIssue(event: CaptureEvent): ReplayIssue | undefined {
  switch (event.kind) {
    case "console":
      return event.level === "error" ? { kind: "console", text: event.text, url: event.url } : undefined;
    case "page_error":
      return { kind: "page_error", text: firstLine(event.text), url: event.url };
    case "request_failed":
      return isLoopbackUrl(event.url) ? { kind: "request_failed", text: event.text, url: event.url } : undefined;
    case "response":
      return event.status >= 400 && isLoopbackUrl(event.url)
        ? { kind: "http_error", text: `${event.method} ${event.url}`, url: event.url, status: event.status }
        : undefined;
    default:
      return undefined;
  }
}

function groupIssues(issues: ReplayIssue[]): Map<string, number> {
  const grouped = new Map<string, number>();
  for (const issue of issues) {
    const key = `${issue.kind}: ${normalizeIssue(issue.text)}`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  return grouped;
}

function normalizeIssue(text: string): string {
  return firstLine(text)
    .replace(/:\d+:\d+/g, ":line:column")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[id]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
