# BugReplay MCP

BugReplay is a local MCP server for recording and replaying a browser bug report. It opens a visible Chromium window, captures a small event timeline, and lets a coding agent inspect or replay the scenario.

## Requirements

- Node.js 24 LTS or newer
- npm 11 or newer
- A local web app listening on `localhost`, `*.localhost`, or `127.0.0.0/8`

## Install

Run these commands from this directory. npm's project cache is configured as `.npm-cache`; the browser installer stores Chromium under `.playwright-browsers`.

```powershell
npm install
npm run install-browser
npm run build
```

Start the server manually with `npm start`, or register the MCP server with an MCP-compatible AI client. The MCP process must receive `BUGREPLAY_ROOT` set to the application repository. BugReplay saves cases beneath `<BUGREPLAY_ROOT>/.bugreplay/cases/`.

## Connect an AI client to the MCP server

For Codex, merge [examples/codex-config.toml](examples/codex-config.toml) into `~/.codex/config.toml` (on Windows, `%USERPROFILE%\.codex\config.toml`). Replace the example paths with the absolute paths on your machine. Set `BUGREPLAY_ROOT` to the repository you want to debug. For the included demo, use the BugReplay project directory so captures go into its ignored `.bugreplay/cases/` folder. Restart or reload the MCP server in Codex after saving the configuration. See the [official Codex MCP guide](https://developers.openai.com/codex/extend/mcp) for other connection options.

The MCP server uses stdio. Other MCP-compatible AI clients can connect by launching `node` with the built `dist/index.js` file and passing the same environment variables.

## Try it with the included demo

The demo needs only Node.js and runs without additional dependencies. Install and build the project once if you have not already:

```powershell
npm install
npm run install-browser
npm run build
```

Start the demo app in a terminal and keep it running:

```powershell
npm run demo
```

In the AI chat where BugReplay is connected, ask:

> Use BugReplay to start a capture at `http://127.0.0.1:4173`. Open the browser and wait while I reproduce the issue.

When Chromium opens, click **Load profile**. The demo's API returns `name: null`, triggering the intentional `toUpperCase()` error. Then ask the AI:

> Stop the capture, inspect the case, and replay it.

The AI should call `stop_capture`, then use the returned case ID with `inspect_case` and `replay_case`. The replay should reproduce the same JavaScript error.

To test `verify_fix`, replace `profile.name.toUpperCase()` in `examples/demo-app/server.mjs` with `(profile.name ?? "Guest").toUpperCase()`, then restart `npm run demo` so the server serves the updated page. Ask the AI:

> Run `verify_fix` for capture ID `<case-id>`.

It should replay the original click and report that the captured error is gone. To create another buggy baseline, change the expression back to `profile.name.toUpperCase()`, restart the demo, and capture the scenario again.

## MCP tools

1. `start_capture` opens the app in a visible browser and begins recording. The tool returns a capture ID.
2. Reproduce the issue in that browser.
3. `stop_capture` closes the browser and finalizes the case.
4. `list_cases` and `inspect_case` return saved timelines and issue summaries.
5. `replay_case` runs the captured actions in a clean, headless browser.
6. `verify_fix` replays the actions after a code change and compares browser issues with the original capture.

Replaying repeats the recorded actions against the local app. It can create or update data in that app, so use a development environment with disposable data.

## Privacy and scope

- Captures are local JSON and optional PNG files under `.bugreplay/cases/`.
- Input values, query values, hash state, and screenshots are excluded by default. You can opt into non-sensitive form and URL values for an individual capture. Fields and URL parameters that look like passwords, tokens, credentials, JWTs, authorization codes, signatures, or API keys remain redacted.
- Cookies, request headers, and request or response bodies are never recorded.
- Capture and replay only accept loopback application URLs. Replay blocks requests to non-loopback hosts.
- During capture, the app itself can still send requests to remote APIs. Use a development backend with disposable data when reproducing flows that submit or update information.
- Login state is held in the temporary capture browser only; cookies and local storage are not copied into the replay. Authenticated flows may need a separate test setup.
- Replaying relies on CSS selectors observed during capture. A page redesign, iframes, or custom controls can make a step fail; the tool reports skipped or failed steps.

## Storage layout

Each case contains `case.json`, an `events.jsonl` timeline, and optional `initial.png` / `final.png` screenshots. Replay screenshots, when enabled, are stored beside the case. The `.bugreplay/cases/` directory is ignored by this repository's Git configuration.

If `BUGREPLAY_ROOT` points at another repository, add `.bugreplay/cases/` to that repository's `.gitignore` if you do not want local capture data included in Git.
