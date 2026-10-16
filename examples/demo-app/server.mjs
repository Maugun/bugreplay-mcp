import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.DEMO_PORT ?? 4173);

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>BugReplay Demo</title>
    <style>
      body { max-width: 42rem; margin: 4rem auto; padding: 0 1rem; font: 16px/1.5 system-ui, sans-serif; color: #182230; }
      button { padding: .65rem 1rem; font: inherit; cursor: pointer; }
      #result { min-height: 1.5rem; padding: .75rem; background: #f1f5f9; }
    </style>
  </head>
  <body>
    <h1>BugReplay Demo</h1>
    <p>Click the button to reproduce a JavaScript error: the API returns a null name that the UI does not handle.</p>
    <button id="load-profile">Load profile</button>
    <p id="result" aria-live="polite">Waiting.</p>
    <script>
      document.querySelector("#load-profile").addEventListener("click", async () => {
        const response = await fetch("/api/profile");
        const profile = await response.json();
        // Intentional bug: name is null and does not have a toUpperCase() method.
        document.querySelector("#result").textContent = profile.name.toUpperCase();
      });
    </script>
  </body>
</html>`;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/profile") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ name: null }));
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

server.listen(port, host, () => {
  console.log(`BugReplay demo available at http://${host}:${port}`);
  console.log("Stop with Ctrl+C");
});
