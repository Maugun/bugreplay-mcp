export interface CaptureOptions {
  includeInputValues: boolean;
  includeQueryValues: boolean;
  captureScreenshots: boolean;
}

export interface CaptureManifest {
  schemaVersion: 1;
  id: string;
  status: "recording" | "captured" | "failed";
  startedAt: string;
  stoppedAt?: string;
  startUrl: string;
  urlStateRedacted?: boolean;
  options: CaptureOptions;
  gitHead?: string;
  eventCount?: number;
  screenshots: {
    initial?: string;
    final?: string;
  };
  failure?: string;
}

export interface ActionEvent {
  at: string;
  elapsedMs: number;
  kind: "action";
  action: "click" | "fill" | "check" | "uncheck" | "select";
  selector: string;
  pageIndex: number;
  url: string;
  value?: string;
  redacted?: boolean;
  valueLength?: number;
  inputType?: string;
}

export type CaptureEvent =
  | ActionEvent
  | {
      at: string;
      elapsedMs: number;
      kind: "console";
      level: string;
      text: string;
      url: string;
      pageIndex: number;
    }
  | {
      at: string;
      elapsedMs: number;
      kind: "page_error";
      text: string;
      url: string;
      pageIndex: number;
    }
  | {
      at: string;
      elapsedMs: number;
      kind: "request";
      method: string;
      url: string;
      resourceType: string;
      pageIndex: number;
    }
  | {
      at: string;
      elapsedMs: number;
      kind: "response";
      method: string;
      url: string;
      status: number;
      resourceType: string;
      pageIndex: number;
    }
  | {
      at: string;
      elapsedMs: number;
      kind: "request_failed";
      method: string;
      url: string;
      text: string;
      pageIndex: number;
    }
  | {
      at: string;
      elapsedMs: number;
      kind: "navigation";
      url: string;
      pageIndex: number;
    };

export type NewCaptureEvent = CaptureEvent extends infer Event
  ? Event extends CaptureEvent
    ? Omit<Event, "at" | "elapsedMs">
    : never
  : never;

export interface StoredCase {
  manifest: CaptureManifest;
  events: CaptureEvent[];
  directory: string;
}

export interface ReplayIssue {
  kind: "console" | "page_error" | "request_failed" | "http_error";
  text: string;
  url?: string;
  status?: number;
}

export interface ReplayResult {
  caseId: string;
  startedAt: string;
  finishedAt: string;
  actions: {
    recorded: number;
    completed: number;
    skipped: Array<{ actionIndex: number; reason: string }>;
    failed: Array<{ actionIndex: number; reason: string }>;
  };
  issues: ReplayIssue[];
  blockedExternalRequests: string[];
  screenshot?: string;
  complete: boolean;
}
