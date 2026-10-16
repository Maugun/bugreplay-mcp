import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { beginCapture, currentCapture, finishCapture } from "./recorder.js";
import { replayCase, verifyFix } from "./replay.js";
import { listStoredCases, readStoredCase, resolveProjectRoot } from "./storage.js";
import type { CaptureEvent } from "./types.js";

export function createServer(): McpServer {
  const server = new McpServer({ name: "bugreplay", version: "0.1.0" });

  server.registerTool(
    "start_capture",
    {
      title: "Start a local browser capture",
      description: "Open a visible Chromium window for a localhost app and record user actions, console errors, page errors, and network metadata. Input values and URL state are redacted by default.",
      inputSchema: z.object({
        url: z.string().url().describe("Absolute localhost URL of the app to reproduce the bug in."),
        includeInputValues: z.boolean().default(false).describe("Record non-sensitive form values to make the flow more replayable. Passwords and fields named like secrets remain redacted."),
        includeQueryValues: z.boolean().default(false).describe("Keep non-sensitive query and hash state in the capture. Sensitive parameter names remain redacted."),
        captureScreenshots: z.boolean().default(false).describe("Save the initial and final browser viewport as local PNG files."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => runTool(async () => {
      const session = await beginCapture(input);
      return {
        captureId: session.id,
        status: "recording",
        startUrl: session.manifest.startUrl,
        projectRoot: session.root,
        storageDirectory: session.directory,
        privacy: {
          inputValuesIncluded: input.includeInputValues,
          queryValuesIncluded: input.includeQueryValues,
          screenshotsIncluded: input.captureScreenshots,
          cookiesAndRequestBodies: "not recorded",
        },
        nextStep: "Reproduce the issue in the visible browser, then call stop_capture with this captureId.",
      };
    }),
  );

  server.registerTool(
    "stop_capture",
    {
      title: "Stop the current browser capture",
      description: "Close the capture browser and save its local event timeline.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async () => runTool(async () => finishCapture()),
  );

  server.registerTool(
    "list_cases",
    {
      title: "List captured bug cases",
      description: "List local browser captures stored under .bugreplay/cases in the configured project root.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => runTool(async () => {
      const root = await resolveProjectRoot();
      return {
        projectRoot: root,
        activeCaptureId: currentCapture()?.id,
        cases: await listStoredCases(root),
      };
    }),
  );

  server.registerTool(
    "inspect_case",
    {
      title: "Inspect a captured bug case",
      description: "Read a capture manifest and a bounded slice of its local timeline. No request bodies, cookies, or raw headers are stored.",
      inputSchema: z.object({
        caseId: z.string(),
        eventLimit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ caseId, eventLimit }) => runTool(async () => {
      const stored = await readStoredCase(await resolveProjectRoot(), caseId);
      const events = stored.events.slice(0, eventLimit);
      return {
        manifest: stored.manifest,
        storageDirectory: stored.directory,
        summary: summarizeEvents(stored.events),
        events,
        eventsReturned: events.length,
        eventsTotal: stored.events.length,
        eventsTruncated: stored.events.length > events.length,
      };
    }),
  );

  server.registerTool(
    "replay_case",
    {
      title: "Replay a local bug case",
      description: "Replay recorded browser actions against the localhost app in a clean headless Chromium session. External network requests are blocked; local actions may still change local app data.",
      inputSchema: z.object({ caseId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ caseId }) => runTool(async () => replayCase(await resolveProjectRoot(), caseId)),
  );

  server.registerTool(
    "verify_fix",
    {
      title: "Compare a replay with its captured baseline",
      description: "Replay the case after a code change and compare local browser errors with the original capture. The replay may submit the same actions to the local app again.",
      inputSchema: z.object({ caseId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ caseId }) => runTool(async () => verifyFix(await resolveProjectRoot(), caseId)),
  );

  return server;
}

export async function startServer(): Promise<void> {
  console.error("BugReplay MCP server running over stdio.");
  await serveStdio(createServer);
}

function runTool<T>(operation: () => Promise<T>) {
  return operation()
    .then((value) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }))
    .catch((error: unknown) => ({
      isError: true,
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    }));
}

function summarizeEvents(events: CaptureEvent[]) {
  return events.reduce(
    (summary, event) => {
      if (event.kind === "action") summary.actions += 1;
      if (event.kind === "console" && event.level === "error") summary.consoleErrors += 1;
      if (event.kind === "page_error") summary.pageErrors += 1;
      if (event.kind === "request_failed") summary.failedRequests += 1;
      if (event.kind === "response" && event.status >= 400) summary.httpErrors += 1;
      return summary;
    },
    { actions: 0, consoleErrors: 0, pageErrors: 0, failedRequests: 0, httpErrors: 0 },
  );
}
