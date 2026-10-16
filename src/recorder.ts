import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { assertLocalHttpUrl, sanitizeText, sanitizeUrl, shouldRedactInput } from "./security.js";
import { createCaseDirectory, openEventLog, resolveProjectRoot, writeManifest, type EventLog } from "./storage.js";
import type { ActionEvent, CaptureEvent, CaptureManifest, CaptureOptions, NewCaptureEvent } from "./types.js";

const execFileAsync = promisify(execFile);
const BINDING_NAME = "__bugreplayRecord";

export interface StartCaptureInput extends CaptureOptions {
  url: string;
}

export interface CaptureSession {
  root: string;
  id: string;
  directory: string;
  browser: Browser;
  context: BrowserContext;
  pages: Page[];
  startedAt: string;
  startedMs: number;
  options: CaptureOptions;
  manifest: CaptureManifest;
  log: EventLog;
  eventCount: number;
  pageIndexes: Map<Page, number>;
  record(event: NewCaptureEvent): void;
}

let activeCapture: CaptureSession | undefined;
let captureStarting = false;

export async function beginCapture(input: StartCaptureInput): Promise<CaptureSession> {
  if (activeCapture || captureStarting) throw new Error(`Capture ${activeCapture?.id ?? "startup"} is already running. Stop it before starting another.`);
  assertLocalHttpUrl(input.url);
  captureStarting = true;
  let browser: Browser | undefined;
  let log: EventLog | undefined;
  let directory: string | undefined;
  let manifest: CaptureManifest | undefined;
  try {
    const root = await resolveProjectRoot();
    const created = await createCaseDirectory(root);
    const id = created.id;
    directory = created.directory;
    const options: CaptureOptions = {
      includeInputValues: input.includeInputValues,
      includeQueryValues: input.includeQueryValues,
      captureScreenshots: input.captureScreenshots,
    };
    const startedAt = new Date().toISOString();
    manifest = {
      schemaVersion: 1,
      id,
      status: "recording",
      startedAt,
      startUrl: sanitizeUrl(input.url, options),
      urlStateRedacted: hasUrlStateRedacted(input.url, options.includeQueryValues),
      options,
      gitHead: await getGitHead(root),
      screenshots: {},
      eventCount: 0,
    };
    log = openEventLog(directory);
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    const pages: Page[] = [];
    const pageIndexes = new Map<Page, number>();
    const session: CaptureSession = {
      root,
      id,
      directory,
      browser,
      context,
      pages,
      pageIndexes,
      startedAt,
      startedMs: Date.now(),
      options,
      manifest,
      log,
      eventCount: 0,
      record(event) {
        const stored = {
          ...event,
          at: new Date().toISOString(),
          elapsedMs: Date.now() - session.startedMs,
        } as CaptureEvent;
        session.eventCount += 1;
        session.manifest.eventCount = session.eventCount;
        session.log.append(stored);
      },
    };

    await context.exposeBinding(BINDING_NAME, (source, payload: unknown) => {
      const page = source.page;
      const pageIndex = pageIndexes.get(page);
      if (pageIndex === undefined || !isRecord(payload)) return;
      const action = payload.action;
      const selector = typeof payload.selector === "string" ? payload.selector.slice(0, 1000) : "";
      if (!selector || !isAction(action)) return;

      const event: ActionEvent = {
        kind: "action",
        action,
        selector,
        pageIndex,
        url: sanitizeUrl(page.url(), options),
        at: new Date().toISOString(),
        elapsedMs: Date.now() - session.startedMs,
      };

      if (action === "fill" || action === "select") {
        const value = typeof payload.value === "string" ? payload.value : undefined;
        const sensitive = shouldRedactInput({
          type: typeof payload.inputType === "string" ? payload.inputType : undefined,
          name: typeof payload.name === "string" ? payload.name : undefined,
          id: typeof payload.id === "string" ? payload.id : undefined,
          autocomplete: typeof payload.autocomplete === "string" ? payload.autocomplete : undefined,
          ariaLabel: typeof payload.ariaLabel === "string" ? payload.ariaLabel : undefined,
        });
        event.redacted = payload.redacted === true || sensitive || value === undefined;
        if (typeof payload.inputType === "string") event.inputType = payload.inputType.slice(0, 100);
        if (typeof payload.valueLength === "number") event.valueLength = Math.max(0, Math.min(payload.valueLength, 100_000));
        if (!event.redacted && value !== undefined) event.value = sanitizeText(value).slice(0, 4000);
      }
      session.eventCount += 1;
      session.manifest.eventCount = session.eventCount;
      session.log.append(event);
    });

    await context.addInitScript(installActionRecorder, { includeInputValues: options.includeInputValues });
    context.on("page", (page) => attachPage(session, page));
    const page = await context.newPage();
    attachPage(session, page);

    await writeManifest(directory, manifest);
    await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    if (options.captureScreenshots) {
      try {
        await page.screenshot({ path: path.join(directory, "initial.png"), timeout: 5_000 });
        manifest.screenshots.initial = "initial.png";
      } catch (error) {
        session.record({ kind: "page_error", text: `Initial screenshot failed: ${sanitizeText(errorMessage(error))}`, url: sanitizeUrl(page.url(), options), pageIndex: 0 });
      }
    }

    activeCapture = session;
    captureStarting = false;
    return session;
  } catch (error) {
    captureStarting = false;
    if (browser) await browser.close().catch(() => undefined);
    if (log) await log.close().catch(() => undefined);
    if (manifest && directory) {
      manifest.status = "failed";
      manifest.stoppedAt = new Date().toISOString();
      manifest.failure = sanitizeText(errorMessage(error));
      await writeManifest(directory, manifest).catch(() => undefined);
    }
    throw error;
  }
}

export function currentCapture(): CaptureSession | undefined {
  return activeCapture;
}

export async function finishCapture(): Promise<{
  id: string;
  status: CaptureManifest["status"];
  startedAt: string;
  stoppedAt: string;
  eventCount: number;
  directory: string;
  screenshots: CaptureManifest["screenshots"];
}> {
  const session = activeCapture;
  if (!session) throw new Error("No capture is currently running.");
  activeCapture = undefined;
  const stoppedAt = new Date().toISOString();

  try {
    const firstPage = session.pages[0];
    if (session.options.captureScreenshots && firstPage && !firstPage.isClosed()) {
      try {
        await firstPage.screenshot({ path: path.join(session.directory, "final.png"), timeout: 5_000 });
        session.manifest.screenshots.final = "final.png";
      } catch (error) {
        session.record({ kind: "page_error", text: `Final screenshot failed: ${sanitizeText(errorMessage(error))}`, url: sanitizeUrl(firstPage.url(), session.options), pageIndex: 0 });
      }
    }
    await session.browser.close();
    await session.log.close();
    session.manifest.status = "captured";
    session.manifest.stoppedAt = stoppedAt;
    session.manifest.eventCount = session.eventCount;
    await writeManifest(session.directory, session.manifest);
  } finally {
    await session.browser.close().catch(() => undefined);
  }

  return {
    id: session.id,
    status: session.manifest.status,
    startedAt: session.startedAt,
    stoppedAt,
    eventCount: session.eventCount,
    directory: session.directory,
    screenshots: session.manifest.screenshots,
  };
}

async function getGitHead(root: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, timeout: 1_000 });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function attachPage(session: CaptureSession, page: Page): void {
  if (session.pageIndexes.has(page)) return;
  const pageIndex = session.pages.length;
  session.pages.push(page);
  session.pageIndexes.set(page, pageIndex);

  page.on("console", (message) => {
    session.record({
      kind: "console",
      level: message.type(),
      text: sanitizeText(message.text()).slice(0, 4000),
      url: sanitizeUrl(page.url(), session.options),
      pageIndex,
    });
  });
  page.on("pageerror", (error) => {
    session.record({
      kind: "page_error",
      text: sanitizeText(error.stack ?? error.message).slice(0, 4000),
      url: sanitizeUrl(page.url(), session.options),
      pageIndex,
    });
  });
  page.on("request", (request) => {
    session.record({
      kind: "request",
      method: request.method(),
      url: sanitizeUrl(request.url(), session.options),
      resourceType: request.resourceType(),
      pageIndex,
    });
  });
  page.on("response", (response) => {
    const request = response.request();
    session.record({
      kind: "response",
      method: request.method(),
      url: sanitizeUrl(response.url(), session.options),
      status: response.status(),
      resourceType: request.resourceType(),
      pageIndex,
    });
  });
  page.on("requestfailed", (request) => {
    session.record({
      kind: "request_failed",
      method: request.method(),
      url: sanitizeUrl(request.url(), session.options),
      text: sanitizeText(request.failure()?.errorText ?? "Request failed").slice(0, 1000),
      pageIndex,
    });
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      session.record({ kind: "navigation", url: sanitizeUrl(frame.url(), session.options), pageIndex });
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAction(value: unknown): value is "click" | "fill" | "check" | "uncheck" | "select" {
  return value === "click" || value === "fill" || value === "check" || value === "uncheck" || value === "select";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasUrlStateRedacted(value: string, includeQueryValues: boolean): boolean {
  try {
    const url = new URL(value);
    return (!includeQueryValues && Boolean(url.search || url.hash)) ||
      [...url.searchParams.keys()].some((key) => /password|passwd|secret|token|authorization|api[_-]?key|access[_-]?key|session|cookie|credential|client[_-]?secret/i.test(key));
  } catch {
    return false;
  }
}

function installActionRecorder({ includeInputValues }: { includeInputValues: boolean }): void {
  type Binding = (event: Record<string, unknown>) => Promise<unknown>;
  const binding = (window as unknown as Record<string, unknown>)["__bugreplayRecord"] as Binding | undefined;
  const send = (event: Record<string, unknown>): void => {
    if (binding) void binding(event).catch(() => undefined);
  };

  const escapeAttribute = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\n\r]/g, " ");
  const isUnique = (selector: string): boolean => {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };
  const selectorFor = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    if (element.id) {
      const byId = `#${CSS.escape(element.id)}`;
      if (isUnique(byId)) return byId;
    }
    for (const name of ["data-testid", "data-test", "name", "aria-label"]) {
      const value = element.getAttribute(name);
      if (!value) continue;
      const candidate = `${tag}[${name}="${escapeAttribute(value)}"]`;
      if (isUnique(candidate)) return candidate;
    }

    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.documentElement) {
      const currentTag = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      if (!parent) {
        parts.unshift(currentTag);
        break;
      }
      const currentTagName = current.tagName;
      const siblings = [...parent.children].filter((child) => child.tagName === currentTagName);
      const index = siblings.indexOf(current) + 1;
      parts.unshift(siblings.length > 1 ? `${currentTag}:nth-of-type(${index})` : currentTag);
      current = parent;
      const candidate = parts.join(" > ");
      if (isUnique(candidate)) return candidate;
    }
    return parts.join(" > ") || "body";
  };
  const safeInputValue = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): {
    value?: string;
    redacted: boolean;
    valueLength: number;
    inputType: string;
    name: string;
    id: string;
    autocomplete: string;
    ariaLabel: string;
  } => {
    const inputType = element instanceof HTMLInputElement ? element.type : element instanceof HTMLSelectElement ? "select" : "textarea";
    const value = element.value;
    const sensitive = inputType === "password" || /password|passwd|secret|token|authorization|api[_-]?key|access[_-]?key|session|cookie|credential|client[_-]?secret|jwt|bearer|signature|(?:^|[_-])code(?:$|[_-])/i.test(
      `${element.name} ${element.id} ${element.autocomplete} ${element.getAttribute("aria-label") ?? ""}`,
    );
    const redacted = !includeInputValues || sensitive;
    return {
      ...(redacted ? {} : { value }),
      redacted,
      valueLength: value.length,
      inputType,
      name: element.name,
      id: element.id,
      autocomplete: element.getAttribute("autocomplete") ?? "",
      ariaLabel: element.getAttribute("aria-label") ?? "",
    };
  };

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const actionable = target.closest("button,a,[role=button],[role=link],[tabindex],label,input[type=checkbox],input[type=radio]");
    if (!actionable) return;
    const control = actionable instanceof HTMLLabelElement ? actionable.control : actionable;
    if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")) return;
    send({ action: "click", selector: selectorFor(actionable), url: location.href });
  }, true);

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      if (target.type === "file" || target.type === "hidden" || target.type === "submit" || target.type === "button") return;
      if (target.type === "checkbox" || target.type === "radio") {
        send({ action: target.checked ? "check" : "uncheck", selector: selectorFor(target), url: location.href, inputType: target.type });
        return;
      }
      send({ action: "fill", selector: selectorFor(target), url: location.href, ...safeInputValue(target) });
      return;
    }
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      send({
        action: target instanceof HTMLSelectElement ? "select" : "fill",
        selector: selectorFor(target),
        url: location.href,
        ...safeInputValue(target),
      });
    }
  }, true);
}
