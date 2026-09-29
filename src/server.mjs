import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KILL_SWITCH_PATH,
  loadConfig,
  readOrCreateToken,
  isEnforcementEnabled,
  saveConfig,
  setPaused,
} from "./config.mjs";
import { existsSync } from "node:fs";
import { openStore } from "./db.mjs";
import { listWorkflows, promoteWorkflow, rejectWorkflow } from "./library.mjs";
import { runDiagnostics } from "./doctor.mjs";
import { computeStats } from "./stats.mjs";
import { computeEvaluation } from "./evaluation.mjs";
import { computeLessons } from "./lessons.mjs";
import { acceptRule, acceptedRulesBlock, readAcceptedRules } from "./accepted.mjs";
import { addProposals, decideProposal, readProposals } from "./proposals.mjs";
import {
  AMBIGUOUS_RUN_ID,
  getRun,
  handleEvent,
  handlePolicyCheck,
  isTokenValid,
  listEvents,
  listPolicyChecks,
  listResumptions,
  listRuns,
} from "./routes.mjs";

const UI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "index.html");

const MAX_BODY_BYTES = 1_048_576;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_SERVER_ERROR = 500;
const BEARER_PREFIX = "Bearer ";

function sendJson(response, statusCode, payload) {
  const serialized = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(serialized),
  });
  response.end(serialized);
}

async function readJsonBody(request) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    byteLength += chunk.length;
    if (byteLength > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function extractBearerToken(request) {
  const header = request.headers.authorization ?? "";
  return header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : "";
}

function parseIntegerParam(url, name, fallback) {
  const raw = url.searchParams.get(name);
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function routeGet(store, config, url) {
  if (url.pathname === "/v1/health") {
    return { ok: true, isEnforcing: isEnforcementEnabled(config) };
  }
  if (url.pathname === "/v1/runs") {
    return { runs: listRuns(store, parseIntegerParam(url, "limit", undefined)) };
  }
  if (url.pathname.startsWith("/v1/runs/")) {
    return getRun(store, decodeURIComponent(url.pathname.slice("/v1/runs/".length)));
  }
  if (url.pathname === "/v1/policy/checks") {
    return { checks: listPolicyChecks(store, parseIntegerParam(url, "limit", undefined)) };
  }
  if (url.pathname === "/v1/events") {
    return { events: listEvents(store, parseIntegerParam(url, "limit", undefined)) };
  }
  if (url.pathname === "/v1/evaluation") {
    return { evaluation: computeEvaluation(store) };
  }
  if (url.pathname === "/v1/resumptions") {
    return { resumptions: listResumptions(store, parseIntegerParam(url, "limit", undefined)) };
  }
  if (url.pathname === "/v1/config") {
    return { config, isPaused: existsSync(KILL_SWITCH_PATH), isEnforcing: isEnforcementEnabled(config) };
  }
  if (url.pathname === "/v1/workflows") {
    return { workflows: listWorkflows(store) };
  }
  if (url.pathname === "/v1/stats") {
    return { stats: computeStats(store) };
  }
  if (url.pathname === "/v1/lessons") {
    return { lessons: computeLessons(store) };
  }
  if (url.pathname === "/v1/lessons/accepted") {
    return { rules: readAcceptedRules(), block: acceptedRulesBlock() };
  }
  if (url.pathname === "/v1/proposals") {
    return { proposals: readProposals() };
  }
  if (url.pathname === "/v1/doctor") {
    return { checks: runDiagnostics(store) };
  }
  return null;
}

async function routePost(store, config, url, request) {
  const body = await readJsonBody(request);
  if (url.pathname === "/v1/events") return handleEvent(store, config, body);
  if (url.pathname === "/v1/policy/check") return handlePolicyCheck(store, config, body);
  if (url.pathname === "/v1/topology") {
    return handleEvent(store, config, { ...body, kind: "topology" });
  }
  if (url.pathname === "/v1/lessons/accept") return acceptRule(body.rule);
  if (url.pathname === "/v1/proposals/decide") return decideProposal(body.id, body.status);
  if (url.pathname === "/v1/proposals") return addProposals(body.proposals ?? []);
  if (url.pathname === "/v1/workflows/promote") return promoteWorkflow(body.id);
  if (url.pathname === "/v1/workflows/reject") return rejectWorkflow(body.id);
  if (url.pathname === "/v1/config") {
    const saved = typeof body.enforce === "boolean" ? saveConfig({ enforce: body.enforce }) : config;
    const isPaused = typeof body.isPaused === "boolean" ? setPaused(body.isPaused) : existsSync(KILL_SWITCH_PATH);
    return { config: saved, isPaused, isEnforcing: isEnforcementEnabled(saved) };
  }
  return null;
}

function serveUi(response) {
  const html = readFileSync(UI_PATH);
  response.writeHead(HTTP_OK, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

async function dispatch(store, url, request, response) {
  const config = loadConfig();
  const result =
    request.method === "GET"
      ? routeGet(store, config, url)
      : await routePost(store, config, url, request);
  if (result === null || result === undefined) {
    sendJson(response, HTTP_NOT_FOUND, { error: "not found" });
    return;
  }
  if (result.error === AMBIGUOUS_RUN_ID) {
    sendJson(response, HTTP_CONFLICT, result);
    return;
  }
  sendJson(response, HTTP_OK, result);
}

/** Starts the daemon. Config is re-read per request so edits take effect without a restart. */
export function startServer() {
  const store = openStore();
  const token = readOrCreateToken();
  const { bind, port } = loadConfig();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      serveUi(response);
      return;
    }
    if (!isTokenValid(extractBearerToken(request), token)) {
      sendJson(response, HTTP_UNAUTHORIZED, { error: "bad token" });
      return;
    }
    try {
      await dispatch(store, url, request, response);
    } catch (error) {
      const isTooLarge = error instanceof Error && error.message === "body too large";
      const isBadJson = error instanceof SyntaxError;
      const status = isTooLarge
        ? HTTP_PAYLOAD_TOO_LARGE
        : isBadJson
          ? HTTP_BAD_REQUEST
          : HTTP_SERVER_ERROR;
      sendJson(response, status, { error: String(error) });
    }
  });

  server.listen(port, bind, () => {
    process.stdout.write(`graphd listening on http://${bind}:${port}\n`);
  });
  return server;
}
