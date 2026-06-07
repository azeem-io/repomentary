#!/usr/bin/env node
/**
 * History extractor (spike). Produces the JSON artifacts the sketches use.
 *
 * Reads a bare partial clone (made with `git clone --bare --filter=blob:none`)
 * and emits a compact JSON history artifact. Uses `git log --raw --no-renames`
 * ON PURPOSE: raw mode compares tree entries by SHA and never touches blob
 * content, so the blob-less clone is never tricked into lazy downloads
 * (which `--numstat` would cause).
 *
 * Usage: node extract-history.mjs <bareRepoPath> <owner/name> <out.json>
 *
 * Output shape (schema 1):
 * {
 *   schema: 1, repo, startMs, endMs,
 *   authors: string[], paths: string[],
 *   tags: [tRelSec, name][],
 *   commits: [tRelSec, authorIdx, isMerge(0|1), changes[[op, pathIdx]], totalChanges, subject][]
 * }   op: 0=added, 1=modified, 2=deleted. Subjects capped at 90 chars.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [, , repoPath, repoName, outFile] = process.argv;
if (!repoPath || !repoName || !outFile) {
  console.error("usage: node extract-history.mjs <bareRepoPath> <owner/name> <out.json>");
  process.exit(1);
}

const MAX_CHANGES_PER_COMMIT = 200;

const authors = [];
const authorIndex = new Map();
const paths = [];
const pathIndex = new Map();
const commits = [];

const internAuthor = (name) => {
  let i = authorIndex.get(name);
  if (i === undefined) {
    i = authors.length;
    authors.push(name);
    authorIndex.set(name, i);
  }
  return i;
};
const internPath = (p) => {
  let i = pathIndex.get(p);
  if (i === undefined) {
    i = paths.length;
    paths.push(p);
    pathIndex.set(p, i);
  }
  return i;
};

const git = (args) =>
  spawn("git", ["-C", repoPath, ...args], { stdio: ["ignore", "pipe", "inherit"] });

let current = null;
let firstTs = null;
let lastTs = null;
let truncated = 0;

const flush = () => {
  if (!current) return;
  commits.push([
    current.ts,
    current.author,
    current.isMerge,
    current.changes,
    current.total,
    current.subject,
  ]);
  current = null;
};

const log = git([
  "log",
  "--reverse",
  "--no-renames",
  "--raw",
  `--pretty=format:C%x09%at%x09%P%x09%aN%x09%s`,
]);

const rl = createInterface({ input: log.stdout, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (line.startsWith("C\t")) {
    flush();
    const parts = line.split("\t");
    const ts = parts[1];
    const parents = parts[2];
    const author = parts[3];
    const subject = parts.slice(4).join(" ").slice(0, 90);
    const t = Number.parseInt(ts ?? "0", 10);
    if (firstTs === null) firstTs = t;
    lastTs = Math.max(lastTs ?? t, t);
    current = {
      ts: t,
      author: internAuthor(author ?? "unknown"),
      isMerge: (parents ?? "").trim().includes(" ") ? 1 : 0,
      changes: [],
      total: 0,
      subject,
    };
  } else if (line.startsWith(":") && current) {
    // :100644 100644 abc123 def456 M\tpath/to/file
    const tab = line.indexOf("\t");
    if (tab === -1) return;
    const meta = line.slice(0, tab);
    const file = line.slice(tab + 1);
    const status = meta.charAt(meta.length - 1);
    const op = status === "A" ? 0 : status === "D" ? 2 : 1;
    current.total++;
    if (current.changes.length < MAX_CHANGES_PER_COMMIT) {
      current.changes.push([op, internPath(file)]);
    } else {
      truncated++;
    }
  }
});

await new Promise((resolve, reject) => {
  rl.on("close", resolve);
  log.on("error", reject);
});
flush();

if (firstTs === null) {
  console.error("no commits found");
  process.exit(1);
}

// Rebase times to seconds-from-start (smaller JSON).
for (const c of commits) c[0] = c[0] - firstTs;

// Tags (releases).
const tags = [];
const tagProc = git([
  "for-each-ref",
  "refs/tags",
  "--sort=creatordate",
  "--format=%(creatordate:unix)\t%(refname:short)",
]);
const tagRl = createInterface({ input: tagProc.stdout, crlfDelay: Infinity });
tagRl.on("line", (line) => {
  const [ts, name] = line.split("\t");
  const t = Number.parseInt(ts ?? "", 10);
  if (!Number.isFinite(t) || !name) return;
  if (t < firstTs || t > (lastTs ?? firstTs)) return;
  tags.push([t - firstTs, name]);
});
await new Promise((resolve) => tagRl.on("close", resolve));

const artifact = {
  schema: 1,
  repo: repoName,
  startMs: firstTs * 1000,
  endMs: (lastTs ?? firstTs) * 1000,
  authors,
  paths,
  tags,
  commits,
};

writeFileSync(outFile, JSON.stringify(artifact));
console.log(
  `${repoName}: ${commits.length} commits · ${authors.length} authors · ${paths.length} paths · ` +
    `${tags.length} tags · ${truncated} truncated changes → ${outFile}`,
);
