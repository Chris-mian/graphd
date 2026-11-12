import { spawn } from "node:child_process";
import { createServer } from "node:http";

/**
 * Starts an HTTP server on an ephemeral port that answers each path from `routes`
 * (path -> JSON body) and records every request body it receives.
 */
export async function startFakeDaemon(routes) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({ path: request.url, body: body ? JSON.parse(body) : null });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(routes[request.url] ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Runs a command without blocking the event loop, so an in-process fake daemon can answer it.
 * spawnSync would deadlock: the child waits on the server, the server waits on the loop.
 */
export function runCommand(command, args, { env, stdin = "" }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
}
