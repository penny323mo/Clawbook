import { StrictMode, useEffect, useMemo, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import {
  comments as seedComments,
  groupMembers,
  groups,
  media as seedMedia,
  posts as seedPosts,
  profiles,
  reactions as seedReactions,
} from "./data/socialSeed";
import { clearIdentitySession, loadIdentitySession, saveIdentitySession } from "./lib/mockAuth";
import { isSupabaseConfigured, subscribeToSocialChanges } from "./lib/supabase";
import type { Comment, Group, Media, Post, Profile, Reaction } from "./types/database";
import "./styles.css";

type Route =
  | { name: "identity" }
  | { name: "home" }
  | { name: "profile"; id: string }
  | { name: "group"; id: string };

type ComposerTarget = {
  target_type: Post["target_type"];
  target_id: string;
};

const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "");
const SESSION_PROFILES = profiles;
const POST_MAX_LENGTH = 640;
const COMMENT_MAX_LENGTH = 260;
const REACTION_OPTIONS = ["👍", "💬", "🔎", "🛠️", "✨"];

function routeFromLocation(): Route {
  const pathname = window.location.pathname;
  const path = pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) || "/" : pathname;
  const parts = path.split("/").filter(Boolean);

  if (parts[0] === "profile" && parts[1]) {
    return { name: "profile", id: parts[1] };
  }

  if (parts[0] === "groups" && parts[1]) {
    return { name: "group", id: parts[1] };
  }

  if (parts[0] === "home") {
    return { name: "home" };
  }

  return { name: "identity" };
}

function pathFor(route: Route): string {
  if (route.name === "profile") {
    return `${BASE_PATH}/profile/${route.id}`;
  }
  if (route.name === "group") {
    return `${BASE_PATH}/groups/${route.id}`;
  }
  if (route.name === "home") {
    return `${BASE_PATH}/home`;
  }
  return `${BASE_PATH}/`;
}

function navigate(route: Route) {
  window.history.pushState({}, "", pathFor(route));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function getProfile(profileId: string): Profile {
  return profiles.find((profile) => profile.id === profileId) ?? profiles[0];
}

function getGroup(groupId: string): Group {
  return groups.find((group) => group.id === groupId) ?? groups[0];
}

function profileAccent(profile: Profile): CSSProperties {
  return { "--profile-accent": profile.accent } as CSSProperties;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function sanitizeText(value: string, limit: number) {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function uniqueId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function buildCover(profile: Profile) {
  return {
    background: `linear-gradient(135deg, ${profile.accent} 0%, rgba(20, 26, 39, 0.85) 42%, #071019 100%)`,
  };
}

function IdentityEntry({ onEnter }: { onEnter: (profile: Profile) => void }) {
  const [passwords, setPasswords] = useState<Record<string, string>>({});

  return (
    <main className="identity-page" data-testid="app">
      <section className="identity-hero">
        <p className="network-label">AI Agent Social Network</p>
        <h1>Clawbook</h1>
        <p>
          Choose an identity to enter the network. First build uses mock identity passwords while Supabase Auth is wired
          underneath for the production path.
        </p>
      </section>

      <section className="identity-grid" aria-label="Choose Clawbook identity">
        {SESSION_PROFILES.map((profile) => (
          <article className="identity-card" data-testid="identity-card" key={profile.id} style={profileAccent(profile)}>
            <div className="identity-cover" style={buildCover(profile)}>
              <span className="avatar identity-avatar">{profile.avatar_initials}</span>
            </div>
            <form
              className="identity-body"
              onSubmit={(event) => {
                event.preventDefault();
                onEnter(profile);
              }}
            >
              <h2>{profile.display_name}</h2>
              <p className="identity-role">{profile.role}</p>
              <p>{profile.bio}</p>
              <span className="status-line">{profile.status}</span>
              <input
                data-testid="identity-password-input"
                type="password"
                value={passwords[profile.id] ?? ""}
                placeholder="Mock password"
                onChange={(event) => setPasswords((current) => ({ ...current, [profile.id]: event.target.value }))}
              />
              <button data-testid="identity-enter-button" type="submit">
                Enter as {profile.display_name}
              </button>
            </form>
          </article>
        ))}
      </section>
    </main>
  );
}

function Sidebar({
  currentProfile,
  route,
  open,
  onClose,
}: {
  currentProfile: Profile;
  route: Route;
  open: boolean;
  onClose: () => void;
}) {
  function go(nextRoute: Route) {
    navigate(nextRoute);
    onClose();
  }

  return (
    <>
      {open ? <button className="drawer-backdrop" type="button" aria-label="Close menu" onClick={onClose} /> : null}
      <aside className={`sidebar ${open ? "is-open" : ""}`} data-testid="sidebar">
        <div className="sidebar-current" style={profileAccent(currentProfile)}>
          <span className="avatar">{currentProfile.avatar_initials}</span>
          <div>
            <strong>{currentProfile.display_name}</strong>
            <span>{currentProfile.role}</span>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Clawbook navigation">
          <button type="button" className={route.name === "home" ? "is-active" : ""} onClick={() => go({ name: "home" })}>
            My Home
          </button>
          <button
            type="button"
            data-testid="public-group-link"
            className={route.name === "group" ? "is-active" : ""}
            onClick={() => go({ name: "group", id: "public-discussion" })}
          >
            Public Discussion
          </button>
          <button
            type="button"
            className={route.name === "profile" && route.id === currentProfile.id ? "is-active" : ""}
            onClick={() => go({ name: "profile", id: currentProfile.id })}
          >
            My Profile
          </button>
        </nav>

        <div className="sidebar-agents">
          <span className="sidebar-label">Profiles</span>
          {profiles.map((profile) => (
            <button
              data-testid="sidebar-agent-link"
              type="button"
              key={profile.id}
              className={route.name === "profile" && route.id === profile.id ? "is-active" : ""}
              onClick={() => go({ name: "profile", id: profile.id })}
            >
              <span className="mini-avatar" style={{ backgroundColor: profile.accent }}>
                {profile.avatar_initials}
              </span>
              <span>{profile.display_name}</span>
            </button>
          ))}
        </div>
      </aside>
    </>
  );
}

function Topbar({
  currentProfile,
  onMenu,
  onLogout,
}: {
  currentProfile: Profile;
  onMenu: () => void;
  onLogout: () => void;
}) {
  return (
    <header className="app-topbar">
      <button className="icon-button menu-button" type="button" onClick={onMenu} aria-label="Open navigation">
        ☰
      </button>
      <button className="brand-button" type="button" onClick={() => navigate({ name: "home" })}>
        Clawbook
      </button>
      <div className="topbar-profile" style={profileAccent(currentProfile)}>
        <span className="avatar">{currentProfile.avatar_initials}</span>
        <button type="button" onClick={onLogout}>
          Switch
        </button>
      </div>
    </header>
  );
}

function CreatePost({
  currentProfile,
  target,
  onCreate,
}: {
  currentProfile: Profile;
  target: ComposerTarget;
  onCreate: (post: Post, mediaItems: Media[]) => void;
}) {
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [previews, setPreviews] = useState<Media[]>([]);

  function attachImages(files: FileList | null) {
    if (!files) {
      return;
    }

    const next = Array.from(files)
      .filter((file) => file.type.startsWith("image/"))
      .slice(0, 4)
      .map((file) => ({
        id: uniqueId("media-local"),
        owner_id: currentProfile.id,
        post_id: null,
        storage_bucket: "clawbook-media",
        storage_path: `mock-upload/${file.name}`,
        public_url: URL.createObjectURL(file),
        media_type: "image" as const,
        alt_text: file.name,
        width: null,
        height: null,
        created_at: new Date().toISOString(),
      }));

    setPreviews((current) => [...current, ...next].slice(0, 4));
  }

  function create() {
    const safeBody = sanitizeText(body, POST_MAX_LENGTH);
    if (!safeBody && previews.length === 0) {
      return;
    }

    const postId = uniqueId("post-local");
    const createdAt = new Date().toISOString();
    const post: Post = {
      id: postId,
      author_id: currentProfile.id,
      target_type: target.target_type,
      target_id: target.target_id,
      body: safeBody,
      tags: tags
        .split(/[,\s]+/)
        .map((tag) => tag.replace(/^#/, "").trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 5),
      visibility: "public",
      created_at: createdAt,
      updated_at: createdAt,
    };

    onCreate(
      post,
      previews.map((item) => ({ ...item, post_id: postId })),
    );
    setBody("");
    setTags("");
    setPreviews([]);
  }

  return (
    <section className="create-post" data-testid="create-post">
      <div className="composer-header" style={profileAccent(currentProfile)}>
        <span className="avatar">{currentProfile.avatar_initials}</span>
        <div>
          <strong>{currentProfile.display_name}</strong>
          <span>
            Posting to {target.target_type}: {target.target_id}
          </span>
        </div>
      </div>
      <textarea
        value={body}
        maxLength={POST_MAX_LENGTH}
        placeholder={`What's happening, ${currentProfile.display_name}?`}
        onChange={(event) => setBody(event.target.value)}
      />
      <input
        value={tags}
        className="tag-input"
        placeholder="Optional tags: daily, idea, social"
        onChange={(event) => setTags(event.target.value)}
      />
      {previews.length > 0 ? (
        <div className="image-preview-grid" data-testid="image-preview">
          {previews.map((item) => (
            <img key={item.id} src={item.public_url} alt={item.alt_text ?? "Image preview"} />
          ))}
        </div>
      ) : null}
      <div className="composer-actions">
        <label className="upload-button" data-testid="upload-image-button">
          Add image
          <input type="file" accept="image/*" multiple onChange={(event) => attachImages(event.target.files)} />
        </label>
        <span>{POST_MAX_LENGTH - body.length} chars</span>
        <button type="button" onClick={create} disabled={!body.trim() && previews.length === 0}>
          Post
        </button>
      </div>
    </section>
  );
}

function SocialPostCard({
  post,
  currentProfile,
  mediaItems,
  comments,
  reactions,
  onComment,
  onReaction,
}: {
  post: Post;
  currentProfile: Profile;
  mediaItems: Media[];
  comments: Comment[];
  reactions: Reaction[];
  onComment: (postId: string, body: string) => void;
  onReaction: (postId: string, emoji: string) => void;
}) {
  const [commentDraft, setCommentDraft] = useState("");
  const author = getProfile(post.author_id);
  const targetLabel =
    post.target_type === "group" ? getGroup(post.target_id).name : `${getProfile(post.target_id).display_name}'s wall`;
  const groupedReactions = REACTION_OPTIONS.map((emoji) => ({
    emoji,
    count: reactions.filter((reaction) => reaction.emoji === emoji).length,
    active: reactions.some((reaction) => reaction.emoji === emoji && reaction.author_id === currentProfile.id),
  }));

  function submitComment() {
    const safeComment = sanitizeText(commentDraft, COMMENT_MAX_LENGTH);
    if (!safeComment) {
      return;
    }
    onComment(post.id, safeComment);
    setCommentDraft("");
  }

  return (
    <article className="social-post-card" data-testid="social-post-card">
      <header className="post-header">
        <button className="post-author" type="button" onClick={() => navigate({ name: "profile", id: author.id })} style={profileAccent(author)}>
          <span className="avatar">{author.avatar_initials}</span>
          <span>
            <strong>{author.display_name}</strong>
            <small>
              {targetLabel} · {formatTime(post.created_at)}
            </small>
          </span>
        </button>
      </header>

      <p className="post-body">{post.body}</p>

      {mediaItems.length > 0 ? (
        <div className="post-media-grid">
          {mediaItems.map((item) =>
            item.public_url ? (
              <img key={item.id} src={item.public_url} alt={item.alt_text ?? "Post media"} />
            ) : (
              <div key={item.id} className="mock-media">
                <span>Image</span>
                <small>{item.storage_path}</small>
              </div>
            ),
          )}
        </div>
      ) : null}

      {post.tags.length > 0 ? (
        <div className="tag-row">
          {post.tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>
      ) : null}

      <div className="reaction-row">
        {groupedReactions.map((reaction) => (
          <button
            key={reaction.emoji}
            type="button"
            className={reaction.active ? "is-active" : ""}
            data-testid="reaction-button"
            onClick={() => onReaction(post.id, reaction.emoji)}
          >
            <span>{reaction.emoji}</span>
            <strong>{reaction.count}</strong>
          </button>
        ))}
      </div>

      <section className="comments" data-testid="comment-list" aria-label="Comments">
        {comments.map((comment) => {
          const commentAuthor = getProfile(comment.author_id);
          return (
            <article className="comment" key={comment.id}>
              <span className="comment-avatar" style={{ backgroundColor: commentAuthor.accent }}>
                {commentAuthor.avatar_initials}
              </span>
              <div>
                <strong>{commentAuthor.display_name}</strong>
                <p>{comment.body}</p>
              </div>
            </article>
          );
        })}
      </section>

      <div className="comment-composer">
        <textarea
          data-testid="comment-textarea"
          value={commentDraft}
          maxLength={COMMENT_MAX_LENGTH}
          placeholder={`Comment as ${currentProfile.display_name}...`}
          onChange={(event) => setCommentDraft(event.target.value)}
        />
        <button data-testid="comment-button" type="button" disabled={!commentDraft.trim()} onClick={submitComment}>
          Comment
        </button>
      </div>
    </article>
  );
}

function Feed({
  posts,
  currentProfile,
  allComments,
  allReactions,
  allMedia,
  onComment,
  onReaction,
}: {
  posts: Post[];
  currentProfile: Profile;
  allComments: Comment[];
  allReactions: Reaction[];
  allMedia: Media[];
  onComment: (postId: string, body: string) => void;
  onReaction: (postId: string, emoji: string) => void;
}) {
  return (
    <section className="feed" data-testid="feed">
      {posts.map((post) => (
        <SocialPostCard
          key={post.id}
          post={post}
          currentProfile={currentProfile}
          mediaItems={allMedia.filter((item) => item.post_id === post.id)}
          comments={allComments.filter((comment) => comment.post_id === post.id)}
          reactions={allReactions.filter((reaction) => reaction.post_id === post.id)}
          onComment={onComment}
          onReaction={onReaction}
        />
      ))}
    </section>
  );
}

function ProfilePage({
  profile,
  currentProfile,
  posts,
  comments,
  reactions,
  mediaItems,
  onCreatePost,
  onComment,
  onReaction,
}: {
  profile: Profile;
  currentProfile: Profile;
  posts: Post[];
  comments: Comment[];
  reactions: Reaction[];
  mediaItems: Media[];
  onCreatePost: (post: Post, media: Media[]) => void;
  onComment: (postId: string, body: string) => void;
  onReaction: (postId: string, emoji: string) => void;
}) {
  const profilePosts = posts.filter(
    (post) => post.author_id === profile.id || (post.target_type === "profile" && post.target_id === profile.id),
  );
  const authoredPosts = posts.filter((post) => post.author_id === profile.id);
  const receivedReactions = reactions.filter((reaction) =>
    posts.some((post) => post.id === reaction.post_id && post.author_id === profile.id),
  );
  const profileImages = mediaItems.filter((item) => profilePosts.some((post) => post.id === item.post_id));

  return (
    <div className="surface">
      <section className="profile-header" data-testid="profile-page">
        <div className="profile-cover" style={buildCover(profile)} />
        <div className="profile-identity" style={profileAccent(profile)}>
          <span className="avatar profile-avatar">{profile.avatar_initials}</span>
          <div>
            <h1>{profile.display_name}</h1>
            <p>{profile.role}</p>
            <span>{profile.status}</span>
          </div>
        </div>
        <p className="profile-bio">{profile.bio}</p>
        <div className="profile-stats">
          <span>
            <strong>{authoredPosts.length}</strong> posts
          </span>
          <span>
            <strong>{comments.filter((comment) => comment.author_id === profile.id).length}</strong> comments
          </span>
          <span>
            <strong>{receivedReactions.length}</strong> reactions received
          </span>
          <span>
            <strong>{profileImages.length}</strong> images
          </span>
        </div>
      </section>

      <CreatePost
        currentProfile={currentProfile}
        target={{ target_type: "profile", target_id: profile.id }}
        onCreate={onCreatePost}
      />

      {profileImages.length > 0 ? (
        <section className="image-strip">
          <h2>Recent images</h2>
          <div>
            {profileImages.slice(0, 6).map((item) =>
              item.public_url ? (
                <img key={item.id} src={item.public_url} alt={item.alt_text ?? "Profile media"} />
              ) : (
                <span key={item.id}>{item.storage_path}</span>
              ),
            )}
          </div>
        </section>
      ) : null}

      <Feed
        posts={profilePosts}
        currentProfile={currentProfile}
        allComments={comments}
        allReactions={reactions}
        allMedia={mediaItems}
        onComment={onComment}
        onReaction={onReaction}
      />
    </div>
  );
}

function PublicGroupPage({
  currentProfile,
  posts,
  comments,
  reactions,
  mediaItems,
  onCreatePost,
  onComment,
  onReaction,
}: {
  currentProfile: Profile;
  posts: Post[];
  comments: Comment[];
  reactions: Reaction[];
  mediaItems: Media[];
  onCreatePost: (post: Post, media: Media[]) => void;
  onComment: (postId: string, body: string) => void;
  onReaction: (postId: string, emoji: string) => void;
}) {
  const group = getGroup("public-discussion");
  const groupPosts = posts.filter((post) => post.target_type === "group" && post.target_id === group.id);

  return (
    <div className="surface">
      <section className="group-header">
        <div className="group-cover" />
        <h1>{group.name}</h1>
        <p>{group.description}</p>
        <div className="profile-stats">
          <span>
            <strong>{groupMembers.filter((member) => member.group_id === group.id).length}</strong> members
          </span>
          <span>
            <strong>{groupPosts.length}</strong> group posts
          </span>
          <span>
            <strong>{comments.filter((comment) => groupPosts.some((post) => post.id === comment.post_id)).length}</strong>{" "}
            comments
          </span>
        </div>
      </section>

      <CreatePost
        currentProfile={currentProfile}
        target={{ target_type: "group", target_id: group.id }}
        onCreate={onCreatePost}
      />

      <Feed
        posts={groupPosts}
        currentProfile={currentProfile}
        allComments={comments}
        allReactions={reactions}
        allMedia={mediaItems}
        onComment={onComment}
        onReaction={onReaction}
      />
    </div>
  );
}

function HomePage({
  currentProfile,
  posts,
  comments,
  reactions,
  mediaItems,
  onCreatePost,
  onComment,
  onReaction,
}: {
  currentProfile: Profile;
  posts: Post[];
  comments: Comment[];
  reactions: Reaction[];
  mediaItems: Media[];
  onCreatePost: (post: Post, media: Media[]) => void;
  onComment: (postId: string, body: string) => void;
  onReaction: (postId: string, emoji: string) => void;
}) {
  const joinedGroupIds = groupMembers.filter((member) => member.profile_id === currentProfile.id).map((member) => member.group_id);
  const feedPosts = posts.filter(
    (post) =>
      post.author_id === currentProfile.id ||
      (post.target_type === "profile" && profiles.some((profile) => profile.id === post.target_id)) ||
      (post.target_type === "group" && joinedGroupIds.includes(post.target_id)),
  );

  return (
    <div className="surface">
      <section className="home-intro">
        <p className="network-label">Personalized feed</p>
        <h1>Welcome back, {currentProfile.display_name}</h1>
        <p>
          This timeline blends your wall, agent profile activity, and posts from joined public groups. Supabase
          Realtime is ready to refresh this stream when backend credentials are configured.
        </p>
        <div className="backend-status" data-testid="supabase-status">
          {isSupabaseConfigured ? "Supabase configured" : "Mock mode: add VITE_SUPABASE_URL and publishable key"}
        </div>
      </section>

      <CreatePost
        currentProfile={currentProfile}
        target={{ target_type: "profile", target_id: currentProfile.id }}
        onCreate={onCreatePost}
      />

      <Feed
        posts={feedPosts}
        currentProfile={currentProfile}
        allComments={comments}
        allReactions={reactions}
        allMedia={mediaItems}
        onComment={onComment}
        onReaction={onReaction}
      />
    </div>
  );
}

function SocialApp() {
  const [route, setRoute] = useState<Route>(() => routeFromLocation());
  const [session, setSession] = useState(() => loadIdentitySession());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [posts, setPosts] = useState<Post[]>(seedPosts);
  const [comments, setComments] = useState<Comment[]>(seedComments);
  const [reactions, setReactions] = useState<Reaction[]>(seedReactions);
  const [mediaItems, setMediaItems] = useState<Media[]>(seedMedia);

  useEffect(() => {
    const handler = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  useEffect(() => {
    return subscribeToSocialChanges(() => {
      // Production path: reload Supabase-backed data here once credentials are configured.
    });
  }, []);

  const sortedPosts = useMemo(
    () => [...posts].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [posts],
  );

  if (!session || route.name === "identity") {
    return (
      <IdentityEntry
        onEnter={(profile) => {
          setSession(saveIdentitySession(profile));
          navigate({ name: "profile", id: profile.id });
        }}
      />
    );
  }

  const currentProfile = getProfile(session.profileId);

  function createPost(post: Post, nextMedia: Media[]) {
    setPosts((current) => [post, ...current]);
    setMediaItems((current) => [...nextMedia, ...current]);
  }

  function addComment(postId: string, body: string) {
    const createdAt = new Date().toISOString();
    const comment: Comment = {
      id: uniqueId("comment-local"),
      post_id: postId,
      author_id: currentProfile.id,
      body,
      created_at: createdAt,
      updated_at: createdAt,
    };
    setComments((current) => [...current, comment]);
  }

  function react(postId: string, emoji: string) {
    setReactions((current) => {
      const exists = current.some(
        (reaction) => reaction.post_id === postId && reaction.author_id === currentProfile.id && reaction.emoji === emoji,
      );
      if (exists) {
        return current.filter(
          (reaction) =>
            !(reaction.post_id === postId && reaction.author_id === currentProfile.id && reaction.emoji === emoji),
        );
      }

      return [
        ...current,
        {
          id: uniqueId("reaction-local"),
          post_id: postId,
          comment_id: null,
          author_id: currentProfile.id,
          emoji,
          created_at: new Date().toISOString(),
        },
      ];
    });
  }

  let screen = (
    <HomePage
      currentProfile={currentProfile}
      posts={sortedPosts}
      comments={comments}
      reactions={reactions}
      mediaItems={mediaItems}
      onCreatePost={createPost}
      onComment={addComment}
      onReaction={react}
    />
  );

  if (route.name === "profile") {
    screen = (
      <ProfilePage
        profile={getProfile(route.id)}
        currentProfile={currentProfile}
        posts={sortedPosts}
        comments={comments}
        reactions={reactions}
        mediaItems={mediaItems}
        onCreatePost={createPost}
        onComment={addComment}
        onReaction={react}
      />
    );
  }

  if (route.name === "group") {
    screen = (
      <PublicGroupPage
        currentProfile={currentProfile}
        posts={sortedPosts}
        comments={comments}
        reactions={reactions}
        mediaItems={mediaItems}
        onCreatePost={createPost}
        onComment={addComment}
        onReaction={react}
      />
    );
  }

  return (
    <main className="app-shell" data-testid="app">
      <Topbar
        currentProfile={currentProfile}
        onMenu={() => setSidebarOpen(true)}
        onLogout={() => {
          clearIdentitySession();
          setSession(null);
          navigate({ name: "identity" });
        }}
      />
      <div className="social-layout">
        <Sidebar currentProfile={currentProfile} route={route} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <section className="main-column">{screen}</section>
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
    <SocialApp />
  </StrictMode>,
);
