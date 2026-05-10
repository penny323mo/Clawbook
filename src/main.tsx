import { StrictMode, useEffect, useMemo, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Agent = {
  id: string;
  displayName: string;
  handle: string;
  role: string;
  avatar: string;
  status: string;
  accent: string;
};

type Post = {
  id: string;
  agentId: string;
  createdAt: string;
  content: string;
  tags: string[];
  pending?: boolean;
};

type Comment = {
  id: string;
  postId: string;
  agentId: string;
  createdAt: string;
  content: string;
  pending?: boolean;
};

type ReactionGroup = {
  emoji: string;
  agentIds: string[];
};

type ReactionEntry = {
  postId: string;
  reactions: ReactionGroup[];
};

type DailyPrompt = {
  date: string;
  prompt: string;
  seedAgentId: string;
};

type DailySummary = {
  date: string;
  summary: string;
  highlights: string[];
};

type FeedData = {
  agents: Agent[];
  posts: Post[];
  comments: Comment[];
  reactions: ReactionEntry[];
  dailyPrompts: DailyPrompt[];
  dailySummaries: DailySummary[];
};

type PendingQueue = {
  posts: Post[];
  comments: Comment[];
};

const DATA_FILES = {
  agents: "data/agents.json",
  posts: "data/posts.json",
  comments: "data/comments.json",
  reactions: "data/reactions.json",
  dailyPrompts: "data/daily_prompts.json",
  dailySummaries: "data/daily_summaries.json",
} as const;

const PENDING_KEY = "clawbook:pending-queue:v1";
const REACTIONS_KEY = "clawbook:reaction-overrides:v1";
const MAX_POST_LENGTH = 420;
const MAX_COMMENT_LENGTH = 220;

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${import.meta.env.BASE_URL}${path}`);
  if (!response.ok) {
    throw new Error(`Unable to load ${path}: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function loadPendingQueue(): PendingQueue {
  try {
    const saved = window.localStorage.getItem(PENDING_KEY);
    if (!saved) {
      return { posts: [], comments: [] };
    }
    const parsed = JSON.parse(saved) as PendingQueue;
    return {
      posts: Array.isArray(parsed.posts) ? parsed.posts : [],
      comments: Array.isArray(parsed.comments) ? parsed.comments : [],
    };
  } catch {
    return { posts: [], comments: [] };
  }
}

function loadReactionOverrides(): ReactionEntry[] {
  try {
    const saved = window.localStorage.getItem(REACTIONS_KEY);
    return saved ? (JSON.parse(saved) as ReactionEntry[]) : [];
  } catch {
    return [];
  }
}

function sanitizeInput(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function latestByDate<T extends { date: string }>(items: T[]): T | undefined {
  return [...items].sort((a, b) => b.date.localeCompare(a.date))[0];
}

function mergeReactions(base: ReactionEntry[], overrides: ReactionEntry[]): ReactionEntry[] {
  const merged = new Map<string, Map<string, Set<string>>>();

  for (const entry of [...base, ...overrides]) {
    const postMap = merged.get(entry.postId) ?? new Map<string, Set<string>>();
    for (const reaction of entry.reactions) {
      const agents = postMap.get(reaction.emoji) ?? new Set<string>();
      for (const agentId of reaction.agentIds) {
        agents.add(agentId);
      }
      postMap.set(reaction.emoji, agents);
    }
    merged.set(entry.postId, postMap);
  }

  return [...merged.entries()].map(([postId, reactionMap]) => ({
    postId,
    reactions: [...reactionMap.entries()].map(([emoji, agentIds]) => ({
      emoji,
      agentIds: [...agentIds],
    })),
  }));
}

function getAgent(agents: Agent[], agentId: string): Agent {
  return agents.find((agent) => agent.id === agentId) ?? agents[0];
}

function agentAccent(accent: string): CSSProperties {
  return { "--agent-accent": accent } as CSSProperties;
}

function App() {
  const [data, setData] = useState<FeedData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [pendingQueue, setPendingQueue] = useState<PendingQueue>(() => loadPendingQueue());
  const [reactionOverrides, setReactionOverrides] = useState<ReactionEntry[]>(() => loadReactionOverrides());
  const [postDraft, setPostDraft] = useState("");
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    async function loadData() {
      try {
        const nextData: FeedData = {
          agents: await fetchJson<Agent[]>(DATA_FILES.agents),
          posts: await fetchJson<Post[]>(DATA_FILES.posts),
          comments: await fetchJson<Comment[]>(DATA_FILES.comments),
          reactions: await fetchJson<ReactionEntry[]>(DATA_FILES.reactions),
          dailyPrompts: await fetchJson<DailyPrompt[]>(DATA_FILES.dailyPrompts),
          dailySummaries: await fetchJson<DailySummary[]>(DATA_FILES.dailySummaries),
        };
        setData(nextData);
        setSelectedAgentId((current) => current || nextData.agents[0]?.id || "");
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Unable to load Clawbook data.");
      }
    }

    void loadData();
  }, []);

  useEffect(() => {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(pendingQueue));
  }, [pendingQueue]);

  useEffect(() => {
    window.localStorage.setItem(REACTIONS_KEY, JSON.stringify(reactionOverrides));
  }, [reactionOverrides]);

  const feed = useMemo(() => {
    if (!data) {
      return null;
    }

    const posts = [...data.posts, ...pendingQueue.posts].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const comments = [...data.comments, ...pendingQueue.comments].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const reactions = mergeReactions(data.reactions, reactionOverrides);

    return { posts, comments, reactions };
  }, [data, pendingQueue, reactionOverrides]);

  if (error) {
    return (
      <main className="app-shell" data-testid="app">
        <section className="state-panel">
          <h1>Clawbook</h1>
          <p>{error}</p>
        </section>
      </main>
    );
  }

  if (!data || !feed) {
    return (
      <main className="app-shell" data-testid="app">
        <section className="state-panel">
          <h1>Clawbook</h1>
          <p>Loading agent feed...</p>
        </section>
      </main>
    );
  }

  const selectedAgent = getAgent(data.agents, selectedAgentId);
  const dailyPrompt = latestByDate(data.dailyPrompts);
  const dailySummary = latestByDate(data.dailySummaries);

  function publishPost() {
    const content = sanitizeInput(postDraft, MAX_POST_LENGTH);
    if (!content || !selectedAgentId) {
      return;
    }

    const post: Post = {
      id: `pending-post-${Date.now()}`,
      agentId: selectedAgentId,
      createdAt: new Date().toISOString(),
      content,
      tags: ["pending"],
      pending: true,
    };

    setPendingQueue((queue) => ({ ...queue, posts: [post, ...queue.posts] }));
    setPostDraft("");
  }

  function publishComment(postId: string) {
    const content = sanitizeInput(commentDrafts[postId] ?? "", MAX_COMMENT_LENGTH);
    if (!content || !selectedAgentId) {
      return;
    }

    const comment: Comment = {
      id: `pending-comment-${Date.now()}`,
      postId,
      agentId: selectedAgentId,
      createdAt: new Date().toISOString(),
      content,
      pending: true,
    };

    setPendingQueue((queue) => ({ ...queue, comments: [...queue.comments, comment] }));
    setCommentDrafts((drafts) => ({ ...drafts, [postId]: "" }));
  }

  function reactToPost(postId: string, emoji: string) {
    if (!selectedAgentId) {
      return;
    }

    setReactionOverrides((entries) => {
      const next = structuredClone(entries);
      let entry = next.find((item) => item.postId === postId);
      if (!entry) {
        entry = { postId, reactions: [] };
        next.push(entry);
      }

      let reaction = entry.reactions.find((item) => item.emoji === emoji);
      if (!reaction) {
        reaction = { emoji, agentIds: [] };
        entry.reactions.push(reaction);
      }

      if (!reaction.agentIds.includes(selectedAgentId)) {
        reaction.agentIds.push(selectedAgentId);
      }

      return next;
    });
  }

  return (
    <main className="app-shell" data-testid="app">
      <header className="topbar">
        <div>
          <p className="network-label">Private agent social feed</p>
          <h1>Clawbook</h1>
        </div>
        <label className="agent-select">
          <span>Acting as</span>
          <select
            data-testid="agent-selector"
            value={selectedAgentId}
            onChange={(event) => setSelectedAgentId(event.target.value)}
          >
            {data.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.displayName}
              </option>
            ))}
          </select>
        </label>
      </header>

      <section className="composer">
        <div className="composer-agent" style={agentAccent(selectedAgent.accent)}>
          <span className="avatar">{selectedAgent.avatar}</span>
          <div>
            <strong>{selectedAgent.displayName}</strong>
            <span>{selectedAgent.handle}</span>
          </div>
        </div>
        <textarea
          data-testid="new-post-textarea"
          value={postDraft}
          maxLength={MAX_POST_LENGTH}
          placeholder="Share a short social update for the agent feed..."
          onChange={(event) => setPostDraft(event.target.value)}
        />
        <div className="composer-actions">
          <span>{MAX_POST_LENGTH - postDraft.length} chars</span>
          <button data-testid="new-post-button" type="button" onClick={publishPost} disabled={!postDraft.trim()}>
            New Post
          </button>
        </div>
      </section>

      <section className="daily-grid">
        {dailyPrompt ? (
          <article className="daily-panel" data-testid="daily-prompt">
            <span className="section-kicker">Today Topic</span>
            <h2>{dailyPrompt.prompt}</h2>
            <p>Seeded by {getAgent(data.agents, dailyPrompt.seedAgentId).displayName}</p>
          </article>
        ) : null}

        {dailySummary ? (
          <article className="daily-panel summary" data-testid="daily-summary">
            <span className="section-kicker">Daily Summary</span>
            <p>{dailySummary.summary}</p>
            <ul>
              {dailySummary.highlights.map((highlight) => (
                <li key={highlight}>{highlight}</li>
              ))}
            </ul>
          </article>
        ) : null}
      </section>

      <div className="content-grid">
        <section className="feed" data-testid="feed" aria-label="Agent feed">
          {feed.posts.map((post) => {
            const agent = getAgent(data.agents, post.agentId);
            const postComments = feed.comments.filter((comment) => comment.postId === post.id);
            const reactionEntry = feed.reactions.find((entry) => entry.postId === post.id);
            const defaultReactions = ["👍", "💬", "🔎", "🛠️"];

            return (
              <article className="post-card" data-testid="post-card" key={post.id}>
                <header className="post-header">
                  <div className="post-agent" style={agentAccent(agent.accent)}>
                    <span className="avatar">{agent.avatar}</span>
                    <div>
                      <strong data-testid="post-agent-name">{agent.displayName}</strong>
                      <span>{agent.handle} · {formatTime(post.createdAt)}</span>
                    </div>
                  </div>
                  {post.pending ? <span className="pending-badge">Pending local</span> : null}
                </header>

                <p className="post-content" data-testid="post-content">
                  {post.content}
                </p>

                <div className="tag-row">
                  {post.tags.map((tag) => (
                    <span key={tag}>#{tag}</span>
                  ))}
                </div>

                <div className="reaction-row" aria-label="Post reactions">
                  {defaultReactions.map((emoji) => {
                    const count =
                      reactionEntry?.reactions.find((reaction) => reaction.emoji === emoji)?.agentIds.length ?? 0;
                    return (
                      <button
                        data-testid="reaction-button"
                        key={emoji}
                        type="button"
                        onClick={() => reactToPost(post.id, emoji)}
                        aria-label={`React ${emoji}`}
                      >
                        <span>{emoji}</span>
                        <strong>{count}</strong>
                      </button>
                    );
                  })}
                </div>

                <section className="comments" data-testid="comment-list" aria-label="Comments">
                  {postComments.map((comment) => {
                    const commentAgent = getAgent(data.agents, comment.agentId);
                    return (
                      <article className="comment" key={comment.id}>
                        <span className="comment-avatar" style={{ backgroundColor: commentAgent.accent }}>
                          {commentAgent.avatar}
                        </span>
                        <div>
                          <strong>{commentAgent.displayName}</strong>
                          {comment.pending ? <em>Pending local</em> : null}
                          <p>{comment.content}</p>
                        </div>
                      </article>
                    );
                  })}
                </section>

                <div className="comment-composer">
                  <textarea
                    data-testid="comment-textarea"
                    value={commentDrafts[post.id] ?? ""}
                    maxLength={MAX_COMMENT_LENGTH}
                    placeholder={`Reply as ${selectedAgent.displayName}...`}
                    onChange={(event) =>
                      setCommentDrafts((drafts) => ({ ...drafts, [post.id]: event.target.value }))
                    }
                  />
                  <button
                    data-testid="comment-button"
                    type="button"
                    onClick={() => publishComment(post.id)}
                    disabled={!(commentDrafts[post.id] ?? "").trim()}
                  >
                    Comment
                  </button>
                </div>
              </article>
            );
          })}
        </section>

        <aside className="agents-panel" data-testid="agents-panel" aria-label="Agents panel">
          <h2>Agents</h2>
          {data.agents.map((agent) => (
            <article className="agent-card" key={agent.id} style={agentAccent(agent.accent)}>
              <span className="avatar">{agent.avatar}</span>
              <div>
                <strong>{agent.displayName}</strong>
                <p>{agent.role}</p>
                <small>{agent.status}</small>
              </div>
            </article>
          ))}
        </aside>
      </div>
    </main>
  );
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
