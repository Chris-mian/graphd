import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { STATE_DIR } from "./config.mjs";

export const WORKFLOW_DIR = process.env.GRAPHD_WORKFLOW_DIR ?? join(homedir(), ".claude", "workflows");
export const REJECTED_DIR = join(STATE_DIR, "rejected-workflows");

const CANDIDATE_SUFFIX = ".candidate.js";
const SCRIPT_SUFFIX = ".js";
const META_FIELD_PATTERN = /(\w+)\s*:\s*(['"`])((?:\\.|(?!\2).)*)\2/g;
const META_BLOCK_PATTERN = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/;
const PROVENANCE_PATTERN = /^\/\/\s*(.*harvested.*)$/im;

/** Pulls name, description, and whenToUse out of a workflow script's meta literal. */
export function parseWorkflowMeta(source) {
  const block = META_BLOCK_PATTERN.exec(source)?.[1] ?? "";
  const fields = {};
  for (const [, key, , value] of block.matchAll(META_FIELD_PATTERN)) {
    if (!(key in fields)) fields[key] = value;
  }
  return {
    name: fields.name ?? null,
    description: fields.description ?? null,
    whenToUse: fields.whenToUse ?? null,
    provenance: PROVENANCE_PATTERN.exec(source)?.[1] ?? null,
  };
}

function readWorkflowFile(fileName) {
  const path = join(WORKFLOW_DIR, fileName);
  const source = readFileSync(path, "utf8");
  const isCandidate = fileName.endsWith(CANDIDATE_SUFFIX);
  return {
    file: fileName,
    id: basename(fileName, isCandidate ? CANDIDATE_SUFFIX : SCRIPT_SUFFIX),
    isCandidate,
    modifiedAt: statSync(path).mtime.toISOString(),
    lineCount: source.split("\n").length,
    ...parseWorkflowMeta(source),
  };
}

/** Registered and candidate workflow scripts, each annotated with how often it has run. */
export function listWorkflows(store) {
  if (!existsSync(WORKFLOW_DIR)) return [];
  const runCounts = store
    .prepare("SELECT label, COUNT(*) AS runCount FROM nodes WHERE tool = 'Workflow' GROUP BY label")
    .all();
  const countByLabel = new Map(runCounts.map((row) => [row.label, row.runCount]));

  return readdirSync(WORKFLOW_DIR)
    .filter((fileName) => fileName.endsWith(SCRIPT_SUFFIX))
    .map((fileName) => {
      const workflow = readWorkflowFile(fileName);
      return { ...workflow, runCount: countByLabel.get(workflow.name ?? workflow.id) ?? 0 };
    })
    .sort((left, right) => Number(right.isCandidate) - Number(left.isCandidate));
}

/** Renames `<id>.candidate.js` to `<id>.js`, entering it into the by-name registry. */
export function promoteWorkflow(id) {
  const candidatePath = join(WORKFLOW_DIR, `${id}${CANDIDATE_SUFFIX}`);
  const promotedPath = join(WORKFLOW_DIR, `${id}${SCRIPT_SUFFIX}`);
  if (!existsSync(candidatePath)) throw new Error(`no candidate named ${id}`);
  if (existsSync(promotedPath)) throw new Error(`${id}.js already exists`);
  renameSync(candidatePath, promotedPath);
  return { id, path: promotedPath };
}

/** Moves a candidate out of the workflow directory. Reversible; nothing is deleted. */
export function rejectWorkflow(id) {
  const candidatePath = join(WORKFLOW_DIR, `${id}${CANDIDATE_SUFFIX}`);
  if (!existsSync(candidatePath)) throw new Error(`no candidate named ${id}`);
  if (!existsSync(REJECTED_DIR)) mkdirSync(REJECTED_DIR, { recursive: true });
  const restingPath = join(REJECTED_DIR, `${id}${CANDIDATE_SUFFIX}`);
  renameSync(candidatePath, restingPath);
  return { id, path: restingPath };
}
