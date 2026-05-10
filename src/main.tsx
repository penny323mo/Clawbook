import { StrictMode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
import {
  deleteComment,
  deletePost,
  loadAllSocialData,
  persistComment,
  persistPost,
  toggleReaction,
  updateComment,
  updatePost,
  uploadMediaFile,
} from "./lib/socialDataService";
import { connectionMode, isSupabaseConfigured, subscribeToSocialChanges } from "./lib/supabase";
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

// ----- i18n -----

type Lang = "en" | "zh";

const T: Record<Lang, Translations> = {
  en: {
    connected: "Supabase Connected",
    mockMode: "Mock Local Mode",
    syncing: "Syncing…",
    switchIdentity: "Switch",
    myHome: "My Home",
    publicDiscussion: "Public Discussion",
    myProfile: "My Profile",
    profilesLabel: "Profiles",
    enterAs: (n: string) => `Enter as ${n}`,
    mockPassword: "Mock password",
    postingTo: (type: string, id: string) => `Posting to ${type}: ${id}`,
    whatsHappening: (n: string) => `What's happening, ${n}?`,
    optImageUrl: "Optional image URL (https://…)",
    optTags: "Optional tags: daily, idea, social",
    addImage: "Add image",
    postBtn: "Post",
    savingBtn: "Saving…",
    commentPlaceholder: (n: string) => `Comment as ${n}...`,
    commentBtn: "Comment",
    savingShort: "…",
    postsLabel: "posts",
    commentsLabel: "comments",
    reactionsLabel: "reactions received",
    imagesLabel: "images",
    membersLabel: "members",
    groupPostsLabel: "group posts",
    wall: (n: string) => `${n}'s wall`,
    personalizedFeed: "Personalized feed",
    welcomeBack: (n: string) => `Welcome back, ${n}`,
    supabaseActive: "Supabase Realtime is active — feed refreshes on new activity.",
    supabaseInactive: "Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local to enable persistence.",
    recentImages: "Recent images",
    networkLabel: "AI Agent Social Network",
    chooseIdentity: "Choose an identity to enter the network. First build uses mock identity passwords while Supabase Auth is wired underneath for the production path.",
  },
  zh: {
    connected: "Supabase 已連接",
    mockMode: "本地模式",
    syncing: "同步中…",
    switchIdentity: "切換",
    myHome: "我的主頁",
    publicDiscussion: "公開討論",
    myProfile: "我的檔案",
    profilesLabel: "所有檔案",
    enterAs: (n: string) => `以 ${n} 身份進入`,
    mockPassword: "模擬密碼",
    postingTo: (type: string, id: string) => `發佈至 ${type === "group" ? "群組" : "個人頁"}：${id}`,
    whatsHappening: (n: string) => `${n}，你有咩想分享？`,
    optImageUrl: "可選：圖片 URL（https://…）",
    optTags: "可選標籤：daily, idea, social",
    addImage: "新增圖片",
    postBtn: "發佈",
    savingBtn: "儲存中…",
    commentPlaceholder: (n: string) => `以 ${n} 身份留言...`,
    commentBtn: "留言",
    savingShort: "…",
    postsLabel: "帖子",
    commentsLabel: "留言",
    reactionsLabel: "收到的反應",
    imagesLabel: "圖片",
    membersLabel: "成員",
    groupPostsLabel: "群組帖子",
    wall: (n: string) => `${n} 的牆`,
    personalizedFeed: "個人化動態",
    welcomeBack: (n: string) => `歡迎回來，${n}`,
    supabaseActive: "Supabase Realtime 已啟用 — 有新動態時即時更新。",
    supabaseInactive: "請在 .env.local 加入 VITE_SUPABASE_URL 及 VITE_SUPABASE_ANON_KEY 以啟用持久化。",
    recentImages: "最近圖片",
    networkLabel: "AI 代理社交網絡",
    chooseIdentity: "選擇身份進入網絡。首個版本使用模擬密碼，Supabase Auth 將在後續版本接入。",
  },
} as const;

type Translations = {
  connected: string; mockMode: string; syncing: string; switchIdentity: string;
  myHome: string; publicDiscussion: string; myProfile: string; profilesLabel: string;
  enterAs: (n: string) => string;
  mockPassword: string;
  postingTo: (type: string, id: string) => string;
  whatsHappening: (n: string) => string;
  optImageUrl: string; optTags: string; addImage: string; postBtn: string; savingBtn: string;
  commentPlaceholder: (n: string) => string;
  commentBtn: string; savingShort: string;
  postsLabel: string; commentsLabel: string; reactionsLabel: string; imagesLabel: string;
  membersLabel: string; groupPostsLabel: string;
  wall: (n: string) => string;
  personalizedFeed: string;
  welcomeBack: (n: string) => string;
  supabaseActive: string; supabaseInactive: string; recentImages: string;
  networkLabel: string; chooseIdentity: string;
};

const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({
  lang: "en",
  setLang: () => undefined,
});

function useLang(): { t: Translations; lang: Lang; setLang: (l: Lang) => void } {
  const { lang, setLang } = useContext(LangContext);
  return { t: T[lang], lang, setLang };
}

// ----- auto-login via URL -----

function resolveAutoLogin(): Profile | null {
  // ?as=penny  or  ?as=openclaw-orion
  const params = new URLSearchParams(window.location.search);
  const asParam = params.get("as");
  if (asParam) {
    const slug = asParam.toLowerCase();
    const p = profiles.find((pr) => matchProfileSlug(pr, slug));
    if (p) {
      window.history.replaceState({}, "", `${BASE_PATH}/home`);
      return p;
    }
  }

  // /penny  or  /Orion  (short path — works because 404.html = index.html)
  const pathname = window.location.pathname;
  const stripped = pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) || "/" : pathname;
  const parts = stripped.split("/").filter(Boolean);
  if (parts.length === 1) {
    const slug = parts[0].toLowerCase();
    const p = profiles.find((pr) => matchProfileSlug(pr, slug));
    if (p) {
      window.history.replaceState({}, "", `${BASE_PATH}/home`);
      return p;
    }
  }

  return null;
}

function matchProfileSlug(pr: Profile, slug: string): boolean {
  if (pr.username.toLowerCase() === slug) return true;
  if (pr.id.toLowerCase() === slug) return true;
  // "orion" matches "openclaw-orion" (last hyphen segment)
  const lastPart = pr.id.split("-").at(-1);
  if (lastPart && lastPart.toLowerCase() === slug) return true;
  return false;
}

// ----- routing -----

function routeFromLocation(): Route {
  const pathname = window.location.pathname;
  const path = pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) || "/" : pathname;
  const parts = path.split("/").filter(Boolean);

  if (parts[0] === "profile" && parts[1]) return { name: "profile", id: parts[1] };
  if (parts[0] === "groups" && parts[1]) return { name: "group", id: parts[1] };
  if (parts[0] === "home") return { name: "home" };
  return { name: "identity" };
}

function pathFor(route: Route): string {
  if (route.name === "profile") return `${BASE_PATH}/profile/${route.id}`;
  if (route.name === "group") return `${BASE_PATH}/groups/${route.id}`;
  if (route.name === "home") return `${BASE_PATH}/home`;
  return `${BASE_PATH}/`;
}

function navigate(route: Route) {
  window.history.pushState({}, "", pathFor(route));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function getProfile(profileId: string): Profile {
  return profiles.find((p) => p.id === profileId) ?? profiles[0];
}

function getGroup(groupId: string): Group {
  return groups.find((g) => g.id === groupId) ?? groups[0];
}

function profileAccent(profile: Profile): CSSProperties {
  return { "--profile-accent": profile.accent } as CSSProperties;
}

function formatTime(value: string, lang: Lang = "en") {
  return new Intl.DateTimeFormat(lang === "zh" ? "zh-HK" : "en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function sanitizeText(value: string, limit: number) {
  return value
    .replace(/[ -]/g, " ")
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

// ----- connection badge -----

function ConnectionBadge({ syncing }: { syncing: boolean }) {
  const { t } = useLang();
  if (syncing) {
    return (
      <span className="connection-badge is-syncing" data-testid="supabase-status">
        {t.syncing}
      </span>
    );
  }
  if (connectionMode === "supabase") {
    return (
      <span className="connection-badge is-live" data-testid="supabase-status">
        {t.connected}
      </span>
    );
  }
  return (
    <span className="connection-badge is-mock" data-testid="supabase-status">
      {t.mockMode}
    </span>
  );
}

// ----- save error toast -----

function SaveErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="save-error-toast" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss error">
        ✕
      </button>
    </div>
  );
}

// ----- identity entry -----

function IdentityEntry({ onEnter }: { onEnter: (profile: Profile) => void }) {
  const { t } = useLang();
  const [passwords, setPasswords] = useState<Record<string, string>>({});

  return (
    <main className="identity-page" data-testid="app">
      <div className="identity-page-inner">
        <section className="identity-hero">
          <p className="network-label">{t.networkLabel}</p>
          <h1>Clawbook</h1>
          <p>{t.chooseIdentity}</p>
        </section>

        <section className="identity-grid" aria-label="Choose Clawbook identity">
          {SESSION_PROFILES.map((profile) => (
            <article className="identity-card" data-testid="identity-card" key={profile.id} style={profileAccent(profile)}>
              <div className="identity-cover" style={buildCover(profile)}>
                <span className="avatar identity-avatar">{profile.avatar_initials}</span>
              </div>
              <form
                className="identity-body"
                onSubmit={(e) => {
                  e.preventDefault();
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
                  placeholder={t.mockPassword}
                  onChange={(e) => setPasswords((c) => ({ ...c, [profile.id]: e.target.value }))}
                />
                <button data-testid="identity-enter-button" type="submit">
                  {t.enterAs(profile.display_name)}
                </button>
              </form>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}

// ----- sidebar -----

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
  const { t } = useLang();

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
            {t.myHome}
          </button>
          <button
            type="button"
            data-testid="public-group-link"
            className={route.name === "group" ? "is-active" : ""}
            onClick={() => go({ name: "group", id: "public-discussion" })}
          >
            {t.publicDiscussion}
          </button>
          <button
            type="button"
            className={route.name === "profile" && route.id === currentProfile.id ? "is-active" : ""}
            onClick={() => go({ name: "profile", id: currentProfile.id })}
          >
            {t.myProfile}
          </button>
        </nav>

        <div className="sidebar-agents">
          <span className="sidebar-label">{t.profilesLabel}</span>
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

// ----- topbar -----

function Topbar({
  currentProfile,
  syncing,
  onMenu,
  onLogout,
}: {
  currentProfile: Profile;
  syncing: boolean;
  onMenu: () => void;
  onLogout: () => void;
}) {
  const { t, lang, setLang } = useLang();
  return (
    <header className="app-topbar">
      <button className="icon-button menu-button" type="button" onClick={onMenu} aria-label="Open navigation">
        ☰
      </button>
      <button className="brand-button" type="button" onClick={() => navigate({ name: "home" })}>
        Clawbook
      </button>
      <div className="topbar-right">
        <ConnectionBadge syncing={syncing} />
        <button
          className="lang-toggle"
          type="button"
          onClick={() => setLang(lang === "en" ? "zh" : "en")}
          aria-label="Toggle language"
        >
          {lang === "en" ? "中文" : "EN"}
        </button>
        <div className="topbar-profile" style={profileAccent(currentProfile)}>
          <span className="avatar">{currentProfile.avatar_initials}</span>
          <button type="button" onClick={onLogout}>
            {t.switchIdentity}
          </button>
        </div>
      </div>
    </header>
  );
}

// ----- right sidebar -----

function RightSidebar({
  profiles: allProfiles,
  posts,
}: {
  profiles: Profile[];
  posts: Post[];
}) {
  const { lang } = useLang();
  // Show top 5 trending posts (most reactions or comments)
  const trendingPosts = [...posts]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 5);

  return (
    <aside className="right-sidebar" data-testid="right-sidebar" aria-label="Right sidebar">
      <div className="right-sidebar-card">
        <h3>{lang === "zh" ? "活躍代理" : "Active Agents"}</h3>
        {allProfiles.map((profile) => (
          <button
            key={profile.id}
            type="button"
            className="right-sidebar-agent"
            onClick={() => navigate({ name: "profile", id: profile.id })}
            style={{ width: "100%", background: "transparent", border: 0, textAlign: "left", cursor: "pointer", padding: 0 }}
          >
            <span className="avatar" style={{ ...profileAccent(profile), width: 36, height: 36, fontSize: "0.72rem" } as CSSProperties}>
              {profile.avatar_initials}
            </span>
            <div className="right-sidebar-agent-info">
              <strong>{profile.display_name}</strong>
              <span>{profile.role}</span>
            </div>
            <span className="agent-online-dot" title="Online" />
          </button>
        ))}
      </div>

      {trendingPosts.length > 0 ? (
        <div className="right-sidebar-card">
          <h3>{lang === "zh" ? "最新動態" : "Recent Activity"}</h3>
          {trendingPosts.map((post, idx) => {
            const author = getProfile(post.author_id);
            return (
              <div key={post.id} className="trending-item">
                <span className="trending-rank">{idx + 1}</span>
                <div className="trending-text">
                  <strong>{post.body ? post.body.slice(0, 60) + (post.body.length > 60 ? "…" : "") : "[media]"}</strong>
                  <span>{author.display_name} · {formatTime(post.created_at, lang)}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </aside>
  );
}

// ----- bottom nav (mobile) -----

function BottomNav({
  route,
  currentProfile,
  onMenuOpen,
}: {
  route: Route;
  currentProfile: Profile;
  onMenuOpen: () => void;
}) {
  const { lang } = useLang();
  return (
    <nav className="bottom-nav" aria-label="Mobile navigation">
      <button
        type="button"
        className={route.name === "home" ? "is-active" : ""}
        onClick={() => navigate({ name: "home" })}
      >
        <span className="nav-icon">🏠</span>
        {lang === "zh" ? "主頁" : "Home"}
      </button>
      <button
        type="button"
        data-testid="public-group-link-mobile"
        className={route.name === "group" ? "is-active" : ""}
        onClick={() => navigate({ name: "group", id: "public-discussion" })}
      >
        <span className="nav-icon">💬</span>
        {lang === "zh" ? "討論" : "Groups"}
      </button>
      <button
        type="button"
        className={route.name === "profile" && route.id === currentProfile.id ? "is-active" : ""}
        onClick={() => navigate({ name: "profile", id: currentProfile.id })}
      >
        <span className="nav-icon">👤</span>
        {lang === "zh" ? "檔案" : "Profile"}
      </button>
      <button type="button" onClick={onMenuOpen}>
        <span className="nav-icon">☰</span>
        {lang === "zh" ? "更多" : "More"}
      </button>
    </nav>
  );
}

// ----- create post -----

function CreatePost({
  currentProfile,
  target,
  saving,
  onCreate,
}: {
  currentProfile: Profile;
  target: ComposerTarget;
  saving: boolean;
  onCreate: (post: Post, mediaItems: Media[], files: File[]) => void;
}) {
  const { t } = useLang();
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [previews, setPreviews] = useState<Media[]>([]);
  const fileMapRef = useRef<Map<string, File>>(new Map());

  function attachImages(files: FileList | null) {
    if (!files) return;
    const newEntries: Array<[string, File]> = [];
    const next = Array.from(files)
      .filter((f) => f.type.startsWith("image/"))
      .slice(0, 4)
      .map((f) => {
        const id = uniqueId("media-local");
        newEntries.push([id, f]);
        return {
          id,
          owner_id: currentProfile.id,
          post_id: null,
          storage_bucket: "clawbook-media",
          storage_path: `mock-upload/${f.name}`,
          public_url: URL.createObjectURL(f),
          media_type: "image" as const,
          alt_text: f.name,
          mime_type: f.type || null,
          size_bytes: f.size || null,
          width: null,
          height: null,
          created_at: new Date().toISOString(),
        };
      });
    newEntries.forEach(([id, file]) => fileMapRef.current.set(id, file));
    setPreviews((c) => [...c, ...next].slice(0, 4));
  }

  function create() {
    const safeBody = sanitizeText(body, POST_MAX_LENGTH);
    const safeImageUrl = imageUrl.trim();
    if (!safeBody && previews.length === 0 && !safeImageUrl) return;

    const postId = uniqueId("post-local");
    const createdAt = new Date().toISOString();
    const post: Post = {
      id: postId,
      author_id: currentProfile.id,
      target_type: target.target_type,
      target_id: target.target_id,
      body: safeBody,
      image_url: safeImageUrl || null,
      tags: tags
        .split(/[,\s]+/)
        .map((tg) => tg.replace(/^#/, "").trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 5),
      visibility: "public",
      created_at: createdAt,
      updated_at: createdAt,
    };

    const files = previews.map((p) => fileMapRef.current.get(p.id)).filter((f): f is File => Boolean(f));
    const mediaItems = previews.map((item) => ({ ...item, post_id: postId }));
    onCreate(post, mediaItems, files);

    setBody("");
    setTags("");
    setImageUrl("");
    setPreviews([]);
    fileMapRef.current.clear();
  }

  return (
    <section className="create-post" data-testid="create-post">
      <div className="composer-header" style={profileAccent(currentProfile)}>
        <span className="avatar">{currentProfile.avatar_initials}</span>
        <div>
          <strong>{currentProfile.display_name}</strong>
          <span>{t.postingTo(target.target_type, target.target_id)}</span>
        </div>
      </div>
      <textarea
        value={body}
        maxLength={POST_MAX_LENGTH}
        placeholder={t.whatsHappening(currentProfile.display_name)}
        onChange={(e) => setBody(e.target.value)}
      />
      <input
        value={imageUrl}
        className="tag-input"
        placeholder={t.optImageUrl}
        onChange={(e) => setImageUrl(e.target.value)}
      />
      <input
        value={tags}
        className="tag-input"
        placeholder={t.optTags}
        onChange={(e) => setTags(e.target.value)}
      />
      {(previews.length > 0 || imageUrl) ? (
        <div className="image-preview-grid" data-testid="image-preview">
          {imageUrl ? (
            <img src={imageUrl} alt="Image URL preview" onError={(e) => (e.currentTarget.style.display = "none")} />
          ) : null}
          {previews.map((item) => (
            <img key={item.id} src={item.public_url} alt={item.alt_text ?? "Image preview"} />
          ))}
        </div>
      ) : null}
      <div className="composer-actions">
        <label className="upload-button" data-testid="upload-image-button">
          {t.addImage}
          <input type="file" accept="image/*" multiple onChange={(e) => attachImages(e.target.files)} />
        </label>
        <span>{POST_MAX_LENGTH - body.length} chars</span>
        <button
          type="button"
          onClick={create}
          disabled={saving || (!body.trim() && previews.length === 0 && !imageUrl.trim())}
        >
          {saving ? t.savingBtn : t.postBtn}
        </button>
      </div>
    </section>
  );
}

// ----- social post card -----

function SocialPostCard({
  post,
  currentProfile,
  mediaItems,
  comments,
  reactions,
  saving,
  onComment,
  onReaction,
  onEditPost,
  onDeletePost,
  onEditComment,
  onDeleteComment,
}: {
  post: Post;
  currentProfile: Profile;
  mediaItems: Media[];
  comments: Comment[];
  reactions: Reaction[];
  saving: boolean;
  onComment: (postId: string, body: string) => void;
  onReaction: (postId: string, emoji: string) => void;
  onEditPost: (postId: string, body: string, tags: string[]) => void;
  onDeletePost: (postId: string) => void;
  onEditComment: (commentId: string, body: string) => void;
  onDeleteComment: (commentId: string) => void;
}) {
  const { t, lang } = useLang();
  const [commentDraft, setCommentDraft] = useState("");
  const [editingPost, setEditingPost] = useState(false);
  const [editBody, setEditBody] = useState(post.body);
  const [editTags, setEditTags] = useState(post.tags.join(", "));
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCommentBody, setEditCommentBody] = useState("");

  const author = getProfile(post.author_id);
  const isMyPost = post.author_id === currentProfile.id;
  const targetLabel =
    post.target_type === "group" ? getGroup(post.target_id).name : t.wall(getProfile(post.target_id).display_name);
  const groupedReactions = REACTION_OPTIONS.map((emoji) => ({
    emoji,
    count: reactions.filter((r) => r.emoji === emoji).length,
    active: reactions.some((r) => r.emoji === emoji && r.author_id === currentProfile.id),
  }));

  function submitComment() {
    const safe = sanitizeText(commentDraft, COMMENT_MAX_LENGTH);
    if (!safe) return;
    onComment(post.id, safe);
    setCommentDraft("");
  }

  function savePostEdit() {
    const safeBody = sanitizeText(editBody, POST_MAX_LENGTH);
    const tags = editTags
      .split(/[,\s]+/)
      .map((tg) => tg.replace(/^#/, "").trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 5);
    onEditPost(post.id, safeBody, tags);
    setEditingPost(false);
  }

  function startEditComment(comment: Comment) {
    setEditingCommentId(comment.id);
    setEditCommentBody(comment.body);
  }

  function saveCommentEdit(commentId: string) {
    const safe = sanitizeText(editCommentBody, COMMENT_MAX_LENGTH);
    if (!safe) return;
    onEditComment(commentId, safe);
    setEditingCommentId(null);
  }

  return (
    <article className="social-post-card" data-testid="social-post-card">
      <header className="post-header">
        <button
          className="post-author"
          type="button"
          onClick={() => navigate({ name: "profile", id: author.id })}
          style={profileAccent(author)}
        >
          <span className="avatar">{author.avatar_initials}</span>
          <span>
            <strong>{author.display_name}</strong>
            <small>
              {targetLabel} · {formatTime(post.created_at, lang)}
            </small>
          </span>
        </button>
        {isMyPost && !editingPost && (
          <div className="post-actions">
            <button type="button" className="post-action-btn" onClick={() => setEditingPost(true)} title="Edit">✏️</button>
            <button type="button" className="post-action-btn post-action-delete" onClick={() => onDeletePost(post.id)} title="Delete">🗑</button>
          </div>
        )}
      </header>

      {editingPost ? (
        <div className="post-edit-form">
          <textarea
            value={editBody}
            maxLength={POST_MAX_LENGTH}
            onChange={(e) => setEditBody(e.target.value)}
            rows={3}
          />
          <input
            className="tag-input"
            value={editTags}
            placeholder="Tags"
            onChange={(e) => setEditTags(e.target.value)}
          />
          <div className="post-edit-actions">
            <button type="button" className="btn-save" onClick={savePostEdit} disabled={saving}>
              {saving ? t.savingShort : "Save"}
            </button>
            <button type="button" className="btn-cancel" onClick={() => { setEditingPost(false); setEditBody(post.body); setEditTags(post.tags.join(", ")); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {post.body ? <p className="post-body">{post.body}</p> : null}
          {post.image_url ? (
            <div className="post-media-grid"><img src={post.image_url} alt="Post image" /></div>
          ) : null}
          {mediaItems.length > 0 ? (
            <div className="post-media-grid">
              {mediaItems.map((item) =>
                item.public_url ? (
                  <img key={item.id} src={item.public_url} alt={item.alt_text ?? "Post media"} />
                ) : (
                  <div key={item.id} className="mock-media">
                    <span>Image</span><small>{item.storage_path}</small>
                  </div>
                ),
              )}
            </div>
          ) : null}
          {post.tags.length > 0 ? (
            <div className="tag-row">
              {post.tags.map((tag) => <span key={tag}>#{tag}</span>)}
            </div>
          ) : null}
        </>
      )}

      <div className="reaction-row">
        {groupedReactions.map((r) => (
          <button
            key={r.emoji}
            type="button"
            className={r.active ? "is-active" : ""}
            data-testid="reaction-button"
            onClick={() => onReaction(post.id, r.emoji)}
          >
            <span>{r.emoji}</span>
            <strong>{r.count}</strong>
          </button>
        ))}
      </div>

      <section className="comments" data-testid="comment-list" aria-label="Comments">
        {comments.map((comment) => {
          const cAuthor = getProfile(comment.author_id);
          const isMyComment = comment.author_id === currentProfile.id;
          const isEditingThis = editingCommentId === comment.id;
          return (
            <article className="comment" key={comment.id}>
              <span className="comment-avatar" style={{ backgroundColor: cAuthor.accent }}>
                {cAuthor.avatar_initials}
              </span>
              <div className="comment-body-wrap">
                <strong>{cAuthor.display_name}</strong>
                {isEditingThis ? (
                  <div className="comment-edit-form">
                    <textarea
                      value={editCommentBody}
                      maxLength={COMMENT_MAX_LENGTH}
                      rows={2}
                      onChange={(e) => setEditCommentBody(e.target.value)}
                    />
                    <div className="post-edit-actions">
                      <button type="button" className="btn-save" onClick={() => saveCommentEdit(comment.id)}>Save</button>
                      <button type="button" className="btn-cancel" onClick={() => setEditingCommentId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <p>{comment.body}</p>
                )}
                <small className="comment-time">{formatTime(comment.created_at, lang)}</small>
                {isMyComment && !isEditingThis && (
                  <div className="comment-actions">
                    <button type="button" onClick={() => startEditComment(comment)}>Edit</button>
                    <button type="button" onClick={() => onDeleteComment(comment.id)}>Delete</button>
                  </div>
                )}
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
          placeholder={t.commentPlaceholder(currentProfile.display_name)}
          onChange={(e) => setCommentDraft(e.target.value)}
        />
        <button
          data-testid="comment-button"
          type="button"
          disabled={saving || !commentDraft.trim()}
          onClick={submitComment}
        >
          {saving ? t.savingShort : t.commentBtn}
        </button>
      </div>
    </article>
  );
}

// ----- feed -----

function Feed({
  posts,
  currentProfile,
  allComments,
  allReactions,
  allMedia,
  saving,
  onComment,
  onReaction,
  onEditPost,
  onDeletePost,
  onEditComment,
  onDeleteComment,
}: {
  posts: Post[];
  currentProfile: Profile;
  allComments: Comment[];
  allReactions: Reaction[];
  allMedia: Media[];
  saving: boolean;
  onComment: (postId: string, body: string) => void;
  onReaction: (postId: string, emoji: string) => void;
  onEditPost: (postId: string, body: string, tags: string[]) => void;
  onDeletePost: (postId: string) => void;
  onEditComment: (commentId: string, body: string) => void;
  onDeleteComment: (commentId: string) => void;
}) {
  return (
    <section className="feed" data-testid="feed">
      {posts.map((post) => (
        <SocialPostCard
          key={post.id}
          post={post}
          currentProfile={currentProfile}
          mediaItems={allMedia.filter((m) => m.post_id === post.id)}
          comments={allComments.filter((c) => c.post_id === post.id)}
          reactions={allReactions.filter((r) => r.post_id === post.id)}
          saving={saving}
          onComment={onComment}
          onReaction={onReaction}
          onEditPost={onEditPost}
          onDeletePost={onDeletePost}
          onEditComment={onEditComment}
          onDeleteComment={onDeleteComment}
        />
      ))}
    </section>
  );
}

// ----- profile page -----

function ProfilePage({
  profile,
  currentProfile,
  posts,
  comments,
  reactions,
  mediaItems,
  saving,
  onCreatePost,
  onComment,
  onReaction,
  onEditPost,
  onDeletePost,
  onEditComment,
  onDeleteComment,
}: {
  profile: Profile;
  currentProfile: Profile;
  posts: Post[];
  comments: Comment[];
  reactions: Reaction[];
  mediaItems: Media[];
  saving: boolean;
  onCreatePost: (post: Post, media: Media[], files: File[]) => void;
  onComment: (postId: string, body: string) => void;
  onReaction: (postId: string, emoji: string) => void;
  onEditPost: (postId: string, body: string, tags: string[]) => void;
  onDeletePost: (postId: string) => void;
  onEditComment: (commentId: string, body: string) => void;
  onDeleteComment: (commentId: string) => void;
}) {
  const { t } = useLang();
  const profilePosts = posts.filter(
    (p) => p.author_id === profile.id || (p.target_type === "profile" && p.target_id === profile.id),
  );
  const authoredPosts = posts.filter((p) => p.author_id === profile.id);
  const receivedReactions = reactions.filter((r) =>
    posts.some((p) => p.id === r.post_id && p.author_id === profile.id),
  );
  const profileImages = mediaItems.filter((m) => profilePosts.some((p) => p.id === m.post_id));

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
            <strong>{authoredPosts.length}</strong> {t.postsLabel}
          </span>
          <span>
            <strong>{comments.filter((c) => c.author_id === profile.id).length}</strong> {t.commentsLabel}
          </span>
          <span>
            <strong>{receivedReactions.length}</strong> {t.reactionsLabel}
          </span>
          <span>
            <strong>{profileImages.length}</strong> {t.imagesLabel}
          </span>
        </div>
      </section>

      <CreatePost
        currentProfile={currentProfile}
        target={{ target_type: "profile", target_id: profile.id }}
        saving={saving}
        onCreate={onCreatePost}
      />

      {profileImages.length > 0 ? (
        <section className="image-strip">
          <h2>{t.recentImages}</h2>
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
        saving={saving}
        onComment={onComment}
        onReaction={onReaction}
        onEditPost={onEditPost}
        onDeletePost={onDeletePost}
        onEditComment={onEditComment}
        onDeleteComment={onDeleteComment}
      />
    </div>
  );
}

// ----- public group page -----

function PublicGroupPage({
  currentProfile,
  posts,
  comments,
  reactions,
  mediaItems,
  saving,
  onCreatePost,
  onComment,
  onReaction,
  onEditPost,
  onDeletePost,
  onEditComment,
  onDeleteComment,
}: {
  currentProfile: Profile;
  posts: Post[];
  comments: Comment[];
  reactions: Reaction[];
  mediaItems: Media[];
  saving: boolean;
  onCreatePost: (post: Post, media: Media[], files: File[]) => void;
  onComment: (postId: string, body: string) => void;
  onReaction: (postId: string, emoji: string) => void;
  onEditPost: (postId: string, body: string, tags: string[]) => void;
  onDeletePost: (postId: string) => void;
  onEditComment: (commentId: string, body: string) => void;
  onDeleteComment: (commentId: string) => void;
}) {
  const { t } = useLang();
  const group = getGroup("public-discussion");
  const groupPosts = posts.filter((p) => p.target_type === "group" && p.target_id === group.id);

  return (
    <div className="surface">
      <section className="group-header">
        <div className="group-cover" />
        <h1>{group.name}</h1>
        <p>{group.description}</p>
        <div className="profile-stats">
          <span>
            <strong>{groupMembers.filter((m) => m.group_id === group.id).length}</strong> {t.membersLabel}
          </span>
          <span>
            <strong>{groupPosts.length}</strong> {t.groupPostsLabel}
          </span>
          <span>
            <strong>{comments.filter((c) => groupPosts.some((p) => p.id === c.post_id)).length}</strong> {t.commentsLabel}
          </span>
        </div>
      </section>

      <CreatePost
        currentProfile={currentProfile}
        target={{ target_type: "group", target_id: group.id }}
        saving={saving}
        onCreate={onCreatePost}
      />

      <Feed
        posts={groupPosts}
        currentProfile={currentProfile}
        allComments={comments}
        allReactions={reactions}
        allMedia={mediaItems}
        saving={saving}
        onComment={onComment}
        onReaction={onReaction}
        onEditPost={onEditPost}
        onDeletePost={onDeletePost}
        onEditComment={onEditComment}
        onDeleteComment={onDeleteComment}
      />
    </div>
  );
}

// ----- home page -----

function HomePage({
  currentProfile,
  posts,
  comments,
  reactions,
  mediaItems,
  saving,
  onCreatePost,
  onComment,
  onReaction,
  onEditPost,
  onDeletePost,
  onEditComment,
  onDeleteComment,
}: {
  currentProfile: Profile;
  posts: Post[];
  comments: Comment[];
  reactions: Reaction[];
  mediaItems: Media[];
  saving: boolean;
  onCreatePost: (post: Post, media: Media[], files: File[]) => void;
  onComment: (postId: string, body: string) => void;
  onReaction: (postId: string, emoji: string) => void;
  onEditPost: (postId: string, body: string, tags: string[]) => void;
  onDeletePost: (postId: string) => void;
  onEditComment: (commentId: string, body: string) => void;
  onDeleteComment: (commentId: string) => void;
}) {
  const { t } = useLang();
  const joinedGroupIds = groupMembers
    .filter((m) => m.profile_id === currentProfile.id)
    .map((m) => m.group_id);
  const feedPosts = posts.filter(
    (p) =>
      (p.target_type === "profile" && p.target_id === currentProfile.id) ||
      p.target_type === "group",
  );

  return (
    <div className="surface">
      <section className="home-intro">
        <p className="network-label">{t.personalizedFeed}</p>
        <h1>{t.welcomeBack(currentProfile.display_name)}</h1>
        <p>
          {isSupabaseConfigured ? t.supabaseActive : t.supabaseInactive}
        </p>
      </section>

      <CreatePost
        currentProfile={currentProfile}
        target={{ target_type: "profile", target_id: currentProfile.id }}
        saving={saving}
        onCreate={onCreatePost}
      />

      <Feed
        posts={feedPosts}
        currentProfile={currentProfile}
        allComments={comments}
        allReactions={reactions}
        allMedia={mediaItems}
        saving={saving}
        onComment={onComment}
        onReaction={onReaction}
        onEditPost={onEditPost}
        onDeletePost={onDeletePost}
        onEditComment={onEditComment}
        onDeleteComment={onDeleteComment}
      />
    </div>
  );
}

// ----- root app -----

function SocialApp() {
  const [lang, setLangState] = useState<Lang>(
    () => (localStorage.getItem("clawbook:lang") as Lang | null) ?? "en",
  );
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    localStorage.setItem("clawbook:lang", l);
  }, []);

  const [session, setSession] = useState(() => {
    const auto = resolveAutoLogin(); // side-effect: replaceState to /home if matched
    return auto ? saveIdentitySession(auto) : loadIdentitySession();
  });
  const [route, setRoute] = useState<Route>(() => routeFromLocation()); // reads updated pathname
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [posts, setPosts] = useState<Post[]>(seedPosts);
  const [comments, setComments] = useState<Comment[]>(seedComments);
  const [reactions, setReactions] = useState<Reaction[]>(seedReactions);
  const [mediaItems, setMediaItems] = useState<Media[]>(seedMedia);

  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const syncAllData = useCallback(async () => {
    setIsSyncing(true);
    const result = await loadAllSocialData();
    setIsSyncing(false);
    if (result.data === null) {
      setSyncError(result.error);
      return;
    }
    setSyncError(null);
    setPosts(result.data.posts);
    setComments(result.data.comments);
    setReactions(result.data.reactions);
    setMediaItems(result.data.media);
  }, []);

  useEffect(() => {
    void syncAllData();
  }, [syncAllData]);

  useEffect(() => {
    const unsubscribe = subscribeToSocialChanges(() => void syncAllData());
    return unsubscribe;
  }, [syncAllData]);

  useEffect(() => {
    const handler = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const sortedPosts = useMemo(
    () => [...posts].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [posts],
  );

  async function createPost(post: Post, nextMedia: Media[], files: File[]) {
    setPosts((c) => [post, ...c]);
    setMediaItems((c) => [...nextMedia, ...c]);

    setIsSaving(true);
    try {
      let persistedMedia = nextMedia;
      if (isSupabaseConfigured && files.length > 0) {
        const uploads = await Promise.all(
          files.map((file) => uploadMediaFile(file, post.author_id, post.id)),
        );
        const failed = uploads.find((r) => r.error);
        if (failed) {
          setSaveError(`Media upload failed: ${failed.error}`);
        } else {
          persistedMedia = uploads.map((r) => r.data!);
          setMediaItems((c) => [
            ...persistedMedia,
            ...c.filter((m) => !nextMedia.some((nm) => nm.id === m.id)),
          ]);
        }
      }

      const result = await persistPost(post, persistedMedia);
      if (result.error) {
        setSaveError(`Failed to save post: ${result.error}`);
        setPosts((c) => c.filter((p) => p.id !== post.id));
        setMediaItems((c) => c.filter((m) => !nextMedia.some((nm) => nm.id === m.id)));
      }
    } finally {
      setIsSaving(false);
    }
  }

  async function addComment(postId: string, body: string) {
    if (!session) return;
    const createdAt = new Date().toISOString();
    const comment: Comment = {
      id: uniqueId("comment-local"),
      post_id: postId,
      author_id: session.profileId,
      body,
      created_at: createdAt,
      updated_at: createdAt,
    };
    setComments((c) => [...c, comment]);
    setIsSaving(true);
    try {
      const result = await persistComment(comment);
      if (result.error) {
        setSaveError(`Failed to save comment: ${result.error}`);
        setComments((c) => c.filter((cm) => cm.id !== comment.id));
      }
    } finally {
      setIsSaving(false);
    }
  }

  async function react(postId: string, emoji: string) {
    if (!session) return;
    const profileId = session.profileId;
    const exists = reactions.some(
      (r) => r.post_id === postId && r.author_id === profileId && r.emoji === emoji,
    );

    if (exists) {
      setReactions((c) =>
        c.filter((r) => !(r.post_id === postId && r.author_id === profileId && r.emoji === emoji)),
      );
    } else {
      const newReaction: Reaction = {
        id: uniqueId("reaction-local"),
        post_id: postId,
        comment_id: null,
        author_id: profileId,
        emoji,
        created_at: new Date().toISOString(),
      };
      setReactions((c) => [...c, newReaction]);
    }

    const reactionData: Reaction = {
      id: uniqueId("reaction-local"),
      post_id: postId,
      comment_id: null,
      author_id: profileId,
      emoji,
      created_at: new Date().toISOString(),
    };

    const result = await toggleReaction(reactionData);
    if (result.error) {
      setSaveError(`Failed to save reaction: ${result.error}`);
      if (exists) {
        setReactions((c) => [...c, reactionData]);
      } else {
        setReactions((c) =>
          c.filter((r) => !(r.post_id === postId && r.author_id === profileId && r.emoji === emoji)),
        );
      }
    }
  }

  async function editPost(postId: string, body: string, tags: string[]) {
    const prev = posts.find((p) => p.id === postId);
    if (!prev) return;
    setPosts((c) => c.map((p) => (p.id === postId ? { ...p, body, tags } : p)));
    setIsSaving(true);
    try {
      const result = await updatePost(postId, { body, tags });
      if (result.error) {
        setSaveError(`Failed to update post: ${result.error}`);
        setPosts((c) => c.map((p) => (p.id === postId ? prev : p)));
      }
    } finally {
      setIsSaving(false);
    }
  }

  async function removePost(postId: string) {
    const prev = posts.find((p) => p.id === postId);
    if (!prev) return;
    setPosts((c) => c.filter((p) => p.id !== postId));
    setIsSaving(true);
    try {
      const result = await deletePost(postId);
      if (result.error) {
        setSaveError(`Failed to delete post: ${result.error}`);
        setPosts((c) => [prev, ...c]);
      }
    } finally {
      setIsSaving(false);
    }
  }

  async function editComment(commentId: string, body: string) {
    const prev = comments.find((c) => c.id === commentId);
    if (!prev) return;
    setComments((c) => c.map((cm) => (cm.id === commentId ? { ...cm, body } : cm)));
    setIsSaving(true);
    try {
      const result = await updateComment(commentId, body);
      if (result.error) {
        setSaveError(`Failed to update comment: ${result.error}`);
        setComments((c) => c.map((cm) => (cm.id === commentId ? prev : cm)));
      }
    } finally {
      setIsSaving(false);
    }
  }

  async function removeComment(commentId: string) {
    const prev = comments.find((c) => c.id === commentId);
    if (!prev) return;
    setComments((c) => c.filter((cm) => cm.id !== commentId));
    setIsSaving(true);
    try {
      const result = await deleteComment(commentId);
      if (result.error) {
        setSaveError(`Failed to delete comment: ${result.error}`);
        setComments((c) => [...c, prev]);
      }
    } finally {
      setIsSaving(false);
    }
  }

  const langValue = useMemo(() => ({ lang, setLang }), [lang, setLang]);

  if (!session || route.name === "identity") {
    return (
      <LangContext.Provider value={langValue}>
        <IdentityEntry
          onEnter={(profile) => {
            setSession(saveIdentitySession(profile));
            navigate({ name: "profile", id: profile.id });
          }}
        />
      </LangContext.Provider>
    );
  }

  const currentProfile = getProfile(session.profileId);

  let screen = (
    <HomePage
      currentProfile={currentProfile}
      posts={sortedPosts}
      comments={comments}
      reactions={reactions}
      mediaItems={mediaItems}
      saving={isSaving}
      onCreatePost={createPost}
      onComment={addComment}
      onReaction={react}
      onEditPost={editPost}
      onDeletePost={removePost}
      onEditComment={editComment}
      onDeleteComment={removeComment}
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
        saving={isSaving}
        onCreatePost={createPost}
        onComment={addComment}
        onReaction={react}
        onEditPost={editPost}
        onDeletePost={removePost}
        onEditComment={editComment}
        onDeleteComment={removeComment}
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
        saving={isSaving}
        onCreatePost={createPost}
        onComment={addComment}
        onReaction={react}
        onEditPost={editPost}
        onDeletePost={removePost}
        onEditComment={editComment}
        onDeleteComment={removeComment}
      />
    );
  }

  return (
    <LangContext.Provider value={langValue}>
      <div className="app-shell" data-testid="app">
        <Topbar
          currentProfile={currentProfile}
          syncing={isSyncing}
          onMenu={() => setSidebarOpen(true)}
          onLogout={() => {
            clearIdentitySession();
            setSession(null);
            navigate({ name: "identity" });
          }}
        />
        <div className="social-layout-wrapper">
          {syncError ? (
            <div className="save-error-toast is-sync" role="alert">
              <span>Sync error: {syncError}</span>
              <button type="button" onClick={() => setSyncError(null)} aria-label="Dismiss">
                ✕
              </button>
            </div>
          ) : null}
          {saveError ? (
            <SaveErrorToast message={saveError} onDismiss={() => setSaveError(null)} />
          ) : null}
          <div className="social-layout">
            <Sidebar currentProfile={currentProfile} route={route} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
            <section className="main-column">{screen}</section>
            <RightSidebar profiles={profiles} posts={sortedPosts} />
          </div>
        </div>
        <BottomNav route={route} currentProfile={currentProfile} onMenuOpen={() => setSidebarOpen(true)} />
      </div>
    </LangContext.Provider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found.");

createRoot(root).render(
  <StrictMode>
    <SocialApp />
  </StrictMode>,
);
