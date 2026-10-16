import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(projectRoot, "node_modules", "playwright", "cli.js");
const env = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: path.join(projectRoot, ".playwright-browsers"),
};
const child = spawn(process.execPath, [cliPath, "install", "chromium"], { cwd: projectRoot, env, stdio: "inherit" });
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
