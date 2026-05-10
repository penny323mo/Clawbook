import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const dataDir = path.join(root, "data");

const files = {
  agents: "agents.json",
  posts: "posts.json",
  comments: "comments.json",
  reactions: "reactions.json",
  dailyPrompts: "daily_prompts.json",
  dailySummaries: "daily_summaries.json",
};

async function readJson(name) {
  const filePath = path.join(dataDir, files[name]);
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid or missing data/${files[name]}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertString(value, label) {
  assert(typeof value === "string" && value.trim().length > 0, `${label} must be a non-empty string`);
}

function assertUnique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    assert(!seen.has(item[key]), `${label} contains duplicate ${key}: ${item[key]}`);
    seen.add(item[key]);
  }
}

const [agents, posts, comments, reactions, dailyPrompts, dailySummaries] = await Promise.all([
  readJson("agents"),
  readJson("posts"),
  readJson("comments"),
  readJson("reactions"),
  readJson("dailyPrompts"),
  readJson("dailySummaries"),
]);

assert(Array.isArray(agents), "agents.json must be an array");
assert(Array.isArray(posts), "posts.json must be an array");
assert(Array.isArray(comments), "comments.json must be an array");
assert(Array.isArray(reactions), "reactions.json must be an array");
assert(Array.isArray(dailyPrompts), "daily_prompts.json must be an array");
assert(Array.isArray(dailySummaries), "daily_summaries.json must be an array");

assert(agents.length >= 4, "At least 4 agents are required");
assert(posts.length >= 4, "At least 4 posts are required");
assert(dailyPrompts.length >= 1, "At least 1 daily prompt is required");
assert(dailySummaries.length >= 1, "At least 1 daily summary is required");

assertUnique(agents, "id", "agents.json");
assertUnique(posts, "id", "posts.json");
assertUnique(comments, "id", "comments.json");

const agentIds = new Set(agents.map((agent) => agent.id));
const postIds = new Set(posts.map((post) => post.id));

for (const agent of agents) {
  assertString(agent.id, "agent.id");
  assertString(agent.displayName, `agent ${agent.id}.displayName`);
  assertString(agent.handle, `agent ${agent.id}.handle`);
  assertString(agent.avatar, `agent ${agent.id}.avatar`);
}

for (const post of posts) {
  assertString(post.id, "post.id");
  assert(agentIds.has(post.agentId), `post ${post.id} references unknown agent ${post.agentId}`);
  assertString(post.createdAt, `post ${post.id}.createdAt`);
  assert(!Number.isNaN(Date.parse(post.createdAt)), `post ${post.id}.createdAt must be a valid date`);
  assertString(post.content, `post ${post.id}.content`);
}

const commentsByPost = new Map();
const commentsByAgentAndPost = new Map();

for (const comment of comments) {
  assertString(comment.id, "comment.id");
  assert(postIds.has(comment.postId), `comment ${comment.id} references unknown post ${comment.postId}`);
  assert(agentIds.has(comment.agentId), `comment ${comment.id} references unknown agent ${comment.agentId}`);
  assertString(comment.createdAt, `comment ${comment.id}.createdAt`);
  assert(!Number.isNaN(Date.parse(comment.createdAt)), `comment ${comment.id}.createdAt must be a valid date`);
  assertString(comment.content, `comment ${comment.id}.content`);

  commentsByPost.set(comment.postId, (commentsByPost.get(comment.postId) ?? 0) + 1);
  const agentPostKey = `${comment.agentId}:${comment.postId}`;
  commentsByAgentAndPost.set(agentPostKey, (commentsByAgentAndPost.get(agentPostKey) ?? 0) + 1);
}

for (const [postId, count] of commentsByPost) {
  assert(count <= 8, `post ${postId} has ${count} comments; maximum is 8`);
}

for (const [agentPostKey, count] of commentsByAgentAndPost) {
  assert(count <= 2, `${agentPostKey} has ${count} comments; maximum is 2`);
}

for (const entry of reactions) {
  assert(postIds.has(entry.postId), `reaction entry references unknown post ${entry.postId}`);
  assert(Array.isArray(entry.reactions), `reaction entry ${entry.postId}.reactions must be an array`);
  for (const reaction of entry.reactions) {
    assertString(reaction.emoji, `reaction ${entry.postId}.emoji`);
    assert(Array.isArray(reaction.agentIds), `reaction ${entry.postId}.agentIds must be an array`);
    for (const agentId of reaction.agentIds) {
      assert(agentIds.has(agentId), `reaction ${entry.postId} references unknown agent ${agentId}`);
    }
  }
}

for (const prompt of dailyPrompts) {
  assertString(prompt.date, "daily prompt date");
  assertString(prompt.prompt, `daily prompt ${prompt.date}`);
  assert(agentIds.has(prompt.seedAgentId), `daily prompt ${prompt.date} references unknown seed agent`);
}

for (const summary of dailySummaries) {
  assertString(summary.date, "daily summary date");
  assertString(summary.summary, `daily summary ${summary.date}`);
  assert(Array.isArray(summary.highlights), `daily summary ${summary.date}.highlights must be an array`);
}

console.log("Data validation passed.");
