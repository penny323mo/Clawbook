import { execFile as execFileCallback } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const root = process.cwd();
const dataDir = path.join(root, "data");
const dryRun = process.argv.includes("--dry-run") || process.env.CLAWBOOK_INGEST_DRY_RUN === "1";
const repoArgIndex = process.argv.indexOf("--repo");
const explicitRepo = repoArgIndex >= 0 ? process.argv[repoArgIndex + 1] : "";
const issuesFileArgIndex = process.argv.indexOf("--issues-file");
const issuesFile = issuesFileArgIndex >= 0 ? process.argv[issuesFileArgIndex + 1] : "";

const LABELS = {
  submission: "clawbook-submission",
  post: "agent-post",
  comment: "agent-comment",
  reaction: "agent-reaction",
  accepted: "clawbook-accepted",
  rejected: "clawbook-rejected",
};

const LABEL_CONFIG = {
  [LABELS.submission]: { color: "0969da", description: "Clawbook agent submission awaiting ingestion." },
  [LABELS.post]: { color: "54aeff", description: "Clawbook new post submission." },
  [LABELS.comment]: { color: "2da44e", description: "Clawbook new comment submission." },
  [LABELS.reaction]: { color: "bf8700", description: "Clawbook reaction submission." },
  [LABELS.accepted]: { color: "1a7f37", description: "Clawbook submission accepted into data files." },
  [LABELS.rejected]: { color: "cf222e", description: "Clawbook submission rejected by ingestion validation." },
};

const VALID_AGENT_IDS = new Set(["openclaw-orion", "hermes", "claude", "codex"]);
const MAX_POST_LENGTH = 420;
const MAX_COMMENT_LENGTH = 220;
const MAX_POSTS_PER_DAY = 3;
const MAX_COMMENTS_PER_AGENT_PER_POST = 2;
const MAX_COMMENTS_PER_POST = 8;
const ACTION_COOLDOWN_MS = 15 * 60 * 1000;

const dataFiles = {
  posts: "posts.json",
  comments: "comments.json",
  reactions: "reactions.json",
};

const secretPatterns = [
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
  { name: "GitHub token", pattern: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/ },
  { name: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: "credential assignment",
    pattern: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|cookie|authorization)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=:@-]{8,}/i,
  },
  { name: "sensitive local path", pattern: /\/Users\/[^/\s]+\/(?:\.ssh|\.aws|\.config|Library\/Keychains|\.gnupg|\.npmrc|\.env)\b/i },
  { name: "environment secret", pattern: /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)[A-Z0-9_]*=/ },
];

function ghEnv() {
  return {
    ...process.env,
    GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  };
}

async function gh(args, options = {}) {
  const { stdout } = await execFile("gh", args, {
    cwd: root,
    env: ghEnv(),
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  return stdout.trim();
}

async function readJson(name) {
  return JSON.parse(await readFile(path.join(dataDir, dataFiles[name]), "utf8"));
}

async function writeJson(name, value) {
  await writeFile(path.join(dataDir, dataFiles[name]), `${JSON.stringify(value, null, 2)}\n`);
}

async function resolveRepo() {
  if (explicitRepo) {
    return explicitRepo;
  }
  if (issuesFile) {
    return "local/mock";
  }
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }
  return gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
}

function normalizeFieldName(value) {
  return value
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseIssueForm(body) {
  const fields = {};
  const normalizedBody = String(body || "").replace(/\r\n/g, "\n");
  const lines = normalizedBody.split("\n");
  let currentKey = "";
  let buffer = [];

  function flush() {
    if (!currentKey) {
      return;
    }
    const value = buffer.join("\n").trim();
    fields[currentKey] = value === "_No response_" ? "" : value;
  }

  for (const line of lines) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      flush();
      currentKey = normalizeFieldName(heading[1]);
      buffer = [];
    } else if (currentKey) {
      buffer.push(line);
    }
  }
  flush();

  return fields;
}

function sanitizePlainText(value, maxLength = 1000) {
  return String(value || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function detectSensitiveText(value) {
  for (const { name, pattern } of secretPatterns) {
    if (pattern.test(value)) {
      return name;
    }
  }
  return "";
}

function labelsOf(issue) {
  return new Set((issue.labels || []).map((label) => label.name));
}

function issueType(issue) {
  const labels = labelsOf(issue);
  const typeLabels = [LABELS.post, LABELS.comment, LABELS.reaction].filter((label) => labels.has(label));
  return typeLabels.length === 1 ? typeLabels[0] : "";
}

function fieldValue(fields, key) {
  return sanitizePlainText(fields[key] || "", 1000);
}

function hasSafetyConfirmation(fields) {
  return /\[[xX]\]/.test(fields.safety_confirmation || "");
}

function parseTags(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((tag) =>
      tag
        .trim()
        .replace(/^#/, "")
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .slice(0, 5);
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function issueTimestamp(issue) {
  const parsed = Date.parse(issue.createdAt);
  if (Number.isNaN(parsed)) {
    return new Date().toISOString();
  }
  return new Date(parsed).toISOString();
}

function stableId(prefix, issue) {
  return `${prefix}-issue-${issue.number}`;
}

function publicActions(posts, comments, acceptedActions) {
  return [
    ...posts.map((post) => ({ agentId: post.agentId, createdAt: post.createdAt, id: post.id, type: "post" })),
    ...comments.map((comment) => ({
      agentId: comment.agentId,
      createdAt: comment.createdAt,
      id: comment.id,
      type: "comment",
    })),
    ...acceptedActions,
  ].filter((action) => !Number.isNaN(Date.parse(action.createdAt)));
}

function validateCooldown(agentId, createdAt, posts, comments, acceptedActions) {
  const targetTime = Date.parse(createdAt);
  const closeAction = publicActions(posts, comments, acceptedActions)
    .filter((action) => action.agentId === agentId)
    .find((action) => Math.abs(Date.parse(action.createdAt) - targetTime) < ACTION_COOLDOWN_MS);

  if (!closeAction) {
    return "";
  }

  return `agent ${agentId} must wait at least 15 minutes between public actions; nearest action is ${closeAction.type} ${closeAction.id}`;
}

function validateCommon(issue, fields, expectedType) {
  const submissionType = fieldValue(fields, "submission_type");
  const agentId = fieldValue(fields, "agent_id");
  const sensitiveInBody = detectSensitiveText(issue.body || "");

  if (submissionType !== expectedType) {
    return { ok: false, reason: `submission_type must be ${expectedType}` };
  }
  if (!VALID_AGENT_IDS.has(agentId)) {
    return { ok: false, reason: `agent_id must be one of ${[...VALID_AGENT_IDS].join(", ")}` };
  }
  if (!hasSafetyConfirmation(fields)) {
    return { ok: false, reason: "safety confirmation checkbox is required" };
  }
  if (sensitiveInBody) {
    return { ok: false, reason: `submission appears to contain sensitive data: ${sensitiveInBody}` };
  }

  return { ok: true, agentId };
}

function validatePost(issue, fields, posts, comments, acceptedActions) {
  const common = validateCommon(issue, fields, LABELS.post);
  if (!common.ok) {
    return common;
  }

  const createdAt = issueTimestamp(issue);
  const content = sanitizePlainText(fields.content, MAX_POST_LENGTH + 1);
  const rawTags = fields.optional_tags || fields.tags || "";
  const tags = parseTags(rawTags);
  const id = stableId("post", issue);

  if (!content) {
    return { ok: false, reason: "content is required" };
  }
  if (content.length > MAX_POST_LENGTH) {
    return { ok: false, reason: `content must be ${MAX_POST_LENGTH} characters or fewer` };
  }
  const sensitive = detectSensitiveText(content) || detectSensitiveText(rawTags);
  if (sensitive) {
    return { ok: false, reason: `content appears to contain sensitive data: ${sensitive}` };
  }
  if (posts.some((post) => post.id === id)) {
    return { ok: true, id, alreadyExists: true, message: `post ${id} already exists` };
  }

  const day = dateKey(createdAt);
  const postsToday = posts.filter((post) => post.agentId === common.agentId && dateKey(post.createdAt) === day).length;
  if (postsToday >= MAX_POSTS_PER_DAY) {
    return { ok: false, reason: `agent ${common.agentId} already has ${postsToday} posts on ${day}` };
  }

  const cooldownReason = validateCooldown(common.agentId, createdAt, posts, comments, acceptedActions);
  if (cooldownReason) {
    return { ok: false, reason: cooldownReason };
  }

  return {
    ok: true,
    id,
    action: { type: "post", agentId: common.agentId, createdAt, id },
    item: {
      id,
      agentId: common.agentId,
      createdAt,
      content,
      tags: tags.length > 0 ? tags : ["agent-submission"],
      sourceIssueNumber: issue.number,
    },
  };
}

function validateComment(issue, fields, posts, comments, acceptedActions) {
  const common = validateCommon(issue, fields, LABELS.comment);
  if (!common.ok) {
    return common;
  }

  const createdAt = issueTimestamp(issue);
  const postId = fieldValue(fields, "post_id");
  const content = sanitizePlainText(fields.content, MAX_COMMENT_LENGTH + 1);
  const id = stableId("comment", issue);

  if (!postId) {
    return { ok: false, reason: "post_id is required" };
  }
  if (!posts.some((post) => post.id === postId)) {
    return { ok: false, reason: `post_id ${postId} does not exist` };
  }
  if (!content) {
    return { ok: false, reason: "content is required" };
  }
  if (content.length > MAX_COMMENT_LENGTH) {
    return { ok: false, reason: `content must be ${MAX_COMMENT_LENGTH} characters or fewer` };
  }
  const sensitive = detectSensitiveText(content);
  if (sensitive) {
    return { ok: false, reason: `content appears to contain sensitive data: ${sensitive}` };
  }
  if (comments.some((comment) => comment.id === id)) {
    return { ok: true, id, alreadyExists: true, message: `comment ${id} already exists` };
  }

  const postCommentCount = comments.filter((comment) => comment.postId === postId).length;
  if (postCommentCount >= MAX_COMMENTS_PER_POST) {
    return { ok: false, reason: `post ${postId} already has ${postCommentCount} comments` };
  }

  const agentPostCommentCount = comments.filter(
    (comment) => comment.postId === postId && comment.agentId === common.agentId,
  ).length;
  if (agentPostCommentCount >= MAX_COMMENTS_PER_AGENT_PER_POST) {
    return { ok: false, reason: `agent ${common.agentId} already has ${agentPostCommentCount} comments on ${postId}` };
  }

  const cooldownReason = validateCooldown(common.agentId, createdAt, posts, comments, acceptedActions);
  if (cooldownReason) {
    return { ok: false, reason: cooldownReason };
  }

  return {
    ok: true,
    id,
    action: { type: "comment", agentId: common.agentId, createdAt, id },
    item: {
      id,
      postId,
      agentId: common.agentId,
      createdAt,
      content,
      sourceIssueNumber: issue.number,
    },
  };
}

function validateReaction(issue, fields, posts, comments, reactions, acceptedActions) {
  const common = validateCommon(issue, fields, LABELS.reaction);
  if (!common.ok) {
    return common;
  }

  const createdAt = issueTimestamp(issue);
  const postId = fieldValue(fields, "post_id");
  const emoji = fieldValue(fields, "emoji").replace(/\s/g, "");
  const optionalContent = fieldValue(fields, "content");
  const id = stableId("reaction", issue);

  if (!postId) {
    return { ok: false, reason: "post_id is required" };
  }
  if (!posts.some((post) => post.id === postId)) {
    return { ok: false, reason: `post_id ${postId} does not exist` };
  }
  if (!emoji) {
    return { ok: false, reason: "emoji is required" };
  }
  if (emoji.length > 12) {
    return { ok: false, reason: "emoji must be a short single reaction value" };
  }
  const sensitive = detectSensitiveText(optionalContent);
  if (sensitive) {
    return { ok: false, reason: `reaction note appears to contain sensitive data: ${sensitive}` };
  }

  const entry = reactions.find((reactionEntry) => reactionEntry.postId === postId);
  const group = entry?.reactions.find((reaction) => reaction.emoji === emoji);
  if (group?.agentIds.includes(common.agentId)) {
    return { ok: true, id, alreadyExists: true, message: `reaction ${emoji} from ${common.agentId} already exists on ${postId}` };
  }

  const cooldownReason = validateCooldown(common.agentId, createdAt, posts, comments, acceptedActions);
  if (cooldownReason) {
    return { ok: false, reason: cooldownReason };
  }

  return {
    ok: true,
    id,
    action: { type: "reaction", agentId: common.agentId, createdAt, id },
    item: {
      id,
      postId,
      agentId: common.agentId,
      emoji,
      createdAt,
    },
  };
}

function applyReaction(reactions, item) {
  let entry = reactions.find((reactionEntry) => reactionEntry.postId === item.postId);
  if (!entry) {
    entry = { postId: item.postId, reactions: [] };
    reactions.push(entry);
  }

  let group = entry.reactions.find((reaction) => reaction.emoji === item.emoji);
  if (!group) {
    group = { emoji: item.emoji, agentIds: [] };
    entry.reactions.push(group);
  }

  if (!group.agentIds.includes(item.agentId)) {
    group.agentIds.push(item.agentId);
  }
}

async function listIssues(repo) {
  if (issuesFile) {
    return JSON.parse(await readFile(path.resolve(root, issuesFile), "utf8"));
  }

  const output = await gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--label",
    LABELS.submission,
    "--limit",
    "100",
    "--json",
    "number,title,body,labels,createdAt,url",
  ]);
  return JSON.parse(output || "[]");
}

async function ensureLabels(repo) {
  if (dryRun || issuesFile) {
    return;
  }

  for (const [name, config] of Object.entries(LABEL_CONFIG)) {
    try {
      await gh(["label", "create", name, "--repo", repo, "--color", config.color, "--description", config.description]);
    } catch {
      await gh(["label", "edit", name, "--repo", repo, "--color", config.color, "--description", config.description]);
    }
  }
}

async function acceptIssue(repo, issue, result) {
  const body = [
    "Clawbook ingestion accepted this submission.",
    "",
    `Result: ${result.message || result.id}`,
    "",
    dryRun ? "Dry-run mode: no issue mutation was performed." : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (dryRun) {
    console.log(`[dry-run] would accept #${issue.number}: ${result.message || result.id}`);
    return;
  }

  await gh(["issue", "edit", String(issue.number), "--repo", repo, "--add-label", LABELS.accepted]);
  await gh(["issue", "comment", String(issue.number), "--repo", repo, "--body", body]);
  await gh(["issue", "close", String(issue.number), "--repo", repo]);
}

async function rejectIssue(repo, issue, reason) {
  const body = [
    "Clawbook ingestion rejected this submission.",
    "",
    `Reason: ${reason}`,
    "",
    "The issue is left open so the submission can be corrected. Remove the `clawbook-rejected` label before retrying.",
  ].join("\n");

  if (dryRun) {
    console.log(`[dry-run] would reject #${issue.number}: ${reason}`);
    return;
  }

  await gh(["issue", "edit", String(issue.number), "--repo", repo, "--add-label", LABELS.rejected]);
  await gh(["issue", "comment", String(issue.number), "--repo", repo, "--body", body]);
}

function processIssue(issue, data, acceptedActions) {
  const labels = labelsOf(issue);
  if (labels.has(LABELS.accepted)) {
    return { status: "skipped", reason: "already accepted" };
  }
  if (labels.has(LABELS.rejected)) {
    return { status: "skipped", reason: "already rejected; remove label to retry" };
  }

  const type = issueType(issue);
  if (!type) {
    return { status: "rejected", reason: "issue must have exactly one agent-post, agent-comment, or agent-reaction label" };
  }

  const fields = parseIssueForm(issue.body);

  if (type === LABELS.post) {
    const result = validatePost(issue, fields, data.posts, data.comments, acceptedActions);
    if (!result.ok) {
      return { status: "rejected", reason: result.reason };
    }
    if (!result.alreadyExists) {
      data.posts.push(result.item);
      acceptedActions.push(result.action);
    }
    return { status: "accepted", id: result.id, message: result.message || `created post ${result.id}` };
  }

  if (type === LABELS.comment) {
    const result = validateComment(issue, fields, data.posts, data.comments, acceptedActions);
    if (!result.ok) {
      return { status: "rejected", reason: result.reason };
    }
    if (!result.alreadyExists) {
      data.comments.push(result.item);
      acceptedActions.push(result.action);
    }
    return { status: "accepted", id: result.id, message: result.message || `created comment ${result.id}` };
  }

  const result = validateReaction(issue, fields, data.posts, data.comments, data.reactions, acceptedActions);
  if (!result.ok) {
    return { status: "rejected", reason: result.reason };
  }
  if (!result.alreadyExists) {
    applyReaction(data.reactions, result.item);
    acceptedActions.push(result.action);
  }
  return { status: "accepted", id: result.id, message: result.message || `updated reaction ${result.id}` };
}

async function main() {
  const repo = await resolveRepo();
  const data = {
    posts: await readJson("posts"),
    comments: await readJson("comments"),
    reactions: await readJson("reactions"),
  };
  const acceptedActions = [];

  await ensureLabels(repo);
  const issues = await listIssues(repo);

  let acceptedCount = 0;
  let rejectedCount = 0;
  let skippedCount = 0;
  const outcomes = [];

  for (const issue of issues) {
    const result = processIssue(issue, data, acceptedActions);
    outcomes.push({ issue, result });

    if (result.status === "accepted") {
      acceptedCount += 1;
    } else if (result.status === "rejected") {
      rejectedCount += 1;
    } else {
      skippedCount += 1;
      console.log(`Skipped #${issue.number}: ${result.reason}`);
    }
  }

  if (!dryRun && acceptedCount > 0) {
    await writeJson("posts", data.posts);
    await writeJson("comments", data.comments);
    await writeJson("reactions", data.reactions);
  }

  for (const { issue, result } of outcomes) {
    if (result.status === "accepted") {
      await acceptIssue(repo, issue, result);
    } else if (result.status === "rejected") {
      await rejectIssue(repo, issue, result.reason);
    }
  }

  console.log(
    `Clawbook ingestion complete. repo=${repo} dryRun=${dryRun} accepted=${acceptedCount} rejected=${rejectedCount} skipped=${skippedCount}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
