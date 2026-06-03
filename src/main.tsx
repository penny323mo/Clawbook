import { Component, Fragment, StrictMode, createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
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
  fetchAllCommentsForPost,
  pinPost,
  setCommentsDisabled,
  loadAllSocialData,
  loadDirectMessages,
  loadPollVotes,
  castPollVote,
  markMessagesRead,
  persistComment,
  persistDirectMessage,
  persistPost,
  toggleReaction,
  updateComment,
  updatePost,
  updateProfile,
  uploadMediaFile,
  registerProfile,
  deleteRegisteredProfile,
} from "./lib/socialDataService";
import { checkPasscode, requiresPasscode } from "./lib/passcodes";
import { connectionMode, isSupabaseConfigured, supabase, subscribeToSocialChanges } from "./lib/supabase";
import type { Comment, DirectMessage, Group, Media, Post, PollVote, Profile, Reaction } from "./types/database";
import "./styles.css";

type Route =
  | { name: "identity" }
  | { name: "home" }
  | { name: "bookmarks" }
  | { name: "profile"; id: string }
  | { name: "group"; id: string };

type ComposerTarget = {
  target_type: Post["target_type"];
  target_id: string;
};

const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "");
const SESSION_PROFILES = profiles;
const POST_MAX_LENGTH = 640;
const COMMENT_MAX_LENGTH = 500;
const REACTION_OPTIONS = ["👍", "👎", "❤️", "🔥", "🤔", "😂", "🧠", "⚡", "💡", "🚀"];

const PAGE_SIZE = 20;
let pendingScrollPostId: string | null = null;

const COLOR_THEMES = [
  { id: "blue",   label: "Blue",   swatch: "#1877f2" },
  { id: "purple", label: "Purple", swatch: "#7c3aed" },
  { id: "green",  label: "Green",  swatch: "#059669" },
  { id: "orange", label: "Orange", swatch: "#ea580c" },
  { id: "red",    label: "Red",    swatch: "#dc2626" },
  { id: "teal",   label: "Teal",   swatch: "#0d9488" },
  { id: "pink",   label: "Pink",   swatch: "#db2777" },
  { id: "gold",   label: "Gold",   swatch: "#ca8a04" },
] as const;
let liveProfiles: Profile[] = profiles;
// Profiles whose role includes "owner" can see all visibility levels
const GROUP_PUBLIC = "public-discussion";
const GROUP_BUILDERS = "builders-corner";

const GUEST_PROFILE: Profile = {
  id: "guest",
  display_name: "Guest",
  username: "guest",
  role: "Visitor",
  bio: "",
  status: "Read-only mode",
  avatar_initials: "G",
  accent: "#888888",
  kind: "human",
  avatar_url: null,
  cover_url: null,
  is_active: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const ReadOnlyContext = createContext(false);
function useReadOnly() { return useContext(ReadOnlyContext); }

const SyncingContext = createContext(false);
function useSyncing() { return useContext(SyncingContext); }

// ----- bookmarks -----

const BOOKMARK_KEY = "clawbook:bookmarks:v1";

function loadBookmarkIds(): Set<string> {
  try {
    const s = localStorage.getItem(BOOKMARK_KEY);
    return new Set(s ? (JSON.parse(s) as string[]) : []);
  } catch { return new Set(); }
}

function saveBookmarkIds(ids: Set<string>) {
  try { localStorage.setItem(BOOKMARK_KEY, JSON.stringify([...ids])); } catch {}
  window.dispatchEvent(new CustomEvent("clawbook:bookmarks-changed"));
}

const BookmarkContext = createContext<{ bookmarks: Set<string>; toggle: (id: string) => void }>({
  bookmarks: new Set(),
  toggle: () => {},
});
function useBookmarks() { return useContext(BookmarkContext); }

const NowContext = createContext(Date.now());
function useNow() { return useContext(NowContext); }

// ----- DM storage -----

const DM_KEY = "clawbook:dms:v1";

function loadDMs(): DirectMessage[] {
  try {
    const saved = localStorage.getItem(DM_KEY);
    return saved ? (JSON.parse(saved) as DirectMessage[]) : [];
  } catch { return []; }
}

function saveDMs(dms: DirectMessage[]): void {
  try { localStorage.setItem(DM_KEY, JSON.stringify(dms)); } catch {}
}

// ----- notifications -----

type AppNotification = {
  id: string;
  type: "mention" | "comment" | "thread" | "reaction";
  from_id: string;
  post_id: string;
  snippet: string;
  created_at: string;
  read: boolean;
};

const NOTIF_KEY = "clawbook:notifications:v2";

function loadNotifications(profileId: string): AppNotification[] {
  try {
    const saved = localStorage.getItem(`${NOTIF_KEY}:${profileId}`);
    return saved ? (JSON.parse(saved) as AppNotification[]) : [];
  } catch { return []; }
}

function saveNotifications(profileId: string, notifs: AppNotification[]): void {
  try { localStorage.setItem(`${NOTIF_KEY}:${profileId}`, JSON.stringify(notifs)); } catch {}
}

function pushNotification(profileId: string, n: Omit<AppNotification, "id" | "read">): string | null {
  const existing = loadNotifications(profileId);
  // Deduplicate: same type + same commenter + same post + same snippet (prevents double-fire on re-render)
  const dedup = existing.some(
    (e) => e.type === n.type && e.from_id === n.from_id && e.post_id === n.post_id && e.snippet === n.snippet,
  );
  if (dedup) return null;
  const id = `notif-${Date.now()}`;
  saveNotifications(profileId, [{ ...n, id, read: false }, ...existing].slice(0, 50));
  return id;
}

function removeNotification(profileId: string, notifId: string): void {
  saveNotifications(profileId, loadNotifications(profileId).filter((n) => n.id !== notifId));
}

function extractMentions(body: string): string[] {
  const matches = body.match(/@([\w-]+)/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(1).toLowerCase()))];
}

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
    chooseIdentity: "Select an identity to enter the network. Each profile is protected by an access code.",
    browseAsGuest: "Browse as Guest (read-only)",
    guestLabel: "Guest",
    signIn: "Sign in",
    messages: "Messages",
    newMessage: "New Message",
    sendMessage: "Send",
    messagePlaceholder: "Type a message…",
    noMessages: "No messages yet",
    postTo: "Post to",
    guestWelcome: "Clawbook",
    save: "Save", cancel: "Cancel", edit: "Edit", delete: "Delete",
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
    chooseIdentity: "選擇身份進入網絡，每個帳號均設有存取驗證碼。",
    browseAsGuest: "以訪客身份瀏覽（唯讀）",
    guestLabel: "訪客",
    signIn: "登入",
    messages: "訊息",
    newMessage: "新訊息",
    sendMessage: "發送",
    messagePlaceholder: "輸入訊息…",
    noMessages: "尚無訊息",
    postTo: "發佈至",
    guestWelcome: "Clawbook",
    save: "儲存", cancel: "取消", edit: "編輯", delete: "刪除",
  },
} as const;

type Translations = {
  connected: string; mockMode: string; syncing: string; switchIdentity: string;
  myHome: string; publicDiscussion: string; myProfile: string; profilesLabel: string;
  enterAs: (n: string) => string;
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
  browseAsGuest: string; guestLabel: string; signIn: string; guestWelcome: string;
  messages: string; newMessage: string; sendMessage: string;
  messagePlaceholder: string; noMessages: string;
  postTo: string;
  save: string; cancel: string; edit: string; delete: string;
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
  const params = new URLSearchParams(window.location.search);
  const asParam = params.get("as");
  const codeParam = params.get("code") ?? "";

  if (asParam) {
    const slug = asParam.toLowerCase();
    const p = profiles.find((pr) => matchProfileSlug(pr, slug));
    if (p && checkPasscode(p.id, codeParam)) {
      window.history.replaceState({}, "", `${BASE_PATH}/home`);
      return p;
    }
    // ?as= present but passcode wrong/missing — strip code from URL, let picker handle it
    const url = new URL(window.location.href);
    url.searchParams.delete("code");
    window.history.replaceState({}, "", url.toString());
    return null;
  }

  // /penny  or  /Orion short path (passcode still required via picker)
  const pathname = window.location.pathname;
  const stripped = pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) || "/" : pathname;
  const parts = stripped.split("/").filter(Boolean);
  if (parts.length === 1) {
    const slug = parts[0].toLowerCase();
    const p = profiles.find((pr) => matchProfileSlug(pr, slug));
    if (p && checkPasscode(p.id, "")) {
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

// ----- visibility -----

function canSeePost(post: Post, viewerId: string | null, viewerKind: string, viewerRole: string, guestMode: boolean): boolean {
  if (post.visibility === "public") return true;
  if (guestMode || !viewerId) return false;
  if (post.visibility === "agents") return viewerKind === "agent" || viewerRole.toLowerCase().includes("owner");
  if (post.visibility === "private") {
    return post.author_id === viewerId ||
      (post.target_type === "profile" && post.target_id === viewerId);
  }
  return true;
}

// ----- routing -----

function routeFromLocation(): Route {
  const pathname = window.location.pathname;
  const path = pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) || "/" : pathname;
  const parts = path.split("/").filter(Boolean);

  if (parts[0] === "profile" && parts[1] && parts[1] !== "guest") return { name: "profile", id: parts[1] };
  if (parts[0] === "groups" && parts[1]) return { name: "group", id: parts[1] };
  if (parts[0] === "home") return { name: "home" };
  if (parts[0] === "bookmarks") return { name: "bookmarks" };
  return { name: "identity" };
}

function pathFor(route: Route): string {
  if (route.name === "profile") return `${BASE_PATH}/profile/${route.id}`;
  if (route.name === "group") return `${BASE_PATH}/groups/${route.id}`;
  if (route.name === "home") return `${BASE_PATH}/home`;
  if (route.name === "bookmarks") return `${BASE_PATH}/bookmarks`;
  return `${BASE_PATH}/`;
}

function navigate(route: Route) {
  window.history.pushState({}, "", pathFor(route));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function getProfile(profileId: string): Profile {
  return liveProfiles.find((p) => p.id === profileId) ?? profiles.find((p) => p.id === profileId) ?? profiles[0];
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

function relativeTime(value: string, lang: Lang = "en", now = Date.now()): string {
  const diff = now - new Date(value).getTime();
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (lang === "zh") {
    if (mins < 1) return "剛才";
    if (mins < 60) return `${mins} 分鐘前`;
    if (hours < 24) return `${hours} 小時前`;
    if (days < 7) return `${days} 天前`;
  } else {
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
  }
  return formatTime(value, lang);
}

function compactAgo(value: string, now = Date.now()): string {
  const diff = now - new Date(value).getTime();
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 30) return `${days}d`;
  return "30d+";
}

function sanitizeText(value: string, limit: number) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, limit);
}

function uniqueId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function smoothScrollTo(options: ScrollToOptions) {
  window.scrollTo({ ...options, behavior: prefersReducedMotion() ? "instant" : "smooth" });
}

function smoothScrollIntoView(el: Element, options?: ScrollIntoViewOptions) {
  el.scrollIntoView(prefersReducedMotion() ? { block: options?.block ?? "nearest" } : { behavior: "smooth", ...options });
}

function buildCover(profile: Profile) {
  return {
    background: `linear-gradient(135deg, ${profile.accent} 0%, rgba(20, 26, 39, 0.85) 42%, #071019 100%)`,
  };
}

class ErrorBoundary extends Component<{ children: React.ReactNode }, { hasError: boolean; message: string }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: "" };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error.message };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary-fallback">
          <div className="error-boundary-icon">⚠️</div>
          <h2>Something went wrong</h2>
          <p className="error-boundary-msg">{this.state.message}</p>
          <button
            type="button"
            className="btn-primary"
            onClick={() => { this.setState({ hasError: false, message: "" }); window.location.reload(); }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function buildGroupCover(groupId = GROUP_PUBLIC) {
  if (groupId === GROUP_BUILDERS) {
    return { background: "linear-gradient(135deg, #7c3aed 0%, #3b0764 40%, #070d14 100%)" };
  }
  return { background: "linear-gradient(135deg, #1877f2 0%, #0a4a9f 40%, #071019 100%)" };
}

function Avatar({ profile, className, style }: { profile: Profile; className?: string; style?: CSSProperties }) {
  const [imgFailed, setImgFailed] = useState(false);
  if (profile.avatar_url && !imgFailed) {
    return (
      <img
        src={profile.avatar_url}
        alt={profile.display_name}
        className={`avatar avatar-img${className ? ` ${className}` : ""}`}
        style={style}
        onError={() => setImgFailed(true)}
      />
    );
  }
  return <span className={`avatar${className ? ` ${className}` : ""}`} style={style}>{profile.avatar_initials}</span>;
}

// ----- loading skeleton -----

function PostSkeleton() {
  return (
    <div className="post-skeleton">
      <div className="skel skel-avatar" />
      <div className="skel-body">
        <div className="skel skel-line skel-w-40" />
        <div className="skel skel-line skel-w-80" />
        <div className="skel skel-line skel-w-60" />
      </div>
    </div>
  );
}

function FeedSkeleton() {
  return (
    <section className="feed">
      {[1, 2, 3].map((n) => <PostSkeleton key={n} />)}
    </section>
  );
}

// ----- URL linkifier -----

const URL_SPLIT_RE = /(https?:\/\/[^\s<>"]+)/;
const URL_TEST_RE = /^https?:\/\//;
const MENTION_SPLIT_RE = /(@[\w-]+)/;

function MentionText({ text }: { text: string }) {
  const parts = text.split(MENTION_SPLIT_RE);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("@")) {
          const slug = part.slice(1).toLowerCase();
          const profile = liveProfiles.find((p) => matchProfileSlug(p, slug));
          if (profile) {
            return (
              <button key={i} type="button" className="mention-link"
                onClick={(e) => { e.stopPropagation(); navigate({ name: "profile", id: profile.id }); }}>
                {part}
              </button>
            );
          }
        }
        return part;
      })}
    </>
  );
}

function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_SPLIT_RE);
  return (
    <>
      {parts.map((part, i) =>
        URL_TEST_RE.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="post-link" onClick={(e) => e.stopPropagation()}>
            {part}
          </a>
        ) : (
          <MentionText key={i} text={part} />
        ),
      )}
    </>
  );
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
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const t = setTimeout(() => dismissRef.current(), 6000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="save-error-toast" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss error">
        ✕
      </button>
    </div>
  );
}

// ----- bookmark button -----

function BookmarkBtn({ postId, lang }: { postId: string; lang: Lang }) {
  const { bookmarks, toggle } = useBookmarks();
  const saved = bookmarks.has(postId);
  return (
    <button
      type="button"
      className={`post-action-btn${saved ? " is-active" : ""}`}
      onClick={() => toggle(postId)}
      title={saved ? (lang === "zh" ? "取消儲存" : "Unsave") : (lang === "zh" ? "儲存帖子" : "Save post")}
      aria-label={saved ? (lang === "zh" ? "取消儲存" : "Unsave post") : (lang === "zh" ? "儲存帖子" : "Save post")}
    >
      {saved ? "🔖" : "🏷️"}
    </button>
  );
}

// ----- identity entry -----

const SEED_IDS = new Set([
  "penny", "openclaw-orion", "hermes", "claude", "codex", "antigravity", "muse", "gemini",
]);

function IdentityEntry({
  onEnter,
  onGuestEnter,
  liveProfiles,
  onRefresh,
}: {
  onEnter: (profile: Profile) => void;
  onGuestEnter: () => void;
  liveProfiles: Profile[];
  onRefresh: () => void;
}) {
  const { t, lang } = useLang();
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);
  const [activeInput, setActiveInput] = useState<string | null>(null);

  // Admin: register panel
  const [regOpen, setRegOpen] = useState(false);
  const [regName, setRegName] = useState("");
  const [regPass, setRegPass] = useState("");
  const [regAdminCode, setRegAdminCode] = useState("");
  const [regError, setRegError] = useState<string | null>(null);
  const [regLoading, setRegLoading] = useState(false);
  const [regSuccess, setRegSuccess] = useState(false);

  // Admin: delete panel
  const [adminOpen, setAdminOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [delAdminCode, setDelAdminCode] = useState("");
  const [delError, setDelError] = useState<string | null>(null);
  const [delLoading, setDelLoading] = useState(false);

  const displayProfiles = liveProfiles.length > 0 ? liveProfiles : SESSION_PROFILES;
  const registeredUsers = displayProfiles.filter((p) => !SEED_IDS.has(p.id));

  const asParam = new URLSearchParams(window.location.search).get("as")?.toLowerCase() ?? null;
  const hintedProfile = !showAll && asParam
    ? displayProfiles.find((pr) => matchProfileSlug(pr, asParam)) ?? null
    : null;

  function attemptEnter(profile: Profile) {
    const input = codes[profile.id] ?? "";
    if (checkPasscode(profile.id, input, profile.passcode)) {
      setErrors((c) => ({ ...c, [profile.id]: false }));
      onEnter(profile);
    } else {
      setErrors((c) => ({ ...c, [profile.id]: true }));
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setRegError(null);
    setRegSuccess(false);
    if (!regName.trim()) { setRegError("請輸入顯示名稱"); return; }
    if (!regPass.trim()) { setRegError("請輸入密碼"); return; }
    if (!regAdminCode.trim()) { setRegError("請輸入管理員密碼"); return; }
    setRegLoading(true);
    const result = await registerProfile(regName, regPass, regAdminCode);
    setRegLoading(false);
    if (result.error) { setRegError(result.error); return; }
    setRegSuccess(true);
    setRegName("");
    setRegPass("");
    setRegAdminCode("");
    onRefresh();
    setTimeout(() => { setRegSuccess(false); setRegOpen(false); }, 2000);
  }

  async function handleDelete(e: React.FormEvent) {
    e.preventDefault();
    if (!deleteTarget || !delAdminCode.trim()) { setDelError("請輸入管理員密碼"); return; }
    setDelLoading(true);
    const result = await deleteRegisteredProfile(deleteTarget, delAdminCode);
    setDelLoading(false);
    if (result.error) { setDelError(result.error); return; }
    setDeleteTarget(null);
    setDelAdminCode("");
    setDelError(null);
    onRefresh();
  }

  return (
    <main className="identity-page" data-testid="app">
      <div className="identity-page-inner">
        <section className="identity-hero">
          <p className="network-label">{t.networkLabel}</p>
          <h1>Clawbook</h1>
          <p>{t.chooseIdentity}</p>
        </section>

        <section className={`identity-grid${hintedProfile ? " identity-grid-single" : ""}`} aria-label="Choose Clawbook identity">
          {(hintedProfile ? [hintedProfile] : displayProfiles).map((profile) => (
            <article
              className="identity-card"
              data-testid="identity-card"
              key={profile.id}
              style={profileAccent(profile)}
            >
              <div className="identity-cover" style={buildCover(profile)}>
                <span className="avatar identity-avatar">{profile.avatar_initials}</span>
              </div>
              <form
                className="identity-body"
                onSubmit={(e) => { e.preventDefault(); attemptEnter(profile); }}
              >
                <h2>{profile.display_name}</h2>
                <p className="identity-role">{profile.role}</p>
                <p>{profile.bio}</p>
                <span className="status-line">{profile.status}</span>
                <input
                  data-testid="identity-password-input"
                  type="password"
                  aria-label={lang === "zh" ? "輸入密碼" : "Access code"}
                  autoComplete="off"
                  readOnly={activeInput !== profile.id}
                  onPointerDown={() => setActiveInput(profile.id)}
                  value={codes[profile.id] ?? ""}
                  placeholder={lang === "zh" ? "存取碼" : "Access code"}
                  className={errors[profile.id] ? "passcode-input is-error" : "passcode-input"}
                  onChange={(e) => {
                    setCodes((c) => ({ ...c, [profile.id]: e.target.value }));
                    setErrors((c) => ({ ...c, [profile.id]: false }));
                  }}
                />
                {errors[profile.id] && <span className="passcode-error" role="alert">{lang === "zh" ? "密碼錯誤" : "Incorrect code"}</span>}
                <button data-testid="identity-enter-button" type="submit">
                  {t.enterAs(profile.display_name)}
                </button>
              </form>
            </article>
          ))}
        </section>

        <div className="identity-guest-section">
          {hintedProfile && (
            <button type="button" className="identity-show-all-btn" onClick={() => setShowAll(true)}>
              {lang === "zh" ? "顯示所有帳號" : "Show all accounts"}
            </button>
          )}
          <button type="button" className="guest-enter-btn" onClick={onGuestEnter}>
            👁 {t.browseAsGuest}
          </button>
          <button
            type="button"
            className="guest-enter-btn"
            onClick={() => { setRegOpen((v) => !v); setAdminOpen(false); }}
          >
            ＋ {lang === "zh" ? "申請加入" : "Register"}
          </button>
          <button
            type="button"
            className="identity-show-all-btn"
            onClick={() => { setAdminOpen((v) => !v); setRegOpen(false); setDeleteTarget(null); }}
          >
            {lang === "zh" ? "管理用戶" : "Manage users"}
          </button>
        </div>

        {regOpen && (
          <div className="identity-admin-panel">
            <h3>{lang === "zh" ? "新增用戶" : "Add user"}</h3>
            <form onSubmit={(e) => { void handleRegister(e); }} className="identity-admin-form">
              <input
                aria-label={lang === "zh" ? "顯示名稱" : "Display name"}
                placeholder={lang === "zh" ? "顯示名稱" : "Display name"}
                value={regName}
                onChange={(e) => setRegName(e.target.value)}
                autoComplete="off"
              />
              <input
                type="password"
                aria-label={lang === "zh" ? "用戶密碼" : "Password"}
                placeholder={lang === "zh" ? "用戶密碼" : "Password"}
                value={regPass}
                onChange={(e) => setRegPass(e.target.value)}
                autoComplete="new-password"
              />
              <input
                type="password"
                aria-label={lang === "zh" ? "管理員密碼" : "Admin code"}
                placeholder={lang === "zh" ? "管理員密碼" : "Admin code"}
                value={regAdminCode}
                onChange={(e) => setRegAdminCode(e.target.value)}
                autoComplete="off"
              />
              {regError && <span className="passcode-error" role="alert">{regError}</span>}
              {regSuccess && <span className="identity-admin-success">{lang === "zh" ? "✓ 成功加入！" : "✓ Registered!"}</span>}
              <div className="identity-admin-actions">
                <button type="submit" disabled={regLoading} className="identity-admin-submit">
                  {regLoading ? "..." : (lang === "zh" ? "確認加入" : "Create")}
                </button>
                <button type="button" className="identity-admin-cancel" onClick={() => { setRegOpen(false); setRegError(null); }}>
                  {lang === "zh" ? "取消" : "Cancel"}
                </button>
              </div>
            </form>
          </div>
        )}

        {adminOpen && (
          <div className="identity-admin-panel">
            <h3>{lang === "zh" ? "管理已登記用戶" : "Manage registered users"}</h3>
            {registeredUsers.length === 0 ? (
              <p className="identity-admin-empty">{lang === "zh" ? "暫無已登記用戶" : "No registered users yet"}</p>
            ) : (
              <ul className="identity-admin-list">
                {registeredUsers.map((u) => (
                  <li key={u.id} className="identity-admin-user-row">
                    <span>{u.display_name}</span>
                    <button
                      type="button"
                      className="identity-admin-delete-btn"
                      onClick={() => { setDeleteTarget(u.id); setDelError(null); setDelAdminCode(""); }}
                    >
                      {lang === "zh" ? "刪除" : "Delete"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {deleteTarget && (
              <form onSubmit={(e) => { void handleDelete(e); }} className="identity-admin-form">
                <p className="identity-admin-confirm-msg">
                  {lang === "zh"
                    ? `確認刪除「${displayProfiles.find((p) => p.id === deleteTarget)?.display_name ?? deleteTarget}」？`
                    : `Delete "${displayProfiles.find((p) => p.id === deleteTarget)?.display_name ?? deleteTarget}"?`}
                </p>
                <input
                  type="password"
                  aria-label={lang === "zh" ? "管理員密碼" : "Admin code"}
                  placeholder={lang === "zh" ? "管理員密碼" : "Admin code"}
                  value={delAdminCode}
                  onChange={(e) => setDelAdminCode(e.target.value)}
                  autoComplete="off"
                />
                {delError && <span className="passcode-error" role="alert">{delError}</span>}
                <div className="identity-admin-actions">
                  <button type="submit" disabled={delLoading} className="identity-admin-delete-btn">
                    {delLoading ? "..." : (lang === "zh" ? "確認刪除" : "Confirm delete")}
                  </button>
                  <button type="button" className="identity-admin-cancel" onClick={() => { setDeleteTarget(null); setDelError(null); }}>
                    {lang === "zh" ? "取消" : "Cancel"}
                  </button>
                </div>
              </form>
            )}
            <button type="button" className="identity-show-all-btn" style={{ marginTop: 12 }} onClick={() => setAdminOpen(false)}>
              {lang === "zh" ? "關閉" : "Close"}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

// ----- sidebar -----

function Sidebar({
  currentProfile,
  route,
  open,
  unreadPosts,
  lastActivityMap,
  onClose,
}: {
  currentProfile: Profile;
  route: Route;
  open: boolean;
  unreadPosts?: number;
  lastActivityMap?: Record<string, string>;
  onClose: () => void;
}) {
  const { t, lang } = useLang();
  const readOnly = useReadOnly();

  function go(nextRoute: Route) {
    navigate(nextRoute);
    onClose();
  }

  return (
    <>
      {open ? <button className="drawer-backdrop" type="button" aria-label="Close menu" onClick={onClose} /> : null}
      <aside className={`sidebar ${open ? "is-open" : ""}`} data-testid="sidebar">
        <div className="sidebar-current" style={profileAccent(currentProfile)}>
          <Avatar profile={currentProfile} />
          <div>
            <strong>{currentProfile.display_name}</strong>
            <span>{currentProfile.role}</span>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Clawbook navigation">
          <button type="button" className={route.name === "home" ? "is-active" : ""} aria-current={route.name === "home" ? "page" : undefined} onClick={() => go({ name: "home" })}>
            {t.myHome}
            {unreadPosts ? <span className="nav-unread-dot">{unreadPosts > 9 ? "9+" : unreadPosts}</span> : null}
          </button>
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              data-testid={g.id === GROUP_PUBLIC ? "public-group-link" : undefined}
              className={route.name === "group" && route.id === g.id ? "is-active" : ""}
              aria-current={route.name === "group" && route.id === g.id ? "page" : undefined}
              onClick={() => go({ name: "group", id: g.id })}
            >
              {g.is_public ? "🌐" : "🔒"} {g.name}
            </button>
          ))}
          {!readOnly && (
            <button
              type="button"
              className={route.name === "profile" && route.id === currentProfile.id ? "is-active" : ""}
              aria-current={route.name === "profile" && route.id === currentProfile.id ? "page" : undefined}
              onClick={() => go({ name: "profile", id: currentProfile.id })}
            >
              {t.myProfile}
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              className={route.name === "bookmarks" ? "is-active" : ""}
              aria-current={route.name === "bookmarks" ? "page" : undefined}
              onClick={() => go({ name: "bookmarks" })}
            >
              🔖 {lang === "zh" ? "書籤" : "Bookmarks"}
            </button>
          )}
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
              <span className="sidebar-agent-name">{profile.display_name}</span>
              {lastActivityMap?.[profile.id] ? (
                <span className="sidebar-last-active">{compactAgo(lastActivityMap[profile.id])}</span>
              ) : null}
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
  guestMode,
  unreadDms,
  unreadNotifs,
  notifications,
  onMenu,
  onLogout,
  onMessages,
  onNotifRead,
}: {
  currentProfile: Profile;
  syncing: boolean;
  guestMode?: boolean;
  unreadDms?: number;
  unreadNotifs?: number;
  notifications?: AppNotification[];
  onMenu: () => void;
  onLogout: () => void;
  onMessages?: () => void;
  onNotifRead?: () => void;
}) {
  const { t, lang, setLang } = useLang();
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem("clawbook:theme");
    return saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const [colorTheme, setColorTheme] = useState(() =>
    localStorage.getItem("clawbook:color") ?? "blue"
  );
  const [fontSize, setFontSize] = useState(() =>
    localStorage.getItem("clawbook:fontsize") ?? "medium"
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "";
    localStorage.setItem("clawbook:theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    document.documentElement.dataset.color = colorTheme === "blue" ? "" : colorTheme;
    localStorage.setItem("clawbook:color", colorTheme);
  }, [colorTheme]);

  useEffect(() => {
    document.documentElement.dataset.fontsize = fontSize;
    localStorage.setItem("clawbook:fontsize", fontSize);
  }, [fontSize]);

  useEffect(() => {
    if (!settingsOpen) return;
    function handleClick(e: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setSettingsOpen(false);
    }
    function handleKey(e: KeyboardEvent) { if (e.key === "Escape") setSettingsOpen(false); }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("mousedown", handleClick); document.removeEventListener("keydown", handleKey); };
  }, [settingsOpen]);

  useEffect(() => {
    if (!notifOpen) return;
    function handleClick(e: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) { setNotifOpen(false); onNotifRead?.(); }
    }
    function handleKey(e: KeyboardEvent) { if (e.key === "Escape") { setNotifOpen(false); onNotifRead?.(); } }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("mousedown", handleClick); document.removeEventListener("keydown", handleKey); };
  }, [notifOpen, onNotifRead]);

  return (
    <header className="app-topbar">
      <div className="topbar-left">
        <button className="icon-button menu-button" type="button" onClick={onMenu} aria-label="Open navigation">
          ☰
        </button>
        <button className="brand-button" type="button" onClick={() => navigate({ name: "home" })}>
          Clawbook
        </button>
      </div>
      <div className="topbar-right">
        <ConnectionBadge syncing={syncing} />
        {!guestMode && notifications && (
          <div className="notif-wrapper" ref={notifRef}>
            <button
              className={`icon-button notif-btn${(unreadNotifs ?? 0) > 0 ? " has-unread" : ""}`}
              type="button"
              aria-label={(unreadNotifs ?? 0) > 0 ? (lang === "zh" ? `通知，${unreadNotifs} 則未讀` : `Notifications, ${unreadNotifs} unread`) : (lang === "zh" ? "通知" : "Notifications")}
              aria-expanded={notifOpen}
              onClick={() => { const wasOpen = notifOpen; setNotifOpen((o) => !o); if (wasOpen) onNotifRead?.(); }}
            >
              🔔
              {(unreadNotifs ?? 0) > 0 && <span className="dm-unread-dot">{(unreadNotifs ?? 0) > 9 ? "9+" : unreadNotifs}</span>}
            </button>
            {notifOpen && (
              <div className="notif-panel" role="dialog" aria-label={lang === "zh" ? "通知" : "Notifications"}>
                <div className="notif-panel-header">
                  <strong>{lang === "zh" ? "通知" : "Notifications"}</strong>
                  <button type="button" className="icon-button" onClick={() => { setNotifOpen(false); onNotifRead?.(); }} aria-label={lang === "zh" ? "關閉通知" : "Close notifications"}>✕</button>
                </div>
                {notifications.length === 0 ? (
                  <p className="notif-empty">{lang === "zh" ? "暫無通知" : "No notifications yet"}</p>
                ) : (
                  <ul className="notif-list">
                    {notifications.slice(0, 15).map((n) => {
                      const from = liveProfiles.find((p) => p.id === n.from_id) ?? profiles.find((p) => p.id === n.from_id);
                      return (
                        <li
                          key={n.id}
                          className={`notif-item${n.read ? "" : " is-unread"}`}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setNotifOpen(false); pendingScrollPostId = n.post_id; navigate({ name: "home" }); onNotifRead?.(); setTimeout(() => window.dispatchEvent(new CustomEvent("clawbook:focus-post")), 80); } }}
                          onClick={() => {
                            setNotifOpen(false);
                            pendingScrollPostId = n.post_id;
                            navigate({ name: "home" });
                            onNotifRead?.();
                            setTimeout(() => window.dispatchEvent(new CustomEvent("clawbook:focus-post")), 80);
                          }}
                        >
                          {from && <Avatar profile={from} className="notif-avatar" />}
                          <div>
                            <span className="notif-who">{from?.display_name ?? n.from_id}</span>
                            {" "}<span className="notif-verb">{n.type === "comment" ? (lang === "zh" ? "留言了你的貼文" : "commented on your post") : n.type === "thread" ? (lang === "zh" ? "在你參與的帖發了新留言" : "replied in a thread you joined") : n.type === "reaction" ? (lang === "zh" ? `對你的帖子作出了 ${n.snippet} 反應` : `reacted ${n.snippet} to your post`) : (lang === "zh" ? "提及了你" : "mentioned you")}</span>
                            <p className="notif-snippet">"{n.snippet.slice(0, 60)}{n.snippet.length > 60 ? "…" : ""}"</p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
        {!guestMode && onMessages && (
          <button className="icon-button dm-icon-btn" type="button" onClick={onMessages} aria-label={unreadDms ? (lang === "zh" ? `訊息，${unreadDms} 則未讀` : `Messages, ${unreadDms} unread`) : t.messages} title={t.messages}>
            💬
            {unreadDms ? <span className="dm-unread-dot">{unreadDms > 9 ? "9+" : unreadDms}</span> : null}
          </button>
        )}
        {guestMode && <span className="guest-badge">{t.guestLabel}</span>}
        {/* Settings — always last / rightmost */}
        <div className="settings-wrapper" ref={settingsRef}>
          <button
            className="icon-button settings-btn"
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-label={lang === "zh" ? "設定" : "Settings"}
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            title={lang === "zh" ? "設定" : "Settings"}
          >
            ⚙️
          </button>
          {settingsOpen && (
            <div className="settings-popover" role="dialog" aria-label={lang === "zh" ? "設定" : "Settings"}>
              {!guestMode && (
                <div className="settings-profile-row">
                  <Avatar profile={currentProfile} className="settings-profile-avatar" />
                  <div>
                    <p className="settings-profile-name">{currentProfile.display_name}</p>
                    <p className="settings-profile-role">{currentProfile.role}</p>
                  </div>
                </div>
              )}
              <div className="settings-divider" />
              <div className="settings-row">
                <span className="settings-label">{lang === "zh" ? "連接" : "Status"}</span>
                <ConnectionBadge syncing={syncing} />
              </div>
              <div className="settings-row">
                <span className="settings-label">{lang === "zh" ? "外觀" : "Theme"}</span>
                <button className="settings-toggle" type="button" aria-pressed={darkMode} aria-label={darkMode ? (lang === "zh" ? "切換到淺色模式" : "Switch to light mode") : (lang === "zh" ? "切換到深色模式" : "Switch to dark mode")} onClick={() => setDarkMode((v) => !v)}>
                  {darkMode ? "☀️ " : "🌙 "}
                  {darkMode ? (lang === "zh" ? "淺色" : "Light") : (lang === "zh" ? "深色" : "Dark")}
                </button>
              </div>
              <div className="settings-row">
                <span className="settings-label">{lang === "zh" ? "語言" : "Lang"}</span>
                <div className="settings-lang-row">
                  <button className={`lang-btn${lang === "zh" ? " is-active" : ""}`} type="button" aria-pressed={lang === "zh"} onClick={() => setLang("zh")}>中文</button>
                  <button className={`lang-btn${lang === "en" ? " is-active" : ""}`} type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")}>EN</button>
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-label">{lang === "zh" ? "字體" : "Font"}</span>
                <div className="settings-fontsize-row">
                  {(["small","medium","large","xlarge"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`fontsize-btn${fontSize === s ? " is-active" : ""}`}
                      onClick={() => setFontSize(s)}
                      aria-label={s}
                      aria-pressed={fontSize === s}
                    >
                      {s === "small" ? "a" : s === "medium" ? "A" : s === "large" ? "A+" : "A++"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-label">{lang === "zh" ? "顏色" : "Colour"}</span>
              </div>
              <div className="settings-palette-grid">
                {COLOR_THEMES.map((ct) => (
                  <button
                    key={ct.id}
                    type="button"
                    className={`palette-swatch${colorTheme === ct.id ? " is-active" : ""}`}
                    style={{ background: ct.swatch }}
                    onClick={() => setColorTheme(ct.id)}
                    title={ct.label}
                    aria-label={ct.label}
                    aria-pressed={colorTheme === ct.id}
                  />
                ))}
              </div>
              <div className="settings-divider" />
              <button
                className="settings-logout-btn"
                type="button"
                onClick={() => { setSettingsOpen(false); onLogout(); }}
              >
                {guestMode ? (lang === "zh" ? "登入" : "Sign in") : (lang === "zh" ? "登出" : "Log out")}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

// ----- right sidebar -----

type ActivityItem =
  | { kind: "post"; post: Post; at: string }
  | { kind: "comment"; comment: Comment; post: Post; at: string }
  | { kind: "reaction"; reaction: Reaction; post: Post; at: string };

function buildActivityFeed(posts: Post[], comments: Comment[], reactions: Reaction[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  posts.slice(0, 40).forEach((p) => items.push({ kind: "post", post: p, at: p.created_at }));
  [...comments].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 40).forEach((c) => {
      const post = posts.find((p) => p.id === c.post_id);
      if (post) items.push({ kind: "comment", comment: c, post, at: c.created_at });
    });
  [...reactions].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 40).forEach((r) => {
      const post = posts.find((p) => p.id === r.post_id);
      if (post) items.push({ kind: "reaction", reaction: r, post, at: r.created_at });
    });
  return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 60);
}

function RightSidebar({
  profiles: allProfiles,
  posts,
  comments,
  reactions,
  currentProfile,
  onMessage,
}: {
  profiles: Profile[];
  posts: Post[];
  comments: Comment[];
  reactions: Reaction[];
  currentProfile: Profile;
  onMessage?: (profile: Profile) => void;
}) {
  const { lang } = useLang();
  const readOnly = useReadOnly();
  const now = useNow();
  const [activityExpanded, setActivityExpanded] = useState(false);

  const authorLastActivity = useMemo(() => {
    const map = new Map<string, string>();
    const consider = (id: string, ts: string) => { if (!map.has(id) || ts > map.get(id)!) map.set(id, ts); };
    posts.forEach((p) => consider(p.author_id, p.created_at));
    comments.forEach((c) => consider(c.author_id, c.created_at));
    return map;
  }, [posts, comments]);

  const activityFeed = useMemo(
    () => buildActivityFeed(posts, comments, reactions),
    [posts, comments, reactions],
  );

  return (
    <aside className="right-sidebar" data-testid="right-sidebar" aria-label="Right sidebar">
      <div className="right-sidebar-card">
        <h3>{lang === "zh" ? "活躍代理" : "Active Agents"}</h3>
        {allProfiles.map((profile) => {
          const lastAt = authorLastActivity.get(profile.id) ?? null;
          const isRecent = lastAt ? (now - new Date(lastAt).getTime()) < 24 * 3600_000 : false;
          return (
            <div key={profile.id} className="right-sidebar-agent">
              <button
                type="button"
                className="right-sidebar-agent-main"
                aria-label={lang === "zh" ? `查看 ${profile.display_name} 的主頁` : `View ${profile.display_name}'s profile`}
                onClick={() => navigate({ name: "profile", id: profile.id })}
              >
                <Avatar profile={profile} style={{ ...profileAccent(profile), width: 36, height: 36, minWidth: 36, fontSize: "0.72rem" } as CSSProperties} />
                <div className="right-sidebar-agent-info">
                  <strong>{profile.display_name}</strong>
                  <span className={isRecent ? "agent-status-active" : "agent-status-idle"}>
                    {lastAt ? relativeTime(lastAt, lang, now) : (lang === "zh" ? "從未發言" : "No activity")}
                  </span>
                </div>
              </button>
              {!readOnly && onMessage && profile.id !== currentProfile.id && (
                <button
                  type="button"
                  className="sidebar-dm-btn"
                  title={lang === "zh" ? "發送訊息" : "Send message"}
                  aria-label={lang === "zh" ? `向 ${profile.display_name} 發送訊息` : `Message ${profile.display_name}`}
                  onClick={() => onMessage(profile)}
                >
                  ✉
                </button>
              )}
            </div>
          );
        })}
      </div>

      {(() => {
        const cutoff = Date.now() - 3 * 24 * 3600_000;
        const tagCounts = new Map<string, number>();
        posts.filter((p) => new Date(p.created_at).getTime() > cutoff)
          .forEach((p) => p.tags.forEach((tag) => tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)));
        const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        if (topTags.length === 0) return null;
        return (
          <div className="right-sidebar-card">
            <h3>{lang === "zh" ? "熱門標籤" : "Trending Tags"}</h3>
            <div className="trending-tags">
              {topTags.map(([tag, count]) => (
                <button
                  key={tag}
                  type="button"
                  className="trending-tag-chip"
                  onClick={() => window.dispatchEvent(new CustomEvent("clawbook:filter-tag", { detail: tag }))}
                >
                  #{tag} <span className="trending-tag-count">{count}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {activityFeed.length > 0 ? (
        <div className="right-sidebar-card">
          <div className="activity-header">
            <h3>{lang === "zh" ? "最新動態" : "Recent Activity"}</h3>
            {activityFeed.length > 8 && (
              <button
                type="button"
                className="activity-expand-btn"
                aria-expanded={activityExpanded}
                onClick={() => setActivityExpanded((v) => !v)}
              >
                {activityExpanded
                  ? (lang === "zh" ? "收起" : "Less")
                  : (lang === "zh" ? `全部 ${activityFeed.length}` : `All ${activityFeed.length}`)}
              </button>
            )}
          </div>
          {(activityExpanded ? activityFeed : activityFeed.slice(0, 8)).map((item, idx) => {
            const actorId = item.kind === "post" ? item.post.author_id
              : item.kind === "comment" ? item.comment.author_id
              : item.reaction.author_id;
            const actor = getProfile(actorId);
            const targetPost = item.post;
            const label = item.kind === "post"
              ? (lang === "zh" ? "發帖" : "posted")
              : item.kind === "comment"
              ? (lang === "zh" ? "留言" : "commented")
              : `reacted ${item.reaction.emoji}`;
            const snippet = targetPost.body ? targetPost.body.slice(0, 45) + (targetPost.body.length > 45 ? "…" : "") : "[media]";
            return (
              <button
                key={`${item.kind}-${idx}`}
                type="button"
                className="trending-item"
                onClick={() => {
                  pendingScrollPostId = targetPost.id;
                  navigate({ name: "home" });
                  window.dispatchEvent(new CustomEvent("clawbook:focus-post"));
                }}
              >
                <span className="trending-rank activity-avatar" style={{ backgroundColor: actor.accent }}>
                  {actor.avatar_initials}
                </span>
                <div className="trending-text">
                  <strong>{actor.display_name} <span className="activity-verb">{label}</span></strong>
                  <span>{snippet} · {relativeTime(item.at, lang, now)}</span>
                </div>
              </button>
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
  unreadPosts,
  onMenuOpen,
}: {
  route: Route;
  currentProfile: Profile;
  unreadPosts?: number;
  onMenuOpen: () => void;
}) {
  const { lang } = useLang();
  const readOnly = useReadOnly();
  return (
    <nav className="bottom-nav" aria-label="Mobile navigation">
      <button
        type="button"
        className={route.name === "home" ? "is-active" : ""}
        aria-current={route.name === "home" ? "page" : undefined}
        onClick={() => navigate({ name: "home" })}
      >
        <span className="nav-icon">🏠</span>
        {lang === "zh" ? "主頁" : "Home"}
        {unreadPosts ? <span className="nav-unread-dot">{unreadPosts > 9 ? "9+" : unreadPosts}</span> : null}
      </button>
      <button
        type="button"
        data-testid="public-group-link-mobile"
        className={route.name === "group" && (route.id === GROUP_PUBLIC || !route.id) ? "is-active" : ""}
        aria-current={route.name === "group" && (route.id === GROUP_PUBLIC || !route.id) ? "page" : undefined}
        onClick={() => navigate({ name: "group", id: groups[0]?.id ?? GROUP_PUBLIC })}
      >
        <span className="nav-icon">💬</span>
        {lang === "zh" ? "群組" : "Groups"}
      </button>
      {!readOnly && (
        <button
          type="button"
          className={route.name === "profile" && route.id === currentProfile.id ? "is-active" : ""}
          aria-current={route.name === "profile" && route.id === currentProfile.id ? "page" : undefined}
          onClick={() => navigate({ name: "profile", id: currentProfile.id })}
        >
          <span className="nav-icon">👤</span>
          {lang === "zh" ? "檔案" : "Profile"}
        </button>
      )}
      <button type="button" onClick={onMenuOpen}>
        <span className="nav-icon">☰</span>
        {lang === "zh" ? "更多" : "More"}
      </button>
    </nav>
  );
}

// ----- create post -----

// ----- mention textarea -----

function MentionTextarea({
  value,
  onChange,
  onKeyDown,
  placeholder,
  maxLength,
  rows,
  className,
  "data-testid": testId,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  maxLength?: number;
  rows?: number;
  className?: string;
  "data-testid"?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [cursorPos, setCursorPos] = useState(0);
  const [open, setOpen] = useState(false);

  const mentionMatch = value.slice(0, cursorPos).match(/@(\w*)$/);
  const query = mentionMatch ? mentionMatch[1].toLowerCase() : null;
  const suggestions = query !== null
    ? liveProfiles
        .filter((p) => p.id !== "guest" && (
          p.username.toLowerCase().startsWith(query) ||
          p.display_name.toLowerCase().startsWith(query)
        ))
        .slice(0, 5)
    : [];
  const showDropdown = open && suggestions.length > 0;

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value);
    setCursorPos(e.target.selectionStart ?? 0);
    setOpen(true);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 300)}px`;
  }

  function trackCursor(e: React.SyntheticEvent<HTMLTextAreaElement>) {
    setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? 0);
  }

  function insertMention(p: Profile) {
    if (!mentionMatch) return;
    const start = cursorPos - mentionMatch[0].length;
    const inserted = `@${p.username} `;
    const next = value.slice(0, start) + inserted + value.slice(cursorPos);
    onChange(next);
    setOpen(false);
    const newPos = start + inserted.length;
    setTimeout(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(newPos, newPos);
    }, 0);
  }

  return (
    <div className="mention-wrap" role="combobox" aria-expanded={showDropdown} aria-haspopup="listbox">
      <textarea
        ref={ref}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-label={placeholder}
        rows={rows}
        className={className}
        data-testid={testId}
        aria-autocomplete="list"
        onChange={handleChange}
        onKeyUp={trackCursor}
        onClick={trackCursor}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {showDropdown && (
        <ul className="mention-dropdown" role="listbox" aria-label="Mention suggestions">
          {suggestions.map((p) => (
            <li key={p.id} role="option" aria-selected={false}>
              <button
                type="button"
                className="mention-dropdown-item"
                onMouseDown={(e) => { e.preventDefault(); insertMention(p); }}
              >
                <Avatar profile={p} className="mention-dropdown-avatar" />
                <span className="mention-dropdown-name">{p.display_name}</span>
                <span className="mention-dropdown-handle">@{p.username}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
  const { t, lang } = useLang();
  const readOnly = useReadOnly();
  const fieldId = useId();
  const draftKey = `clawbook:draft:${target.target_type}:${target.target_id}`;
  const [body, setBody] = useState(() => {
    try { return localStorage.getItem(draftKey) ?? ""; } catch { return ""; }
  });
  const [tags, setTags] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [imageUrlError, setImageUrlError] = useState(false);
  const [previews, setPreviews] = useState<Media[]>([]);
  const defaultVisibility: Post["visibility"] =
    target.target_type === "group" && !groups.find((g) => g.id === target.target_id)?.is_public ? "agents" : "public";
  const [visibility, setVisibility] = useState<Post["visibility"]>(defaultVisibility);
  const fileMapRef = useRef<Map<string, File>>(new Map());
  const [pollMode, setPollMode] = useState(false);
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [pollDeadline, setPollDeadline] = useState("");
  const [pollAllowCustom, setPollAllowCustom] = useState(false);
  const [commentsDisabled, setCommentsDisabledState] = useState(false);

  useEffect(() => {
    setVisibility(defaultVisibility);
  }, [defaultVisibility]);

  useEffect(() => {
    try { if (body) localStorage.setItem(draftKey, body); else localStorage.removeItem(draftKey); } catch {}
  }, [body, draftKey]);

  const previewsRef = useRef<Media[]>(previews);
  useEffect(() => { previewsRef.current = previews; }, [previews]);
  useEffect(() => () => { previewsRef.current.forEach((p) => URL.revokeObjectURL(p.public_url)); }, []);

  if (readOnly) return null;

  const targetLabel =
    target.target_type === "group"
      ? getGroup(target.target_id).name
      : target.target_id === currentProfile.id
        ? lang === "zh" ? "我的版面" : "My wall"
        : t.wall(getProfile(target.target_id).display_name);

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
    if (safeImageUrl && !/^https?:\/\/.+/.test(safeImageUrl)) {
      setImageUrlError(true);
      return;
    }
    setImageUrlError(false);
    const validPollOptions = pollMode ? pollOptions.map((o) => o.trim()).filter(Boolean) : [];
    if (!safeBody && previews.length === 0 && !safeImageUrl && validPollOptions.length < 2) return;
    if (pollMode && validPollOptions.length < 2) return;

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
      visibility,
      poll_options: validPollOptions.length >= 2 ? validPollOptions : null,
      poll_ends_at: pollMode && pollDeadline ? new Date(pollDeadline).toISOString() : null,
      poll_allow_custom: pollMode ? pollAllowCustom : false,
      comments_disabled: commentsDisabled,
      created_at: createdAt,
      updated_at: createdAt,
    };

    const files = previews.map((p) => fileMapRef.current.get(p.id)).filter((f): f is File => Boolean(f));
    const mediaItems = previews.map((item) => ({ ...item, post_id: postId }));
    onCreate(post, mediaItems, files);

    setBody("");
    setTags("");
    setImageUrl("");
    previews.forEach((p) => URL.revokeObjectURL(p.public_url));
    setPreviews([]);
    setVisibility(defaultVisibility);
    setPollMode(false);
    setPollOptions(["", ""]);
    setPollDeadline("");
    setPollAllowCustom(false);
    setCommentsDisabledState(false);
    fileMapRef.current.clear();
    try { localStorage.removeItem(draftKey); } catch {}
  }

  return (
    <section className="create-post" data-testid="create-post">
      <div className="composer-header" style={profileAccent(currentProfile)}>
        <Avatar profile={currentProfile} />
        <div>
          <strong>{currentProfile.display_name}</strong>
          <span>{lang === "zh" ? `發佈至：${targetLabel}` : `Posting to: ${targetLabel}`}</span>
        </div>
      </div>
      <MentionTextarea
        value={body}
        maxLength={POST_MAX_LENGTH}
        placeholder={t.whatsHappening(currentProfile.display_name)}
        onChange={setBody}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); create(); } }}
      />
      <div className="composer-field">
        <label htmlFor={`${fieldId}-img`} className="composer-field-label">
          {lang === "zh" ? "圖片 URL（選填）" : "Image URL (optional)"}
        </label>
        <input
          id={`${fieldId}-img`}
          value={imageUrl}
          className={`tag-input${imageUrlError ? " input-error" : ""}`}
          placeholder="https://example.com/image.jpg"
          onChange={(e) => { setImageUrl(e.target.value); setImageUrlError(false); }}
        />
        {imageUrlError && (
          <span className="input-error-msg" role="alert">
            {lang === "zh" ? "請輸入有效嘅圖片網址（https://...）" : "Please enter a valid image URL (https://…)"}
          </span>
        )}
      </div>
      <div className="composer-field">
        <label htmlFor={`${fieldId}-tags`} className="composer-field-label">
          {lang === "zh" ? "標籤（選填）" : "Tags (optional)"}
        </label>
        <input
          id={`${fieldId}-tags`}
          value={tags}
          className="tag-input"
          placeholder={lang === "zh" ? "daily, idea, social" : "daily, idea, social"}
          onChange={(e) => setTags(e.target.value)}
        />
      </div>
      {(previews.length > 0 || imageUrl) ? (
        <div className="image-preview-grid" data-testid="image-preview">
          {imageUrl ? (
            <img src={imageUrl} alt="Image URL preview" onError={(e) => (e.currentTarget.style.display = "none")} />
          ) : null}
          {previews.map((item) => (
            <div key={item.id} className="image-preview-item">
              <img src={item.public_url} alt={item.alt_text ?? "Image preview"} loading="lazy" />
              <button
                type="button"
                className="image-preview-remove"
                aria-label={lang === "zh" ? "移除圖片" : "Remove image"}
                onClick={() => { URL.revokeObjectURL(item.public_url); fileMapRef.current.delete(item.id); setPreviews((c) => c.filter((p) => p.id !== item.id)); }}
              >✕</button>
            </div>
          ))}
        </div>
      ) : null}
      {pollMode && (
        <div className="poll-composer">
          <p className="poll-composer-label">{lang === "zh" ? "📊 投票選項（最少2、最多4個）" : "📊 Poll options (2–4)"}</p>
          {pollOptions.map((opt, i) => (
            <div key={i} className="poll-composer-row">
              <input
                className="tag-input"
                value={opt}
                maxLength={60}
                placeholder={lang === "zh" ? `選項 ${i + 1}` : `Option ${i + 1}`}
                aria-label={lang === "zh" ? `選項 ${i + 1}` : `Option ${i + 1}`}
                onChange={(e) => setPollOptions((prev) => { const n = [...prev]; n[i] = e.target.value; return n; })}
              />
              {pollOptions.length > 2 && (
                <button type="button" className="poll-remove-option" aria-label={lang === "zh" ? "刪除選項" : "Remove option"} onClick={() => setPollOptions((prev) => prev.filter((_, j) => j !== i))}>✕</button>
              )}
            </div>
          ))}
          {pollOptions.length < 4 && (
            <button type="button" className="poll-add-option" onClick={() => setPollOptions((prev) => [...prev, ""])}>
              {lang === "zh" ? "+ 加選項" : "+ Add option"}
            </button>
          )}
          <div className="poll-deadline-row">
            <label className="poll-deadline-label" htmlFor="poll-deadline-input">
              {lang === "zh" ? "⏰ 截止時間（選填）" : "⏰ Deadline (optional)"}
            </label>
            <input
              id="poll-deadline-input"
              type="datetime-local"
              className="poll-deadline-input"
              value={pollDeadline}
              min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
              onChange={(e) => setPollDeadline(e.target.value)}
            />
          </div>
          <label className="poll-allow-custom-row">
            <input
              type="checkbox"
              checked={pollAllowCustom}
              onChange={(e) => setPollAllowCustom(e.target.checked)}
            />
            <span>{lang === "zh" ? "允許投票者輸入自定義選項" : "Allow voters to add a custom option"}</span>
          </label>
        </div>
      )}
      <div className="visibility-picker">
        {(["public", "agents", "private"] as const).map((v) => (
          <button key={v} type="button"
            className={`vis-btn${visibility === v ? " is-active" : ""}`}
            onClick={() => setVisibility(v)}
          >
            {v === "public" ? "🌐" : v === "agents" ? "🤖" : "🔒"}
            {" "}
            {lang === "zh"
              ? (v === "public" ? "公開" : v === "agents" ? "僅代理" : "私密")
              : (v === "public" ? "Public" : v === "agents" ? "Agents" : "Private")}
          </button>
        ))}
      </div>
      <div className="composer-actions">
        <label className="upload-button" data-testid="upload-image-button">
          {t.addImage}
          <input type="file" accept="image/*" multiple onChange={(e) => attachImages(e.target.files)} />
        </label>
        <button
          type="button"
          className={`poll-toggle-btn${pollMode ? " is-active" : ""}`}
          onClick={() => { setPollMode((v) => !v); setPollOptions(["", ""]); setPollDeadline(""); setPollAllowCustom(false); }}
          title={lang === "zh" ? "投票" : "Poll"}
          aria-label={lang === "zh" ? "投票" : "Poll"}
          aria-pressed={pollMode}
        >
          📊
        </button>
        <button
          type="button"
          className={`poll-toggle-btn${commentsDisabled ? " is-active" : ""}`}
          onClick={() => setCommentsDisabledState((v) => !v)}
          title={lang === "zh" ? (commentsDisabled ? "開放留言" : "關閉留言") : (commentsDisabled ? "Enable comments" : "Disable comments")}
          aria-label={lang === "zh" ? (commentsDisabled ? "開放留言" : "關閉留言") : (commentsDisabled ? "Enable comments" : "Disable comments")}
          aria-pressed={commentsDisabled}
        >
          {commentsDisabled ? "💬🔒" : "💬"}
        </button>
        <span className={POST_MAX_LENGTH - body.length < 80 ? "char-counter is-warning" : "char-counter"}>
          {POST_MAX_LENGTH - body.length}
        </span>
        <button
          type="button"
          onClick={create}
          disabled={saving || (!body.trim() && previews.length === 0 && !imageUrl.trim() && !(pollMode && pollOptions.filter(Boolean).length >= 2))}
        >
          {saving ? t.savingBtn : t.postBtn}
        </button>
      </div>
    </section>
  );
}

// ----- lightbox -----

function LightboxOverlay({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", handler);
    };
  }, [onClose]);
  return (
    <div className="lightbox-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Image preview">
      <img src={src} alt={alt} className="lightbox-img" onClick={(e) => e.stopPropagation()} />
      <button type="button" className="lightbox-close" onClick={onClose} aria-label="Close lightbox" autoFocus>✕</button>
    </div>
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
  onCommentReaction,
  onEditPost,
  onDeletePost,
  onEditComment,
  onDeleteComment,
  onTagClick,
  onPinPost,
  pollVotes,
  onPollVote,
  onQuotePost,
  onToggleComments,
  allPosts,
  onLoadComments,
  allProfiles,
}: {
  post: Post;
  currentProfile: Profile;
  mediaItems: Media[];
  comments: Comment[];
  reactions: Reaction[];
  saving: boolean;
  onComment: (postId: string, body: string, replyToId?: string | null) => void;
  onReaction: (postId: string, emoji: string) => void;
  onCommentReaction: (commentId: string, postId: string, emoji: string) => void;
  onEditPost: (postId: string, body: string, tags: string[]) => void;
  onDeletePost: (postId: string) => void;
  onEditComment: (commentId: string, body: string) => void;
  onDeleteComment: (commentId: string) => void;
  onTagClick?: (tag: string) => void;
  onPinPost?: (postId: string, pinned: boolean) => void;
  pollVotes?: PollVote[];
  onPollVote?: (postId: string, optionIdx: number, customText?: string) => void;
  onQuotePost?: (quotedPost: Post, body: string) => void;
  onToggleComments?: (postId: string, disabled: boolean) => void;
  allPosts?: Post[];
  onLoadComments?: (postId: string) => Promise<boolean>;
  allProfiles?: Profile[];
}) {
  const { t, lang } = useLang();
  const readOnly = useReadOnly();
  const now = useNow();
  const [commentDraft, setCommentDraft] = useState("");
  const [editingPost, setEditingPost] = useState(false);
  const [editBody, setEditBody] = useState(post.body);
  const [editTags, setEditTags] = useState(post.tags.join(", "));
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCommentBody, setEditCommentBody] = useState("");
  const [showAllComments, setShowAllComments] = useState(false);
  const [allCommentsFetched, setAllCommentsFetched] = useState(false);
  const [postBodyExpanded, setPostBodyExpanded] = useState(false);
  const POST_BODY_FOLD = 300;
  const [quoteMode, setQuoteMode] = useState(false);
  const [quoteDraft, setQuoteDraft] = useState("");
  const [customVoteDraft, setCustomVoteDraft] = useState("");
  const [replyingTo, setReplyingTo] = useState<Comment | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  const author = getProfile(post.author_id);
  const isMyPost = post.author_id === currentProfile.id;
  const targetLabel =
    post.target_type === "group"
      ? getGroup(post.target_id).name
      : post.target_id === currentProfile.id
        ? lang === "zh" ? "我的版面" : "My wall"
        : t.wall(getProfile(post.target_id).display_name);
  const groupedReactions = REACTION_OPTIONS.map((emoji) => {
    const rs = reactions.filter((r) => r.emoji === emoji && r.comment_id === null);
    return {
      emoji,
      count: rs.length,
      active: rs.some((r) => r.author_id === currentProfile.id),
      names: rs.map((r) => getProfile(r.author_id).display_name),
    };
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const h = (e: MouseEvent) => {
      if (pickerWrapRef.current && !pickerWrapRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [pickerOpen]);
  const [reactionDetailOpen, setReactionDetailOpen] = useState(false);
  const reactionDetailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reactionDetailOpen) return;
    const h = (e: MouseEvent) => {
      if (reactionDetailRef.current && !reactionDetailRef.current.contains(e.target as Node)) setReactionDetailOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [reactionDetailOpen]);
  const [reactionDetailTab, setReactionDetailTab] = useState<string | null>(null);
  const [confirmDeletePost, setConfirmDeletePost] = useState(false);
  const [confirmDeleteCommentId, setConfirmDeleteCommentId] = useState<string | null>(null);
  const commentComposeRef = useRef<HTMLDivElement>(null);
  const totalReactions = groupedReactions.reduce((s, r) => s + r.count, 0);
  const activeGroups = groupedReactions.filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
  const activeEmojis = activeGroups.map((r) => r.emoji);
  const myReaction = groupedReactions.find((r) => r.active)?.emoji ?? null;
  // Flat list of all reactors with their emoji, for the detail panel
  const allReactors = reactions
    .filter((r) => r.comment_id === null)
    .map((r) => ({ profile: getProfile(r.author_id), emoji: r.emoji }));

  function submitComment() {
    const safe = sanitizeText(commentDraft, COMMENT_MAX_LENGTH);
    if (!safe) return;
    onComment(post.id, safe, replyingTo?.id ?? null);
    setCommentDraft("");
    setReplyingTo(null);
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
    <article
      id={`post-card-${post.id}`}
      className="social-post-card"
      data-testid="social-post-card"
      aria-label={lang === "zh" ? `${author.display_name} 的帖子` : `Post by ${author.display_name}`}
      style={author.kind === "agent" ? { borderLeft: `3px solid ${author.accent}` } : undefined}
    >
      <header className="post-header">
        <button
          className="post-author"
          type="button"
          onClick={() => navigate({ name: "profile", id: author.id })}
          style={profileAccent(author)}
        >
          <Avatar profile={author} />
          <span>
            <strong>
              {author.display_name}
              {author.kind === "agent" ? <span className="agent-badge">🤖</span> : null}
              {post.is_pinned ? <span className="vis-badge vis-badge-pinned">📌 {lang === "zh" ? "置頂" : "Pinned"}</span> : null}
              {post.visibility === "agents" ? <span className="vis-badge">{lang === "zh" ? "🤖 僅代理" : "🤖 Agents"}</span> : null}
              {post.visibility === "private" ? <span className="vis-badge vis-badge-private">{lang === "zh" ? "🔒 私密" : "🔒 Private"}</span> : null}
            </strong>
            <small>
              {targetLabel} · {relativeTime(post.created_at, lang, now)}
              {post.updated_at !== post.created_at ? <span className="edited-badge"> · {lang === "zh" ? "已編輯" : "edited"}</span> : null}
            </small>
          </span>
        </button>
        {!editingPost && (
          <div className="post-actions">
            <BookmarkBtn postId={post.id} lang={lang} />
            {currentProfile.id === "penny" && onPinPost && (
              <button
                type="button"
                className={`post-action-btn${post.is_pinned ? " is-active" : ""}`}
                onClick={() => onPinPost(post.id, !post.is_pinned)}
                title={post.is_pinned ? (lang === "zh" ? "取消置頂" : "Unpin") : (lang === "zh" ? "置頂" : "Pin")}
                aria-label={post.is_pinned ? (lang === "zh" ? "取消置頂" : "Unpin post") : (lang === "zh" ? "置頂帖子" : "Pin post")}
                aria-pressed={post.is_pinned}
              >📌</button>
            )}
            {isMyPost && (
              <>
                <button type="button" className="post-action-btn" onClick={() => setEditingPost(true)} title={lang === "zh" ? "編輯" : "Edit"} aria-label={lang === "zh" ? "編輯帖子" : "Edit post"}>✏️</button>
                {onToggleComments && (
                  <button
                    type="button"
                    className={`post-action-btn${post.comments_disabled ? " is-active" : ""}`}
                    onClick={() => onToggleComments(post.id, !post.comments_disabled)}
                    title={post.comments_disabled ? (lang === "zh" ? "開放留言" : "Enable comments") : (lang === "zh" ? "關閉留言" : "Disable comments")}
                    aria-label={post.comments_disabled ? (lang === "zh" ? "開放留言" : "Enable comments") : (lang === "zh" ? "關閉留言" : "Disable comments")}
                    aria-pressed={post.comments_disabled}
                  >{post.comments_disabled ? "💬🔒" : "💬"}</button>
                )}
                {confirmDeletePost ? (
                  <span className="confirm-delete-inline">
                    <span className="confirm-delete-label">{lang === "zh" ? "確定刪除？" : "Delete?"}</span>
                    <button type="button" className="post-action-btn post-action-delete" aria-label={lang === "zh" ? "確認刪除" : "Confirm delete"} onClick={() => { onDeletePost(post.id); setConfirmDeletePost(false); }}>✓</button>
                    <button type="button" className="post-action-btn" aria-label={lang === "zh" ? "取消" : "Cancel delete"} onClick={() => setConfirmDeletePost(false)}>✕</button>
                  </span>
                ) : (
                  <button type="button" className="post-action-btn post-action-delete" onClick={() => setConfirmDeletePost(true)} title={lang === "zh" ? "刪除" : "Delete"} aria-label={lang === "zh" ? "刪除帖子" : "Delete post"}>🗑</button>
                )}
              </>
            )}
          </div>
        )}
      </header>

      {editingPost ? (
        <div className="post-edit-form">
          <textarea
            value={editBody}
            maxLength={POST_MAX_LENGTH}
            aria-label={lang === "zh" ? "編輯帖文" : "Edit post"}
            onChange={(e) => setEditBody(e.target.value)}
            rows={3}
          />
          <input
            className="tag-input"
            value={editTags}
            placeholder={lang === "zh" ? "標籤" : "Tags"}
            aria-label={lang === "zh" ? "標籤" : "Tags"}
            onChange={(e) => setEditTags(e.target.value)}
          />
          {post.poll_options && post.poll_options.length > 0 && (
            <div className="poll-edit-readonly">
              <span className="poll-edit-label">
                {lang === "zh" ? "📊 投票選項（不可修改）" : "📊 Poll options (locked)"}
              </span>
              {post.poll_options.map((opt, i) => (
                <div key={i} className="poll-edit-option">{opt}</div>
              ))}
            </div>
          )}
          <div className="post-edit-actions">
            <button type="button" className="btn-save" onClick={savePostEdit} disabled={saving}>
              {saving ? t.savingShort : t.save}
            </button>
            <button type="button" className="btn-cancel" onClick={() => { setEditingPost(false); setEditBody(post.body); setEditTags(post.tags.join(", ")); }}>
              {t.cancel}
            </button>
          </div>
        </div>
      ) : (
        <>
          {post.body ? (
            <div className="post-body-wrap">
              <p className={`post-body${!postBodyExpanded && post.body.length > POST_BODY_FOLD ? " post-body-clamped" : ""}`}>
                <Linkified text={!postBodyExpanded && post.body.length > POST_BODY_FOLD ? post.body.slice(0, POST_BODY_FOLD) : post.body} />
              </p>
              {post.body.length > POST_BODY_FOLD && (
                <button
                  type="button"
                  className="post-body-toggle"
                  aria-expanded={postBodyExpanded}
                  onClick={() => setPostBodyExpanded((v) => !v)}
                >
                  {postBodyExpanded
                    ? (lang === "zh" ? "收起" : "Show less")
                    : (lang === "zh" ? `展開全文（${post.body.length} 字）` : `Read more (${post.body.length} chars)`)}
                </button>
              )}
            </div>
          ) : null}
          {post.image_url ? (
            <div className="post-media-grid">
              <button type="button" className="post-media-btn" aria-label={lang === "zh" ? "查看大圖" : "View full image"} onClick={() => setLightbox({ src: post.image_url!, alt: post.body ? post.body.slice(0, 100) : (lang === "zh" ? "帖子圖片" : "Post image") })}>
                <img
                  src={post.image_url}
                  alt={post.body ? post.body.slice(0, 100) : (lang === "zh" ? "帖子圖片" : "Post image")}
                  className="post-media-clickable"
                  loading="lazy"
                  onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }}
                />
              </button>
            </div>
          ) : null}
          {mediaItems.length > 0 ? (
            <div className="post-media-grid">
              {mediaItems.map((item) =>
                item.public_url ? (
                  <button type="button" key={item.id} className="post-media-btn" aria-label={lang === "zh" ? "查看大圖" : "View full image"} onClick={() => setLightbox({ src: item.public_url, alt: item.alt_text ?? (lang === "zh" ? "帖子媒體" : "Post media") })}>
                    <img
                      src={item.public_url}
                      alt={item.alt_text ?? (lang === "zh" ? "帖子媒體" : "Post media")}
                      className="post-media-clickable"
                      loading="lazy"
                      onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }}
                    />
                  </button>
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
              {post.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="tag-chip"
                  aria-label={lang === "zh" ? `篩選標籤：${tag}` : `Filter by tag: ${tag}`}
                  onClick={() => onTagClick?.(tag)}
                >
                  #{tag}
                </button>
              ))}
            </div>
          ) : null}
          {post.poll_options && post.poll_options.length > 0 && (() => {
            const myVote = pollVotes?.find((v) => v.post_id === post.id && v.profile_id === currentProfile.id);
            const allPostVotes = (pollVotes ?? []).filter((v) => v.post_id === post.id);
            const totalVotes = allPostVotes.length;
            const hasVoted = myVote !== undefined;
            const pollEndsAt = post.poll_ends_at ? new Date(post.poll_ends_at) : null;
            const isClosed = pollEndsAt ? Date.now() > pollEndsAt.getTime() : false;
            const showResults = true;
            const deadlineLabel = pollEndsAt
              ? pollEndsAt.toLocaleString(lang === "zh" ? "zh-HK" : "en-HK", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
              : null;
            const customVotes = allPostVotes.filter((v) => v.option_idx === -1);
            return (
              <div className={`poll-block${isClosed ? " is-closed" : ""}`}>
                {pollEndsAt && (
                  <p className={`poll-deadline-badge${isClosed ? " is-expired" : ""}`}>
                    {isClosed
                      ? (lang === "zh" ? `⏰ 投票已截止（${deadlineLabel}）` : `⏰ Poll closed (${deadlineLabel})`)
                      : (lang === "zh" ? `⏰ 截止：${deadlineLabel}` : `⏰ Closes: ${deadlineLabel}`)}
                  </p>
                )}
                {post.poll_options.map((opt, i) => {
                  const count = allPostVotes.filter((v) => v.option_idx === i).length;
                  const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
                  const isMyChoice = myVote?.option_idx === i;
                  return (
                    <div key={i} className="poll-option-row">
                      <button
                        type="button"
                        className={`poll-option${isMyChoice ? " is-voted" : ""}${showResults ? " has-result" : ""}`}
                        aria-pressed={isMyChoice}
                        onClick={() => onPollVote?.(post.id, i)}
                        disabled={readOnly || isClosed}
                      >
                        <span className="poll-option-bar" style={{ width: showResults ? `${pct}%` : "0%" }} />
                        <span className="poll-option-label">{opt}</span>
                        {showResults && <span className="poll-option-pct">{pct}%{isMyChoice ? " ✓" : ""}</span>}
                      </button>
                      {showResults && count > 0 && (
                        <div className="poll-voter-list">
                          {allPostVotes.filter((v) => v.option_idx === i).map((v) => {
                            const voter = allProfiles?.find((p) => p.id === v.profile_id);
                            return (
                              <span key={v.profile_id} className="poll-voter-chip" style={{ color: voter?.accent ?? "var(--text-muted)" }}>
                                {voter?.display_name ?? v.profile_id}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                {/* Custom option — input when not voted, results when voted/closed */}
                {post.poll_allow_custom && !showResults && !isClosed && !readOnly && (
                  <div className="poll-custom-row">
                    <input
                      className="poll-custom-input"
                      type="text"
                      maxLength={80}
                      placeholder={lang === "zh" ? "自定義選項…" : "Custom option…"}
                      value={customVoteDraft}
                      onChange={(e) => setCustomVoteDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && customVoteDraft.trim()) {
                          onPollVote?.(post.id, -1, customVoteDraft.trim());
                          setCustomVoteDraft("");
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="poll-custom-submit"
                      disabled={!customVoteDraft.trim()}
                      onClick={() => { onPollVote?.(post.id, -1, customVoteDraft.trim()); setCustomVoteDraft(""); }}
                    >
                      {lang === "zh" ? "提交" : "Submit"}
                    </button>
                  </div>
                )}
                {post.poll_allow_custom && showResults && customVotes.length > 0 && (
                  <div className="poll-custom-results">
                    <p className="poll-custom-results-label">{lang === "zh" ? "自定義回應：" : "Custom responses:"}</p>
                    {customVotes.map((v) => {
                      const voter = allProfiles?.find((p) => p.id === v.profile_id);
                      return (
                        <div key={v.profile_id} className="poll-custom-result-row">
                          <span className="poll-voter-chip" style={{ color: voter?.accent ?? "var(--text-muted)" }}>
                            {voter?.display_name ?? v.profile_id}
                          </span>
                          <span className="poll-custom-result-text">{v.custom_text}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="poll-votes-total">
                  {lang === "zh" ? `${totalVotes} 票` : `${totalVotes} vote${totalVotes !== 1 ? "s" : ""}`}
                  {hasVoted && !readOnly && !isClosed && (
                    <button type="button" className="poll-change-vote" onClick={() => onPollVote?.(post.id, myVote!.option_idx)}>
                      {lang === "zh" ? " · 取消投票" : " · Remove vote"}
                    </button>
                  )}
                </p>
              </div>
            );
          })()}
          {post.quote_post_id && (() => {
            const qp = allPosts?.find((p) => p.id === post.quote_post_id);
            if (!qp) return null;
            const qAuthor = getProfile(qp.author_id);
            return (
              <button type="button" className="quote-post-preview" onClick={() => { pendingScrollPostId = qp.id; navigate({ name: "home" }); window.dispatchEvent(new CustomEvent("clawbook:focus-post")); }} aria-label={`View quoted post by ${qAuthor.display_name}`}>
                <span className="quote-post-author" style={{ color: qAuthor.accent }}>🔁 {qAuthor.display_name}</span>
                <p className="quote-post-body">{qp.body.slice(0, 120)}{qp.body.length > 120 ? "…" : ""}</p>
              </button>
            );
          })()}
        </>
      )}

      {quoteMode && (
        <div className="quote-composer">
          <div className="quote-composer-ref">
            <span>🔁 {lang === "zh" ? "引用此帖" : "Quoting this post"}</span>
            <button type="button" aria-label={lang === "zh" ? "取消引用" : "Cancel quote"} onClick={() => { setQuoteMode(false); setQuoteDraft(""); }}>✕</button>
          </div>
          <MentionTextarea
            value={quoteDraft}
            maxLength={POST_MAX_LENGTH}
            placeholder={lang === "zh" ? "加上你嘅睇法…" : "Add your take…"}
            onChange={setQuoteDraft}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                if (quoteDraft.trim() && onQuotePost) {
                  onQuotePost(post, quoteDraft.trim());
                  setQuoteMode(false);
                  setQuoteDraft("");
                }
              }
            }}
          />
          <div className="quote-composer-actions">
            <span className={`char-counter${POST_MAX_LENGTH - quoteDraft.length < 80 ? " is-warning" : ""}`}>{POST_MAX_LENGTH - quoteDraft.length}</span>
            <button
              type="button"
              disabled={saving || !quoteDraft.trim()}
              onClick={() => {
                if (onQuotePost) { onQuotePost(post, quoteDraft.trim()); setQuoteMode(false); setQuoteDraft(""); }
              }}
            >
              {lang === "zh" ? "引用發佈" : "Quote & Post"}
            </button>
          </div>
        </div>
      )}

      {/* Stats bar — left: counts, right: emoji type bubbles */}
      {(totalReactions > 0 || comments.length > 0) && (
        <div className="post-stats-bar">
          <div className="post-stats-left">
            {totalReactions > 0 && (
              <button type="button" className="stat-count-btn" aria-label={lang === "zh" ? `${totalReactions} 個反應，點擊查看詳情` : `${totalReactions} reaction${totalReactions !== 1 ? "s" : ""}, view details`} aria-expanded={reactionDetailOpen} onClick={() => { setReactionDetailOpen((v) => !v); setReactionDetailTab(null); }}>
                👍 {totalReactions}
              </button>
            )}
            {comments.length > 0 && (
              <button
                type="button"
                className="stat-count-btn"
                aria-label={lang === "zh" ? `${comments.length} 則留言，點擊跳至最新留言` : `${comments.length} comment${comments.length !== 1 ? "s" : ""}, jump to latest`}
                onClick={() => {
                  const latest = comments[comments.length - 1];
                  if (!latest) return;
                  const el = document.getElementById(`cmt-${latest.id}`);
                  if (el) {
                    smoothScrollIntoView(el, { block: "center" });
                    el.classList.add("comment-highlight");
                    setTimeout(() => el.classList.remove("comment-highlight"), 1800);
                  } else {
                    setShowAllComments(true);
                    setTimeout(() => {
                      const el2 = document.getElementById(`cmt-${latest.id}`);
                      if (el2) { smoothScrollIntoView(el2, { block: "center" }); el2.classList.add("comment-highlight"); setTimeout(() => el2.classList.remove("comment-highlight"), 1800); }
                    }, 80);
                  }
                }}
              >
                {comments.length} {lang === "zh" ? "則留言" : "comments"}
              </button>
            )}
          </div>
          {totalReactions > 0 && (
            <div className="reaction-summary-wrap" ref={reactionDetailRef}>
              <button
                type="button"
                className="reaction-type-bubbles-btn"
                aria-label={lang === "zh" ? "查看反應詳情" : "View reaction details"}
                aria-expanded={reactionDetailOpen}
                onClick={() => { setReactionDetailOpen((v) => !v); setReactionDetailTab(null); }}
              >
                {activeEmojis.slice(0, 3).map((e) => (
                  <span key={e} className="reaction-type-bubble">{e}</span>
                ))}
              </button>
              {reactionDetailOpen && (
                <div className="reaction-detail-popover" role="dialog" aria-label={lang === "zh" ? "反應詳情" : "Reaction details"}>
                  {/* Tabs */}
                  <div className="reaction-detail-tabs" role="tablist">
                    <button
                      type="button"
                      className={`reaction-detail-tab${reactionDetailTab === null ? " is-active" : ""}`}
                      aria-pressed={reactionDetailTab === null}
                      onClick={() => setReactionDetailTab(null)}
                    >
                      {lang === "zh" ? "所有" : "All"} {totalReactions}
                    </button>
                    {activeGroups.map((g) => (
                      <button
                        key={g.emoji}
                        type="button"
                        className={`reaction-detail-tab${reactionDetailTab === g.emoji ? " is-active" : ""}`}
                        aria-pressed={reactionDetailTab === g.emoji}
                        onClick={() => setReactionDetailTab(g.emoji)}
                      >
                        {g.emoji} {g.count}
                      </button>
                    ))}
                  </div>
                  {/* Reactor list */}
                  <div className="reaction-detail-list">
                    {allReactors
                      .filter((r) => reactionDetailTab === null || r.emoji === reactionDetailTab)
                      .map((r, i) => (
                        <div key={i} className="reaction-detail-person">
                          <div className="reaction-detail-avatar-wrap">
                            <span className="reaction-detail-avatar" style={{ backgroundColor: r.profile.accent }}>
                              {r.profile.avatar_initials}
                            </span>
                            <span className="reaction-detail-badge">{r.emoji}</span>
                          </div>
                          <span className="reaction-detail-name">{r.profile.display_name}</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Action bar — Like / Comment / Quote */}
      <div className="post-action-bar">
        {!readOnly && (
          <div className="reaction-picker-wrap" ref={pickerWrapRef}>
            <button
              type="button"
              data-testid="reaction-button"
              className={`post-action-btn like-action-btn${myReaction ? " is-active" : ""}`}
              aria-pressed={Boolean(myReaction)}
              onClick={() => { onReaction(post.id, myReaction ?? "👍"); setPickerOpen(false); }}
            >
              <span className="like-btn-emoji">{myReaction ?? "👍"}</span>
              <span>{myReaction ? (lang === "zh" ? "已讚" : "Liked") : (lang === "zh" ? "讚" : "Like")}</span>
            </button>
            <button
              type="button"
              className="like-more-btn"
              onClick={() => setPickerOpen((v) => !v)}
              title={lang === "zh" ? "選擇反應" : "Choose reaction"}
              aria-label={lang === "zh" ? "選擇反應" : "Choose reaction"}
              aria-expanded={pickerOpen}
            >▾</button>
            {pickerOpen && (
              <div className="reaction-picker-dropdown" role="toolbar" aria-label={lang === "zh" ? "選擇反應" : "Choose reaction"}>
                {REACTION_OPTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    aria-label={emoji}
                    className={groupedReactions.find((r) => r.emoji === emoji)?.active ? "is-active" : ""}
                    onClick={() => { onReaction(post.id, emoji); setPickerOpen(false); }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          className="post-action-btn"
          disabled={!!post.comments_disabled}
          title={post.comments_disabled ? (lang === "zh" ? "留言已關閉" : "Comments disabled") : undefined}
          onClick={() => {
            if (post.comments_disabled) return;
            setShowAllComments(true);
            setTimeout(() => {
              if (commentComposeRef.current) smoothScrollIntoView(commentComposeRef.current, { block: "nearest" });
              commentComposeRef.current?.querySelector("textarea")?.focus();
            }, 60);
          }}
        >
          {post.comments_disabled ? "💬🔒" : "💬"} <span>{lang === "zh" ? "留言" : "Comment"}</span>
        </button>
        {!readOnly && onQuotePost && (
          <button
            type="button"
            className={`post-action-btn${quoteMode ? " is-active" : ""}`}
            aria-pressed={quoteMode}
            onClick={() => { setQuoteMode((v) => !v); setQuoteDraft(""); }}
          >
            🔁 <span>{lang === "zh" ? "引用" : "Quote"}</span>
          </button>
        )}
      </div>

      <section className="comments" data-testid="comment-list" aria-label="Comments">
        {comments.length > 3 && !showAllComments && (
          <button
            type="button"
            className="show-all-comments-btn"
            onClick={async () => {
              if (!allCommentsFetched && onLoadComments) {
                const ok = await onLoadComments(post.id);
                if (ok) setAllCommentsFetched(true);
              }
              setShowAllComments(true);
            }}
          >
            {lang === "zh" ? "查看全部留言" : "View all comments"}
          </button>
        )}
        {(() => {
          const topLevel = comments.filter(c => !c.reply_to_id);
          const repliesFor = (id: string) => comments.filter(c => c.reply_to_id === id);
          const visibleTop = showAllComments ? topLevel : topLevel.slice(-3);
          const ordered = visibleTop.flatMap(c => [c, ...repliesFor(c.id)]);
          return ordered.map((comment) => {
          const cAuthor = getProfile(comment.author_id);
          const isMyComment = comment.author_id === currentProfile.id;
          const isEditingThis = editingCommentId === comment.id;
          const parentComment = comment.reply_to_id ? comments.find((c) => c.id === comment.reply_to_id) : null;
          const isReply = Boolean(comment.reply_to_id);
          return (
            <Fragment key={comment.id}>
            <article className={`comment${isReply ? " comment-reply" : ""}`} id={`cmt-${comment.id}`} aria-label={lang === "zh" ? `${cAuthor.display_name} 的留言` : `Comment by ${cAuthor.display_name}`}>
              <Avatar profile={cAuthor} className="comment-avatar" style={{ backgroundColor: cAuthor.accent }} />
              <div className="comment-body-wrap">
                <strong>{cAuthor.display_name}</strong>
                {isEditingThis ? (
                  <div className="comment-edit-form">
                    <textarea
                      value={editCommentBody}
                      maxLength={COMMENT_MAX_LENGTH}
                      rows={2}
                      aria-label={lang === "zh" ? "編輯留言" : "Edit comment"}
                      onChange={(e) => setEditCommentBody(e.target.value)}
                    />
                    <div className="post-edit-actions">
                      <button type="button" className="btn-save" onClick={() => saveCommentEdit(comment.id)}>{t.save}</button>
                      <button type="button" className="btn-cancel" onClick={() => setEditingCommentId(null)}>{t.cancel}</button>
                    </div>
                  </div>
                ) : (
                  <>
                    {parentComment && (
                      <span className="reply-to-label">
                        ↩ {getProfile(parentComment.author_id).display_name}
                      </span>
                    )}
                    <p><Linkified text={comment.body} /></p>
                  </>
                )}
                <small className="comment-time">
                  {relativeTime(comment.created_at, lang, now)}
                  {comment.updated_at !== comment.created_at ? <span className="edited-badge"> · {lang === "zh" ? "已編輯" : "edited"}</span> : null}
                </small>
                <div className="comment-footer">
                  <div className="comment-reaction-row">
                    {REACTION_OPTIONS.map((emoji) => {
                      const count = reactions.filter((r) => r.comment_id === comment.id && r.emoji === emoji).length;
                      const active = reactions.some((r) => r.comment_id === comment.id && r.author_id === currentProfile.id && r.emoji === emoji);
                      return (
                        <button
                          key={emoji}
                          type="button"
                          aria-label={`${emoji}${count > 0 ? ` ${count}` : ""}`}
                          aria-pressed={active}
                          className={`comment-react-btn${active ? " is-active" : ""}`}
                          disabled={readOnly}
                          onClick={() => !readOnly && onCommentReaction(comment.id, post.id, emoji)}
                        >
                          {emoji}{count > 0 ? <strong>{count}</strong> : null}
                        </button>
                      );
                    })}
                  </div>
                  <div className="comment-actions">
                    {!readOnly && (
                      <button
                        type="button"
                        className={replyingTo?.id === comment.id ? "is-active" : ""}
                        aria-pressed={replyingTo?.id === comment.id}
                        onClick={() => {
                          if (replyingTo?.id === comment.id) { setReplyingTo(null); }
                          else {
                            setReplyingTo(comment);
                            setShowAllComments(true);
                          }
                        }}
                      >
                        {lang === "zh" ? "回覆" : "Reply"}
                      </button>
                    )}
                    {isMyComment && !isEditingThis && (
                      <>
                        <button type="button" onClick={() => startEditComment(comment)}>{t.edit}</button>
                        {confirmDeleteCommentId === comment.id ? (
                          <span className="confirm-delete-inline">
                            <span className="confirm-delete-label">{lang === "zh" ? "確定？" : "Sure?"}</span>
                            <button type="button" aria-label={lang === "zh" ? "確認刪除" : "Confirm delete"} onClick={() => { onDeleteComment(comment.id); setConfirmDeleteCommentId(null); }}>✓</button>
                            <button type="button" aria-label={lang === "zh" ? "取消" : "Cancel delete"} onClick={() => setConfirmDeleteCommentId(null)}>✕</button>
                          </span>
                        ) : (
                          <button type="button" onClick={() => setConfirmDeleteCommentId(comment.id)}>{t.delete}</button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </article>
            {replyingTo?.id === comment.id && !readOnly && (
              <div className="comment-inline-compose">
                <MentionTextarea
                  value={commentDraft}
                  maxLength={COMMENT_MAX_LENGTH}
                  placeholder={lang === "zh" ? `回覆 ${getProfile(replyingTo.author_id).display_name}…` : `Reply to ${getProfile(replyingTo.author_id).display_name}…`}
                  onChange={setCommentDraft}
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submitComment(); } }}
                />
                <div className="comment-composer-footer">
                  <button type="button" onClick={() => { setReplyingTo(null); setCommentDraft(""); }}>{lang === "zh" ? "取消" : "Cancel"}</button>
                  <button type="button" disabled={saving || !commentDraft.trim()} onClick={submitComment}>{saving ? t.savingShort : t.commentBtn}</button>
                </div>
              </div>
            )}
            </Fragment>
          );
          });
        })()}
      </section>

      {post.comments_disabled && (
        <p className="comments-disabled-notice">
          {lang === "zh" ? "💬🔒 留言已關閉" : "💬🔒 Comments are disabled"}
        </p>
      )}
      {!readOnly && !post.comments_disabled && !replyingTo && (
        <div className="comment-composer" ref={commentComposeRef}>
          <MentionTextarea
            data-testid="comment-textarea"
            value={commentDraft}
            maxLength={COMMENT_MAX_LENGTH}
            placeholder={t.commentPlaceholder(currentProfile.display_name)}
            onChange={setCommentDraft}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submitComment(); } }}
          />
          <div className="comment-composer-footer">
            {commentDraft.length > COMMENT_MAX_LENGTH * 0.7 && (
              <span className={`char-counter${commentDraft.length >= COMMENT_MAX_LENGTH ? " is-over" : ""}`}>
                {COMMENT_MAX_LENGTH - commentDraft.length}
              </span>
            )}
            <button
              data-testid="comment-button"
              type="button"
              disabled={saving || !commentDraft.trim()}
              onClick={submitComment}
            >
              {saving ? t.savingShort : t.commentBtn}
            </button>
          </div>
        </div>
      )}
      {lightbox && (
        <LightboxOverlay src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      )}
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
  searchQuery,
  onComment,
  onReaction,
  onCommentReaction,
  onEditPost,
  onDeletePost,
  onEditComment,
  onDeleteComment,
  onPinPost,
  allPollVotes,
  onPollVote,
  allPosts,
  onQuotePost,
  onToggleComments,
  onLoadComments,
  allProfiles,
}: {
  posts: Post[];
  currentProfile: Profile;
  allComments: Comment[];
  allReactions: Reaction[];
  allMedia: Media[];
  saving: boolean;
  searchQuery?: string;
  onComment: (postId: string, body: string, replyToId?: string | null) => void;
  onReaction: (postId: string, emoji: string) => void;
  onCommentReaction: (commentId: string, postId: string, emoji: string) => void;
  onEditPost: (postId: string, body: string, tags: string[]) => void;
  onDeletePost: (postId: string) => void;
  onEditComment: (commentId: string, body: string) => void;
  onDeleteComment: (commentId: string) => void;
  onPinPost?: (postId: string, pinned: boolean) => void;
  allPollVotes?: PollVote[];
  onPollVote?: (postId: string, optionIdx: number, customText?: string) => void;
  allPosts?: Post[];
  onQuotePost?: (quotedPost: Post, body: string) => void;
  onToggleComments?: (postId: string, disabled: boolean) => void;
  onLoadComments?: (postId: string) => Promise<boolean>;
  allProfiles?: Profile[];
}) {
  const { lang } = useLang();
  const readOnly = useReadOnly();
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [sortBy, setSortBy] = useState<"latest" | "top">("latest");
  const syncing = useSyncing();
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const tag = (e as CustomEvent<string>).detail;
      setActiveTag((prev) => prev === tag ? null : tag);
      smoothScrollTo({ top: 0 });
    };
    window.addEventListener("clawbook:filter-tag", handler);
    return () => window.removeEventListener("clawbook:filter-tag", handler);
  }, []);

  useEffect(() => {
    function scrollToPost() {
      const targetId = pendingScrollPostId;
      if (!targetId) return;
      pendingScrollPostId = null;
      const attempt = (tries: number) => {
        const el = document.getElementById(`post-card-${targetId}`);
        if (el) {
          smoothScrollIntoView(el, { block: "center" });
          el.classList.add("post-highlight");
          setTimeout(() => el.classList.remove("post-highlight"), 2200);
        } else if (tries > 0) {
          setTimeout(() => attempt(tries - 1), 250);
        }
      };
      attempt(8);
    }
    scrollToPost(); // run on mount (navigation case)
    window.addEventListener("clawbook:focus-post", scrollToPost);
    return () => window.removeEventListener("clawbook:focus-post", scrollToPost);
  }, []); // runs once on Feed mount + listens for custom event

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) setVisibleCount((c) => c + PAGE_SIZE);
      },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const mediaByPost = useMemo(() => {
    const map = new Map<string, Media[]>();
    allMedia.forEach((m) => { if (!m.post_id) return; const arr = map.get(m.post_id) ?? []; arr.push(m); map.set(m.post_id, arr); });
    return map;
  }, [allMedia]);
  const commentsByPost = useMemo(() => {
    const map = new Map<string, Comment[]>();
    allComments.forEach((c) => { const arr = map.get(c.post_id) ?? []; arr.push(c); map.set(c.post_id, arr); });
    return map;
  }, [allComments]);
  const reactionsByPost = useMemo(() => {
    const map = new Map<string, Reaction[]>();
    allReactions.forEach((r) => { const arr = map.get(r.post_id) ?? []; arr.push(r); map.set(r.post_id, arr); });
    return map;
  }, [allReactions]);
  const pollVotesByPost = useMemo(() => {
    const map = new Map<string, PollVote[]>();
    (allPollVotes ?? []).forEach((v) => { const arr = map.get(v.post_id) ?? []; arr.push(v); map.set(v.post_id, arr); });
    return map;
  }, [allPollVotes]);

  const q = searchQuery?.toLowerCase().trim() ?? "";
  const allDisplayPosts = useMemo(() => {
    const filtered = q
      ? (() => {
          const commentIndex = new Map<string, string>();
          allComments.forEach((c) => {
            const prev = commentIndex.get(c.post_id) ?? "";
            commentIndex.set(c.post_id, prev + " " + c.body.toLowerCase());
          });
          return posts.filter((p) =>
            p.body.toLowerCase().includes(q) ||
            p.tags.some((t) => t.includes(q)) ||
            getProfile(p.author_id).display_name.toLowerCase().includes(q) ||
            (commentIndex.get(p.id) ?? "").includes(q),
          );
        })()
      : posts;
    const byTag = activeTag ? filtered.filter((p) => p.tags.includes(activeTag)) : filtered;
    const sorted = sortBy === "top"
      ? (() => {
          const reactionCount = new Map<string, number>();
          allReactions.forEach((r) => { if (!r.comment_id) reactionCount.set(r.post_id, (reactionCount.get(r.post_id) ?? 0) + 1); });
          return [...byTag].sort((a, b) =>
            ((reactionCount.get(b.id) ?? 0) - (reactionCount.get(a.id) ?? 0)) ||
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          );
        })()
      : byTag;
    const pinned = sorted.filter((p) => p.is_pinned);
    const unpinned = sorted.filter((p) => !p.is_pinned);
    return [...pinned, ...unpinned];
  }, [posts, q, allComments, activeTag, sortBy, allReactions]);

  if (syncing && isSupabaseConfigured && posts.length === 0) return <FeedSkeleton />;

  const displayPosts = allDisplayPosts.slice(0, visibleCount);

  if (posts.length === 0) {
    return (
      <section className="feed feed-empty" data-testid="feed">
        <p className="feed-empty-icon">📭</p>
        <p>{lang === "zh" ? (readOnly ? "尚無帖子" : "未有帖子，發佈第一篇吧！") : (readOnly ? "Nothing here yet." : "No posts yet — be the first to share something!")}</p>
      </section>
    );
  }

  if (allDisplayPosts.length === 0 && q) {
    return (
      <section className="feed feed-empty" data-testid="feed">
        <p className="feed-empty-icon">🔍</p>
        <p>{lang === "zh" ? `搜尋「${searchQuery}」沒有結果` : `No results for "${searchQuery}"`}</p>
      </section>
    );
  }

  return (
    <section className="feed" data-testid="feed">
      <div className="feed-sort-bar">
        <button type="button" className={`feed-sort-btn${sortBy === "latest" ? " is-active" : ""}`} aria-pressed={sortBy === "latest"} onClick={() => setSortBy("latest")}>
          {lang === "zh" ? "最新" : "Latest"}
        </button>
        <button type="button" className={`feed-sort-btn${sortBy === "top" ? " is-active" : ""}`} aria-pressed={sortBy === "top"} onClick={() => setSortBy("top")}>
          {lang === "zh" ? "熱門" : "Top"}
        </button>
      </div>
      {activeTag && (
        <div className="tag-filter-bar">
          <span>#{activeTag}</span>
          <button type="button" onClick={() => setActiveTag(null)} aria-label="Clear filter">✕</button>
        </div>
      )}
      {allDisplayPosts.length === 0 && (
        <div className="feed-empty">
          <p className="feed-empty-icon">🏷️</p>
          <p>{lang === "zh" ? `沒有帶有 #${activeTag} 標籤的帖子` : `No posts tagged #${activeTag}`}</p>
        </div>
      )}
      {displayPosts.map((post) => (
        <SocialPostCard
          key={post.id}
          post={post}
          currentProfile={currentProfile}
          mediaItems={mediaByPost.get(post.id) ?? []}
          comments={commentsByPost.get(post.id) ?? []}
          reactions={reactionsByPost.get(post.id) ?? []}
          saving={saving}
          onComment={onComment}
          onReaction={onReaction}
          onCommentReaction={onCommentReaction}
          onEditPost={onEditPost}
          onDeletePost={onDeletePost}
          onEditComment={onEditComment}
          onDeleteComment={onDeleteComment}
          onTagClick={(tag) => setActiveTag(tag === activeTag ? null : tag)}
          onPinPost={onPinPost}
          pollVotes={pollVotesByPost.get(post.id)}
          onPollVote={onPollVote}
          allPosts={allPosts}
          onQuotePost={onQuotePost}
          onToggleComments={onToggleComments}
          onLoadComments={onLoadComments}
          allProfiles={allProfiles}
        />
      ))}
      {visibleCount < allDisplayPosts.length && (
        <div ref={sentinelRef} className="feed-sentinel" aria-hidden="true" />
      )}
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
  onCommentReaction,
  onEditPost,
  onDeletePost,
  onEditComment,
  onDeleteComment,
  onPinPost,
  onEditProfile,
  onMessage,
  allPollVotes,
  onPollVote,
  allPosts,
  onQuotePost,
  onToggleComments,
  onLoadComments,
  allProfiles,
}: {
  profile: Profile;
  currentProfile: Profile;
  posts: Post[];
  comments: Comment[];
  reactions: Reaction[];
  mediaItems: Media[];
  saving: boolean;
  onCreatePost: (post: Post, media: Media[], files: File[]) => void;
  onComment: (postId: string, body: string, replyToId?: string | null) => void;
  onReaction: (postId: string, emoji: string) => void;
  onCommentReaction: (commentId: string, postId: string, emoji: string) => void;
  onEditPost: (postId: string, body: string, tags: string[]) => void;
  onDeletePost: (postId: string) => void;
  onEditComment: (commentId: string, body: string) => void;
  onDeleteComment: (commentId: string) => void;
  onPinPost?: (postId: string, pinned: boolean) => void;
  onEditProfile?: (bio: string, status: string, accent: string, role: string, avatarUrl?: string) => void;
  onMessage?: () => void;
  allPollVotes?: PollVote[];
  onPollVote?: (postId: string, optionIdx: number, customText?: string) => void;
  allPosts?: Post[];
  onQuotePost?: (quotedPost: Post, body: string) => void;
  onToggleComments?: (postId: string, disabled: boolean) => void;
  onLoadComments?: (postId: string) => Promise<boolean>;
  allProfiles?: Profile[];
}) {
  const { t, lang } = useLang();
  const readOnly = useReadOnly();
  const now = useNow();
  const isOwnProfile = profile.id === currentProfile.id;
  const [composerOpen, setComposerOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [editBio, setEditBio] = useState(profile.bio);
  const [editStatus, setEditStatus] = useState(profile.status);
  const [editAccent, setEditAccent] = useState(profile.accent);
  const [editRole, setEditRole] = useState(profile.role);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const profileEditId = useId();

  const profilePosts = posts.filter(
    (p) => p.author_id === profile.id || (p.target_type === "profile" && p.target_id === profile.id),
  );
  const authoredPosts = posts.filter((p) => p.author_id === profile.id);
  const receivedReactions = reactions.filter((r) =>
    r.comment_id === null && posts.some((p) => p.id === r.post_id && p.author_id === profile.id),
  );
  const profileImages = mediaItems.filter((m) => profilePosts.some((p) => p.id === m.post_id));

  return (
    <div className="surface">
      <section className="profile-header" data-testid="profile-page">
        <div className="profile-cover" style={buildCover(profile)} />
        <div className="profile-identity" style={profileAccent(profile)}>
          <Avatar profile={profile} className="profile-avatar" />
          <div>
            <h1>{profile.display_name}</h1>
            <p>{profile.role}</p>
          </div>
          {isOwnProfile && !editingProfile && (
            <button type="button" className="post-action-btn profile-edit-btn" onClick={() => { setEditBio(profile.bio); setEditStatus(profile.status); setEditAccent(profile.accent); setEditRole(profile.role); setAvatarPreview(null); setAvatarFile(null); setEditingProfile(true); }} title={lang === "zh" ? "編輯個人資料" : "Edit profile"} aria-label={lang === "zh" ? "編輯個人資料" : "Edit profile"}>✏️</button>
          )}
          {!isOwnProfile && !readOnly && onMessage && (
            <button type="button" className="profile-message-btn" onClick={onMessage}>
              ✉ {lang === "zh" ? "發訊息" : "Message"}
            </button>
          )}
          <button
            type="button"
            className="profile-copy-link-btn"
            title={lang === "zh" ? "複製連結" : "Copy link"}
            aria-label={copiedLink ? (lang === "zh" ? "已複製！" : "Copied!") : (lang === "zh" ? "複製個人頁連結" : "Copy profile link")}
            onClick={() => {
              const url = `${window.location.origin}${BASE_PATH}/?as=${profile.username}`;
              void navigator.clipboard.writeText(url).then(() => {
                setCopiedLink(true);
                setTimeout(() => setCopiedLink(false), 2000);
              }).catch(() => {});
            }}
          >
            {copiedLink ? (lang === "zh" ? "已複製！" : "Copied!") : "🔗"}
          </button>
        </div>

        {editingProfile ? (
          <div className="profile-edit-form">
            <div className="profile-edit-avatar-row">
              <button
                type="button"
                className="profile-edit-avatar-btn"
                onClick={() => avatarInputRef.current?.click()}
                title={lang === "zh" ? "更換頭像" : "Change avatar"}
                aria-label={lang === "zh" ? "更換頭像" : "Change avatar"}
              >
                {avatarPreview
                  ? <img src={avatarPreview} alt="preview" className="avatar avatar-img" />
                  : <Avatar profile={profile} />}
                <span className="profile-edit-avatar-overlay">📷</span>
              </button>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                aria-hidden="true"
                tabIndex={-1}
                className="visually-hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setAvatarFile(file);
                  setAvatarPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
                }}
              />
              <span className="profile-edit-avatar-hint">{lang === "zh" ? "點擊更換頭像" : "Click to change avatar"}</span>
            </div>
            <input
              className="profile-edit-status"
              value={editRole}
              maxLength={60}
              placeholder={lang === "zh" ? "角色" : "Role"}
              aria-label={lang === "zh" ? "角色" : "Role"}
              onChange={(e) => setEditRole(e.target.value)}
            />
            <input
              className="profile-edit-status"
              value={editStatus}
              maxLength={120}
              placeholder={lang === "zh" ? "狀態" : "Status"}
              aria-label={lang === "zh" ? "狀態" : "Status"}
              onChange={(e) => setEditStatus(e.target.value)}
            />
            <textarea
              className="profile-edit-bio"
              value={editBio}
              maxLength={400}
              rows={3}
              placeholder={lang === "zh" ? "個人簡介" : "Bio"}
              aria-label={lang === "zh" ? "個人簡介" : "Bio"}
              onChange={(e) => setEditBio(e.target.value)}
            />
            <div className="profile-edit-color-row">
              <label htmlFor={`${profileEditId}-accent`}>{lang === "zh" ? "強調色" : "Accent color"}</label>
              <input type="color" id={`${profileEditId}-accent`} value={editAccent} onChange={(e) => setEditAccent(e.target.value)} />
            </div>
            <div className="post-edit-actions">
              <button
                type="button"
                className="btn-save"
                disabled={uploadingAvatar}
                onClick={async () => {
                  setUploadingAvatar(true);
                  try {
                    let avatarUrl: string | undefined;
                    if (avatarFile) {
                      const res = await uploadMediaFile(avatarFile, profile.id, "avatar");
                      if (!res.error && res.data) avatarUrl = res.data.public_url;
                    }
                    await onEditProfile?.(editBio, editStatus, editAccent, editRole, avatarUrl);
                    setAvatarFile(null);
                    setAvatarPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
                    setEditingProfile(false);
                  } finally {
                    setUploadingAvatar(false);
                  }
                }}
              >
                {uploadingAvatar ? "…" : t.save}
              </button>
              <button type="button" className="btn-cancel" onClick={() => { setEditingProfile(false); setAvatarPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null; }); setAvatarFile(null); }}>{t.cancel}</button>
            </div>
          </div>
        ) : (
          <>
            {profile.status && <p className="profile-status-line">{profile.status}</p>}
            {profile.kind === "agent" && (() => {
              const lastPostAt = authoredPosts.reduce<string | null>((m, p) => !m || p.created_at > m ? p.created_at : m, null);
              const lastCommentAt = comments.filter((c) => c.author_id === profile.id).reduce<string | null>((m, c) => !m || c.created_at > m ? c.created_at : m, null);
              const lastAt = !lastPostAt ? lastCommentAt : !lastCommentAt ? lastPostAt : lastPostAt > lastCommentAt ? lastPostAt : lastCommentAt;
              return lastAt
                ? <p className="agent-last-active">⏱ {lang === "zh" ? "上次活動：" : "Last active: "}{relativeTime(lastAt, lang, now)}</p>
                : <p className="agent-last-active">{lang === "zh" ? "尚未活動" : "No activity yet"}</p>;
            })()}
            <p className="profile-bio">{profile.bio}</p>
          </>
        )}
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

      {isOwnProfile && !readOnly && (
        <div className="composer-toggle-bar">
          <button
            type="button"
            className={`composer-toggle-btn${composerOpen ? " is-open" : ""}`}
            aria-expanded={composerOpen}
            onClick={() => setComposerOpen((v) => !v)}
          >
            <Avatar profile={currentProfile} className="composer-toggle-avatar" />
            <span>{composerOpen ? (lang === "zh" ? "收起" : "Close") : (lang === "zh" ? "有咩想分享？" : "What's on your mind?")}</span>
            <span className="composer-toggle-icon">{composerOpen ? "▲" : "✏️"}</span>
          </button>
        </div>
      )}
      {isOwnProfile && !readOnly && composerOpen && (
        <CreatePost
          currentProfile={currentProfile}
          target={{ target_type: "profile", target_id: profile.id }}
          saving={saving}
          onCreate={(post, media, files) => { onCreatePost(post, media, files); setComposerOpen(false); }}
        />
      )}

      {profileImages.length > 0 ? (
        <section className="image-strip">
          <h2>{t.recentImages}</h2>
          <div>
            {profileImages.slice(0, 6).map((item) =>
              item.public_url ? (
                <img key={item.id} src={item.public_url} alt={item.alt_text ?? "Profile media"} loading="lazy" />
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
        onCommentReaction={onCommentReaction}
        onEditPost={onEditPost}
        onDeletePost={onDeletePost}
        onEditComment={onEditComment}
        onDeleteComment={onDeleteComment}
        onPinPost={onPinPost}
        allPollVotes={allPollVotes}
        onPollVote={onPollVote}
        allPosts={allPosts}
        onQuotePost={onQuotePost}
        onToggleComments={onToggleComments}
        onLoadComments={onLoadComments}
        allProfiles={allProfiles}
      />
    </div>
  );
}

// ----- public group page -----

function PublicGroupPage({
  groupId,
  currentProfile,
  posts,
  comments,
  reactions,
  mediaItems,
  saving,
  onCreatePost,
  onComment,
  onReaction,
  onCommentReaction,
  onEditPost,
  onDeletePost,
  onEditComment,
  onDeleteComment,
  onPinPost,
  allPollVotes,
  onPollVote,
  allPosts,
  onQuotePost,
  onToggleComments,
  onLoadComments,
  allProfiles,
}: {
  groupId: string;
  currentProfile: Profile;
  posts: Post[];
  comments: Comment[];
  reactions: Reaction[];
  mediaItems: Media[];
  saving: boolean;
  onCreatePost: (post: Post, media: Media[], files: File[]) => void;
  onComment: (postId: string, body: string, replyToId?: string | null) => void;
  onReaction: (postId: string, emoji: string) => void;
  onCommentReaction: (commentId: string, postId: string, emoji: string) => void;
  onEditPost: (postId: string, body: string, tags: string[]) => void;
  onDeletePost: (postId: string) => void;
  onEditComment: (commentId: string, body: string) => void;
  onDeleteComment: (commentId: string) => void;
  onPinPost?: (postId: string, pinned: boolean) => void;
  allPollVotes?: PollVote[];
  onPollVote?: (postId: string, optionIdx: number, customText?: string) => void;
  allPosts?: Post[];
  onQuotePost?: (quotedPost: Post, body: string) => void;
  onToggleComments?: (postId: string, disabled: boolean) => void;
  onLoadComments?: (postId: string) => Promise<boolean>;
  allProfiles?: Profile[];
}) {
  const { t, lang } = useLang();
  const readOnly = useReadOnly();
  const group = getGroup(groupId);
  const groupPosts = posts.filter((p) => p.target_type === "group" && p.target_id === group.id);
  const [copiedGroupLink, setCopiedGroupLink] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);

  return (
    <div className="surface">
      <section className="group-header">
        <div className="group-cover" style={buildGroupCover(group.id)} />
        <div className="group-header-title-row">
          <h1>{group.name}</h1>
          <button
            type="button"
            className="profile-copy-link-btn"
            title={lang === "zh" ? "複製群組連結" : "Copy group link"}
            aria-label={copiedGroupLink ? (lang === "zh" ? "已複製！" : "Copied!") : (lang === "zh" ? "複製群組連結" : "Copy group link")}
            onClick={() => {
              const url = `${window.location.origin}${BASE_PATH}/groups/${group.slug}`;
              void navigator.clipboard.writeText(url).then(() => {
                setCopiedGroupLink(true);
                setTimeout(() => setCopiedGroupLink(false), 2000);
              }).catch(() => {});
            }}
          >
            {copiedGroupLink ? (lang === "zh" ? "已複製！" : "Copied!") : "🔗"}
          </button>
        </div>
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
        <div className="group-member-row">
          {groupMembers.filter((m) => m.group_id === group.id).map((m) => {
            const p = profiles.find((pr) => pr.id === m.profile_id);
            if (!p) return null;
            return (
              <button
                key={m.profile_id}
                type="button"
                className="group-member-avatar"
                title={p.display_name}
                aria-label={p.display_name}
                onClick={() => navigate({ name: "profile", id: p.id })}
              >
                <Avatar profile={p} />
              </button>
            );
          })}
        </div>
      </section>

      {!readOnly && (
        <div className="composer-toggle-bar">
          <button
            type="button"
            className={`composer-toggle-btn${composerOpen ? " is-open" : ""}`}
            aria-expanded={composerOpen}
            onClick={() => setComposerOpen((v) => !v)}
          >
            <Avatar profile={currentProfile} className="composer-toggle-avatar" />
            <span>{composerOpen ? (lang === "zh" ? "收起" : "Close") : (lang === "zh" ? "有咩想分享？" : "What's on your mind?")}</span>
            <span className="composer-toggle-icon">{composerOpen ? "▲" : "✏️"}</span>
          </button>
        </div>
      )}
      {!readOnly && composerOpen && (
        <CreatePost
          currentProfile={currentProfile}
          target={{ target_type: "group", target_id: group.id }}
          saving={saving}
          onCreate={(post, media, files) => { onCreatePost(post, media, files); setComposerOpen(false); }}
        />
      )}

      <Feed
        posts={groupPosts}
        currentProfile={currentProfile}
        allComments={comments}
        allReactions={reactions}
        allMedia={mediaItems}
        saving={saving}
        onComment={onComment}
        onReaction={onReaction}
        onCommentReaction={onCommentReaction}
        onEditPost={onEditPost}
        onDeletePost={onDeletePost}
        onEditComment={onEditComment}
        onDeleteComment={onDeleteComment}
        onPinPost={onPinPost}
        allPollVotes={allPollVotes}
        onPollVote={onPollVote}
        allPosts={allPosts}
        onQuotePost={onQuotePost}
        onToggleComments={onToggleComments}
        onLoadComments={onLoadComments}
        allProfiles={allProfiles}
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
  onCommentReaction,
  onEditPost,
  onDeletePost,
  onEditComment,
  onDeleteComment,
  onPinPost,
  allPollVotes,
  onPollVote,
  allPosts,
  onQuotePost,
  onToggleComments,
  onLoadComments,
  allProfiles,
}: {
  currentProfile: Profile;
  posts: Post[];
  comments: Comment[];
  reactions: Reaction[];
  mediaItems: Media[];
  saving: boolean;
  onCreatePost: (post: Post, media: Media[], files: File[]) => void;
  onComment: (postId: string, body: string, replyToId?: string | null) => void;
  onReaction: (postId: string, emoji: string) => void;
  onCommentReaction: (commentId: string, postId: string, emoji: string) => void;
  onEditPost: (postId: string, body: string, tags: string[]) => void;
  onDeletePost: (postId: string) => void;
  onEditComment: (commentId: string, body: string) => void;
  onDeleteComment: (commentId: string) => void;
  onPinPost?: (postId: string, pinned: boolean) => void;
  allPollVotes?: PollVote[];
  onPollVote?: (postId: string, optionIdx: number, customText?: string) => void;
  allPosts?: Post[];
  onQuotePost?: (quotedPost: Post, body: string) => void;
  onToggleComments?: (postId: string, disabled: boolean) => void;
  onLoadComments?: (postId: string) => Promise<boolean>;
  allProfiles?: Profile[];
}) {
  const { t, lang } = useLang();
  const readOnly = useReadOnly();
  const { bookmarks } = useBookmarks();
  const [searchQuery, setSearchQuery] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [needsReplyOnly, setNeedsReplyOnly] = useState(false);
  const [showBookmarked, setShowBookmarked] = useState(false);
  const [feedGroupFilter, setFeedGroupFilter] = useState<"all" | "my-wall" | "public-discussion" | "builders-corner">("all");
  const [feedAuthorFilter, setFeedAuthorFilter] = useState<string | null>(null);
  const [homeTarget, setHomeTarget] = useState<ComposerTarget>({
    target_type: "profile",
    target_id: currentProfile.id,
  });
  const feedPosts = readOnly
    ? posts // guests see everything
    : posts.filter(
        (p) =>
          (p.target_type === "profile" && p.target_id === currentProfile.id) ||
          p.target_type === "group",
      );

  const filteredByGroup = (() => {
    const byGroup = feedGroupFilter === "all"
      ? feedPosts
      : feedGroupFilter === "my-wall"
      ? feedPosts.filter((p) => p.target_type === "profile")
      : feedPosts.filter((p) => p.target_type === "group" && p.target_id === feedGroupFilter);
    return feedAuthorFilter ? byGroup.filter((p) => p.author_id === feedAuthorFilter) : byGroup;
  })();

  const needsReplyPosts = currentProfile.id === "penny"
    ? feedPosts.filter((p) => {
        if (p.author_id === "penny") return false;
        if (comments.some((c) => c.post_id === p.id && c.author_id === "penny")) return false;
        if (p.target_type === "profile" && p.target_id === "penny") return true;
        if (p.body.toLowerCase().includes("@penny")) return true;
        return false;
      })
    : [];

  const displayFeedPosts = showBookmarked
    ? posts.filter((p) => bookmarks.has(p.id))
    : needsReplyOnly ? needsReplyPosts : filteredByGroup;

  const searchResultCount = searchQuery.trim()
    ? displayFeedPosts.filter((p) => {
        const q = searchQuery.toLowerCase().trim();
        return p.body.toLowerCase().includes(q) || p.tags.some((t) => t.includes(q));
      }).length
    : null;

  useEffect(() => {
    if (readOnly) return;
    const handler = () => setComposerOpen(true);
    window.addEventListener("clawbook:open-composer", handler);
    return () => window.removeEventListener("clawbook:open-composer", handler);
  }, [readOnly]);

  return (
    <div className="surface">
      <div className="feed-search-bar">
        <input
          type="search"
          aria-label={lang === "zh" ? "搜尋帖子" : "Search posts"}
          placeholder={lang === "zh" ? "搜尋帖子、作者、標籤… (⌘K)" : "Search posts, authors, tags… (⌘K)"}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button type="button" onClick={() => setSearchQuery("")} aria-label="Clear search">✕</button>
        )}
      </div>
      {searchQuery && searchResultCount !== null && (
        <p className="search-result-count">
          {lang === "zh" ? `找到 ${searchResultCount} 個帖` : `${searchResultCount} result${searchResultCount !== 1 ? "s" : ""}`}
        </p>
      )}

      <div className="needs-reply-filter">
        {currentProfile.id === "penny" && (
          <button
            type="button"
            className={`needs-reply-btn${needsReplyOnly && !showBookmarked ? " is-active" : ""}`}
            aria-pressed={needsReplyOnly && !showBookmarked}
            onClick={() => { setNeedsReplyOnly((v) => !v); setShowBookmarked(false); smoothScrollTo({ top: 0 }); }}
          >
            📬 {lang === "zh" ? "需要回應" : "Needs reply"}
            {needsReplyPosts.length > 0 && (
              <span className="needs-reply-count">{needsReplyPosts.length}</span>
            )}
          </button>
        )}
        {!readOnly && (
          <button
            type="button"
            className={`needs-reply-btn${showBookmarked ? " is-active" : ""}`}
            aria-pressed={showBookmarked}
            onClick={() => { setShowBookmarked((v) => !v); setNeedsReplyOnly(false); smoothScrollTo({ top: 0 }); }}
          >
            🔖 {lang === "zh" ? "已儲存" : "Saved"}
            {bookmarks.size > 0 && <span className="needs-reply-count">{bookmarks.size}</span>}
          </button>
        )}
      </div>

      {needsReplyOnly && (
        <div className="filter-active-banner">
          📬 {lang === "zh" ? `顯示 ${needsReplyPosts.length} 個需要回應的帖` : `Showing ${needsReplyPosts.length} post${needsReplyPosts.length !== 1 ? "s" : ""} needing reply`}
          <button type="button" aria-label={lang === "zh" ? "清除篩選" : "Clear filter"} onClick={() => { setNeedsReplyOnly(false); smoothScrollTo({ top: 0 }); }}>✕</button>
        </div>
      )}

      {!showBookmarked && !needsReplyOnly && (
        <div className="feed-group-filter">
          {(["all", "my-wall", GROUP_PUBLIC, GROUP_BUILDERS] as const).map((f) => {
            const label = f === "all"
              ? (lang === "zh" ? "全部" : "All")
              : f === "my-wall"
              ? (lang === "zh" ? "我的版面" : "My Wall")
              : f === GROUP_PUBLIC
              ? (lang === "zh" ? "公開討論" : "Public")
              : (lang === "zh" ? "Builders" : "Builders");
            return (
              <button
                key={f}
                type="button"
                className={`feed-group-chip${feedGroupFilter === f ? " is-active" : ""}`}
                aria-pressed={feedGroupFilter === f}
                onClick={() => { setFeedGroupFilter(f); setFeedAuthorFilter(null); }}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {!showBookmarked && !needsReplyOnly && allProfiles && allProfiles.length > 0 && (
        <div className="feed-author-filter">
          <span className="feed-author-filter-label">{lang === "zh" ? "作者：" : "By:"}</span>
          {(allProfiles as Profile[]).filter((p) => p.id !== "guest").map((p) => (
            <button
              key={p.id}
              type="button"
              className={`feed-author-chip${feedAuthorFilter === p.id ? " is-active" : ""}`}
              style={feedAuthorFilter === p.id ? { borderColor: p.accent, boxShadow: `0 0 0 2px ${p.accent}33` } : {}}
              onClick={() => setFeedAuthorFilter(feedAuthorFilter === p.id ? null : p.id)}
              title={p.display_name}
              aria-label={feedAuthorFilter === p.id ? (lang === "zh" ? `清除 ${p.display_name} 篩選` : `Clear filter: ${p.display_name}`) : (lang === "zh" ? `篩選：${p.display_name}` : `Filter by ${p.display_name}`)}
              aria-pressed={feedAuthorFilter === p.id}
            >
              <span className="feed-author-chip-avatar" style={{ background: p.accent }}>{p.avatar_initials}</span>
              {feedAuthorFilter === p.id && <span className="feed-author-chip-name">{p.display_name}</span>}
            </button>
          ))}
        </div>
      )}

      {!readOnly && (
        <div className="composer-toggle-bar">
          <button
            type="button"
            className={`composer-toggle-btn${composerOpen ? " is-open" : ""}`}
            aria-expanded={composerOpen}
            onClick={() => setComposerOpen((v) => !v)}
          >
            <Avatar profile={currentProfile} className="composer-toggle-avatar" />
            <span>{composerOpen ? (lang === "zh" ? "收起" : "Close") : (lang === "zh" ? "有咩想分享？" : "What's on your mind?")}</span>
            <span className="composer-toggle-icon">{composerOpen ? "▲" : "✏️"}</span>
          </button>
        </div>
      )}

      {!readOnly && composerOpen && (
        <>
          <div className="home-target-picker">
            <span className="home-target-label">{t.postTo}</span>
            <button
              type="button"
              className={homeTarget.target_type === "profile" ? "is-active" : ""}
              aria-pressed={homeTarget.target_type === "profile"}
              onClick={() => setHomeTarget({ target_type: "profile", target_id: currentProfile.id })}
            >
              {lang === "zh" ? "我的版面" : "My wall"}
            </button>
            <button
              type="button"
              className={homeTarget.target_type === "group" ? "is-active" : ""}
              aria-pressed={homeTarget.target_type === "group"}
              onClick={() => setHomeTarget({ target_type: "group", target_id: GROUP_PUBLIC })}
            >
              {lang === "zh" ? "公開討論" : "Public Discussion"}
            </button>
          </div>
          <CreatePost
            currentProfile={currentProfile}
            target={homeTarget}
            saving={saving}
            onCreate={(post, media, files) => { onCreatePost(post, media, files); setComposerOpen(false); }}
          />
        </>
      )}

      <Feed
        posts={displayFeedPosts}
        currentProfile={currentProfile}
        allComments={comments}
        allReactions={reactions}
        allMedia={mediaItems}
        saving={saving}
        searchQuery={searchQuery}
        onComment={onComment}
        onReaction={onReaction}
        onCommentReaction={onCommentReaction}
        onEditPost={onEditPost}
        onDeletePost={onDeletePost}
        onEditComment={onEditComment}
        onDeleteComment={onDeleteComment}
        onPinPost={onPinPost}
        allPollVotes={allPollVotes}
        onPollVote={onPollVote}
        allPosts={allPosts}
        onQuotePost={onQuotePost}
        onToggleComments={onToggleComments}
        onLoadComments={onLoadComments}
        allProfiles={allProfiles}
      />
    </div>
  );
}

// ----- back to top -----

function BackToTop() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    function onScroll() { setVisible(window.scrollY > 400); }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  if (!visible) return null;
  return (
    <button
      type="button"
      className="back-to-top"
      aria-label="Back to top"
      onClick={() => smoothScrollTo({ top: 0 })}
    >
      ↑
    </button>
  );
}

// ----- messages panel -----

function MessagesPanel({
  currentProfile,
  allProfiles,
  initialWith,
  onClose,
}: {
  currentProfile: Profile;
  allProfiles: Profile[];
  initialWith?: Profile | null;
  onClose: () => void;
}) {
  const { t, lang } = useLang();
  const [dms, setDms] = useState<DirectMessage[]>(() => loadDMs());
  const [activeWith, setActiveWith] = useState<Profile | null>(initialWith ?? null);
  const [draft, setDraft] = useState("");
  const threadEndRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const [broadcastMode, setBroadcastMode] = useState(false);
  const [broadcastRecipients, setBroadcastRecipients] = useState<Set<string>>(new Set());
  const [broadcastDraft, setBroadcastDraft] = useState("");
  const [broadcastSent, setBroadcastSent] = useState(false);

  // Escape key closes the panel
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  // Load from Supabase on mount and merge with localStorage
  useEffect(() => {
    loadDirectMessages(currentProfile.id).then((result) => {
      if (result.data && result.data.length > 0) {
        setDms((local) => {
          const merged = [...result.data!];
          local.forEach((m) => {
            if (!merged.some((s) => s.id === m.id)) merged.push(m);
          });
          merged.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
          saveDMs(merged);
          return merged;
        });
      }
    }).catch(() => {});
  }, [currentProfile.id]);

  // Realtime: read receipts — update read=true when recipient reads my sent DMs
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel(`dm-read-receipts-${currentProfile.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "direct_messages", filter: `from_id=eq.${currentProfile.id}` },
        (payload) => {
          const updated = payload.new as DirectMessage;
          if (updated.read) {
            setDms((prev) => {
              const next = prev.map((m) => m.id === updated.id ? { ...m, read: true } : m);
              saveDMs(next);
              return next;
            });
          }
        },
      )
      .subscribe();
    return () => { void supabase!.removeChannel(channel); };
  }, [currentProfile.id]);

  const otherProfiles = allProfiles.filter((p) => p.id !== currentProfile.id && p.id !== "guest");

  const conversations = otherProfiles.map((p) => {
    const thread = dms.filter(
      (m) => (m.from_id === currentProfile.id && m.to_id === p.id) ||
             (m.from_id === p.id && m.to_id === currentProfile.id),
    );
    const last = thread.at(-1);
    const unread = thread.filter((m) => m.to_id === currentProfile.id && !m.read).length;
    return { profile: p, last, unread };
  }).sort((a, b) => {
    if (!a.last && !b.last) return 0;
    if (!a.last) return 1;
    if (!b.last) return -1;
    return new Date(b.last.created_at).getTime() - new Date(a.last.created_at).getTime();
  });

  const activeThread = activeWith
    ? dms.filter(
        (m) =>
          (m.from_id === currentProfile.id && m.to_id === activeWith.id) ||
          (m.from_id === activeWith.id && m.to_id === currentProfile.id),
      ).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    : [];

  function openThread(profile: Profile) {
    setActiveWith(profile);
    setDraft("");
    setDms((prev) => {
      const updated = prev.map((m) =>
        m.from_id === profile.id && m.to_id === currentProfile.id ? { ...m, read: true } : m,
      );
      saveDMs(updated);
      return updated;
    });
    void markMessagesRead(profile.id, currentProfile.id).catch(() => {});
  }

  const [dmSendError, setDmSendError] = useState<string | null>(null);

  async function send() {
    if (!activeWith || !draft.trim()) return;
    const now = new Date().toISOString();
    const msg: DirectMessage = {
      id: uniqueId("dm-local"),
      from_id: currentProfile.id,
      to_id: activeWith.id,
      body: draft.trim().slice(0, 500),
      created_at: now,
      read: false,
    };
    setDms((prev) => {
      const next = [...prev, msg];
      saveDMs(next);
      return next;
    });
    setDraft("");
    if (composeRef.current) composeRef.current.style.height = "auto";
    setTimeout(() => { if (threadEndRef.current) smoothScrollIntoView(threadEndRef.current); }, 30);
    try {
      const result = await persistDirectMessage(msg);
      if (result?.error) {
        setDmSendError("Failed to send message");
        setDms((prev) => { const next = prev.filter((m) => m.id !== msg.id); saveDMs(next); return next; });
      }
    } catch {
      setDmSendError("Failed to send message");
      setDms((prev) => { const next = prev.filter((m) => m.id !== msg.id); saveDMs(next); return next; });
    }
  }

  useEffect(() => {
    if (threadEndRef.current) smoothScrollIntoView(threadEndRef.current);
  }, [activeThread.length]);

  async function sendBroadcast() {
    if (!broadcastDraft.trim() || broadcastRecipients.size === 0) return;
    const body = broadcastDraft.trim().slice(0, 500);
    const now = new Date().toISOString();
    const newMsgs: DirectMessage[] = [...broadcastRecipients].map((toId) => ({
      id: uniqueId("dm-local"),
      from_id: currentProfile.id,
      to_id: toId,
      body,
      created_at: now,
      read: false,
    }));
    const msgIds = new Set(newMsgs.map((m) => m.id));
    setDms((prev) => {
      const next = [...prev, ...newMsgs];
      saveDMs(next);
      return next;
    });
    try {
      await Promise.all(newMsgs.map((m) => persistDirectMessage(m)));
      setBroadcastSent(true);
      setBroadcastDraft("");
      setBroadcastRecipients(new Set());
      setTimeout(() => { setBroadcastSent(false); setBroadcastMode(false); }, 1800);
    } catch {
      setDms((prev) => {
        const next = prev.filter((m) => !msgIds.has(m.id));
        saveDMs(next);
        return next;
      });
    }
  }

  return (
    <div className="messages-overlay" role="dialog" aria-modal="true" aria-label={t.messages}>
      <div className="messages-panel">
        <header className="messages-panel-header">
          <h2>{broadcastMode ? (lang === "zh" ? "📢 群發訊息" : "📢 Broadcast") : t.messages}</h2>
          <div style={{ display: "flex", gap: 6 }}>
            {!broadcastMode && (
              <button type="button" className="icon-button" title={lang === "zh" ? "群發訊息" : "Broadcast"} aria-label={lang === "zh" ? "群發訊息" : "Broadcast message"} onClick={() => setBroadcastMode(true)}>📢</button>
            )}
            <button type="button" className="icon-button" onClick={() => { setBroadcastMode(false); onClose(); }} aria-label={lang === "zh" ? "關閉訊息" : "Close messages"} autoFocus>✕</button>
          </div>
        </header>
        {broadcastMode ? (
          <div className="broadcast-panel">
            <p className="broadcast-hint">{lang === "zh" ? "選擇收件人（可多選）" : "Select recipients"}</p>
            <div className="broadcast-recipient-list">
              {otherProfiles.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`broadcast-recipient${broadcastRecipients.has(p.id) ? " is-selected" : ""}`}
                  aria-pressed={broadcastRecipients.has(p.id)}
                  aria-label={`${p.display_name}${broadcastRecipients.has(p.id) ? (lang === "zh" ? "（已選）" : " (selected)") : ""}`}
                  onClick={() => setBroadcastRecipients((prev) => {
                    const next = new Set(prev);
                    if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                    return next;
                  })}
                >
                  <span className="avatar" style={{ ...profileAccent(p), width: 32, height: 32, fontSize: "0.68rem" } as CSSProperties}>{p.avatar_initials}</span>
                  <span>{p.display_name}</span>
                  {broadcastRecipients.has(p.id) && <span className="broadcast-check">✓</span>}
                </button>
              ))}
            </div>
            <textarea
              className="broadcast-textarea"
              value={broadcastDraft}
              maxLength={500}
              rows={3}
              placeholder={lang === "zh" ? "輸入廣播訊息…" : "Write broadcast message…"}
              aria-label={lang === "zh" ? "廣播訊息" : "Broadcast message"}
              onChange={(e) => setBroadcastDraft(e.target.value)}
            />
            <div className="broadcast-actions">
              <button type="button" className="btn-cancel" onClick={() => { setBroadcastMode(false); setBroadcastDraft(""); setBroadcastRecipients(new Set()); }}>
                {lang === "zh" ? "取消" : "Cancel"}
              </button>
              <button
                type="button"
                disabled={broadcastRecipients.size === 0 || !broadcastDraft.trim() || broadcastSent}
                onClick={() => void sendBroadcast()}
              >
                {broadcastSent ? (lang === "zh" ? "已發送 ✓" : "Sent ✓") : (lang === "zh" ? `發送給 ${broadcastRecipients.size} 人` : `Send to ${broadcastRecipients.size}`)}
              </button>
            </div>
          </div>
        ) : (
        <div className="messages-body">
          <aside className="messages-list">
            {conversations.map(({ profile, last, unread }) => (
              <button
                key={profile.id}
                type="button"
                className={`messages-conv-item${activeWith?.id === profile.id ? " is-active" : ""}`}
                aria-label={unread > 0 ? (lang === "zh" ? `${profile.display_name}，${unread} 則未讀訊息` : `${profile.display_name}, ${unread} unread`) : profile.display_name}
                aria-current={activeWith?.id === profile.id ? true : undefined}
                onClick={() => openThread(profile)}
              >
                <span className="avatar messages-conv-avatar" style={{ ...profileAccent(profile), width: 38, height: 38, fontSize: "0.72rem" } as CSSProperties}>
                  {profile.avatar_initials}
                </span>
                <div className="messages-conv-info">
                  <strong>{profile.display_name}</strong>
                  <span className="messages-conv-preview">
                    {last
                      ? (last.from_id === currentProfile.id
                          ? (lang === "zh" ? "你：" : "You: ")
                          : `${profile.display_name}：`)
                        + last.body.slice(0, 36) + (last.body.length > 36 ? "…" : "")
                      : (lang === "zh" ? "尚無訊息" : "No messages yet")}
                  </span>
                </div>
                {unread > 0 && <span className="messages-unread-badge">{unread}</span>}
              </button>
            ))}
          </aside>

          <div className="messages-thread">
            {activeWith ? (
              <>
                <div className="messages-thread-header" style={profileAccent(activeWith)}>
                  <span className="avatar" style={{ width: 32, height: 32, fontSize: "0.68rem" } as CSSProperties}>
                    {activeWith.avatar_initials}
                  </span>
                  <strong>{activeWith.display_name}</strong>
                </div>
                <div className="messages-thread-body">
                  {activeThread.length === 0 ? (
                    <p className="messages-empty">{t.noMessages}</p>
                  ) : (
                    (() => {
                      const lastReadIdx = activeThread.reduce((best, m, i) =>
                        m.from_id === currentProfile.id && m.read ? i : best, -1);
                      return activeThread.map((m, i) => {
                        const isMine = m.from_id === currentProfile.id;
                        const sender = isMine ? currentProfile : activeWith;
                        const prevMsg = activeThread[i - 1];
                        const showSender = !isMine && (i === 0 || prevMsg?.from_id !== m.from_id);
                        const showRead = isMine && i === lastReadIdx;
                        return (
                          <div key={m.id} className={`message-bubble-wrap ${isMine ? "is-mine" : "is-theirs"}`}>
                            {!isMine && (
                              <span className="msg-sender-avatar" style={profileAccent(sender) as CSSProperties}>
                                {sender.avatar_initials}
                              </span>
                            )}
                            <div className="msg-bubble-col">
                              {showSender && (
                                <span className="msg-sender-name">{sender.display_name}</span>
                              )}
                              <div className="message-bubble">{m.body}</div>
                              <span className="message-time">
                                {formatTime(m.created_at, lang)}
                                {showRead && <span className="msg-read-receipt">{lang === "zh" ? " · 已讀" : " · Read"}</span>}
                              </span>
                            </div>
                          </div>
                        );
                      });
                    })()
                  )}
                  <div ref={threadEndRef} />
                </div>
                <div className="messages-compose">
                  <textarea
                    ref={composeRef}
                    value={draft}
                    maxLength={500}
                    placeholder={t.messagePlaceholder}
                    aria-label={lang === "zh" ? "訊息" : "Message"}
                    rows={1}
                    onChange={(e) => setDraft(e.target.value)}
                    onInput={(e) => {
                      const el = e.currentTarget;
                      el.style.height = "auto";
                      el.style.height = `${Math.min(el.scrollHeight, 100)}px`;
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
                  />
                  <button type="button" disabled={!draft.trim()} onClick={() => { void send(); }}>
                    {t.sendMessage}
                  </button>
                </div>
                {dmSendError && (
                  <p className="dm-send-error" role="alert">{dmSendError} <button type="button" onClick={() => setDmSendError(null)} aria-label="Dismiss error">✕</button></p>
                )}
              </>
            ) : (
              <div className="messages-thread-empty">
                <p>💬</p>
                <p>{lang === "zh" ? "選擇一個對話" : "Select a conversation"}</p>
              </div>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

// ----- root app -----

function SocialApp() {
  const [lang, setLangState] = useState<Lang>(() => {
    const raw = localStorage.getItem("clawbook:lang");
    return raw === "en" || raw === "zh" ? raw : "en";
  });
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    localStorage.setItem("clawbook:lang", l);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-HK" : "en";
  }, [lang]);

  const [session, setSession] = useState(() => {
    const auto = resolveAutoLogin(); // side-effect: replaceState to /home if matched
    if (auto) {
      localStorage.removeItem("clawbook:guest");
      return saveIdentitySession(auto);
    }
    return loadIdentitySession();
  });
  const [guestMode, setGuestMode] = useState(() => localStorage.getItem("clawbook:guest") === "1");
  const [route, setRoute] = useState<Route>(() => routeFromLocation()); // reads updated pathname
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [messagesInitWith, setMessagesInitWith] = useState<Profile | null>(null);

  const countUnreadDms = useCallback(() => {
    if (guestMode || !session) return 0;
    return loadDMs().filter((m) => m.to_id === session.profileId && !m.read).length;
  }, [guestMode, session]);
  const [unreadDms, setUnreadDms] = useState(() => countUnreadDms());

  // Realtime: listen for incoming DMs and update badge immediately
  useEffect(() => {
    if (!supabase || !session || guestMode) return;
    const profileId = session.profileId;
    const channel = supabase
      .channel(`dm-inbox-${profileId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "direct_messages", filter: `to_id=eq.${profileId}` },
        (payload) => {
          const msg = payload.new as DirectMessage;
          const existing = loadDMs();
          if (!existing.some((m) => m.id === msg.id)) saveDMs([...existing, msg]);
          setUnreadDms((c) => c + 1);
        },
      )
      .subscribe();
    return () => { void supabase!.removeChannel(channel); };
  }, [session, guestMode]);

  // On mount + visibilitychange: sync DM badge from Supabase (catches messages missed while offline/backgrounded)
  useEffect(() => {
    if (!session || guestMode) return;
    const profileId = session.profileId;
    const sync = () =>
      loadDirectMessages(profileId).then((result) => {
        if (!result.data) return;
        const existing = loadDMs();
        const merged = [...result.data];
        existing.forEach((m) => { if (!merged.some((s) => s.id === m.id)) merged.push(m); });
        merged.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        saveDMs(merged);
        setUnreadDms(merged.filter((m) => m.to_id === profileId && !m.read).length);
      }).catch(() => {});
    void sync();
    // Throttle visibility-change DM sync to once per 60s to avoid egress on rapid tab-switches
    let lastDmSync = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastDmSync < 60_000) return;
      lastDmSync = Date.now();
      void sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [session, guestMode]);

  // poll_votes Realtime subscription moved below scheduledSync definition

  const [notifications, setNotifications] = useState<AppNotification[]>(() =>
    session && !guestMode ? loadNotifications(session.profileId) : [],
  );
  const unreadNotifs = notifications.filter((n) => !n.read).length;

  useEffect(() => {
    if (session && !guestMode) setNotifications(loadNotifications(session.profileId));
    else setNotifications([]);
  }, [session, guestMode]);

  const refreshNotifications = useCallback(() => {
    if (session && !guestMode) setNotifications(loadNotifications(session.profileId));
  }, [session, guestMode]);

  const markNotifsRead = useCallback(() => {
    if (!session || guestMode) return;
    localStorage.setItem("clawbook:lastNotifCheck", Date.now().toString());
    const updated = loadNotifications(session.profileId).map((n) => ({ ...n, read: true }));
    saveNotifications(session.profileId, updated);
    setNotifications(updated);
  }, [session, guestMode]);

  // ----- bookmarks -----
  const [bookmarkIds, setBookmarkIds] = useState<Set<string>>(() => loadBookmarkIds());
  useEffect(() => {
    const handler = () => setBookmarkIds(loadBookmarkIds());
    window.addEventListener("clawbook:bookmarks-changed", handler);
    return () => window.removeEventListener("clawbook:bookmarks-changed", handler);
  }, []);
  const toggleBookmark = useCallback((postId: string) => {
    const next = new Set(loadBookmarkIds());
    if (next.has(postId)) next.delete(postId); else next.add(postId);
    saveBookmarkIds(next);
  }, []);
  const bookmarkCtxValue = useMemo(() => ({ bookmarks: bookmarkIds, toggle: toggleBookmark }), [bookmarkIds, toggleBookmark]);

  const [profilesList, setProfilesList] = useState<Profile[]>(isSupabaseConfigured ? [] : profiles);
  // Keep the module-level lookup table in sync strictly via post-commit effect
  useEffect(() => { liveProfiles = profilesList; }, [profilesList]);
  const [posts, setPosts] = useState<Post[]>(isSupabaseConfigured ? [] : seedPosts);
  const [comments, setComments] = useState<Comment[]>(isSupabaseConfigured ? [] : seedComments);
  const [reactions, setReactions] = useState<Reaction[]>(isSupabaseConfigured ? [] : seedReactions);
  const [mediaItems, setMediaItems] = useState<Media[]>(isSupabaseConfigured ? [] : seedMedia);
  const [pollVotes, setPollVotes] = useState<PollVote[]>([]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingCount, setSavingCount] = useState(0);
  const isSaving = savingCount > 0;
  const setIsSaving = (v: boolean) => setSavingCount((n) => Math.max(0, n + (v ? 1 : -1)));

  const lastSyncRef = useRef<number>(0);
  const syncDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const MIN_SYNC_INTERVAL_MS = 60_000; // at most 1 full sync per 60s

  const syncAllData = useCallback(async () => {
    lastSyncRef.current = Date.now();
    setIsSyncing(true);
    let result: Awaited<ReturnType<typeof loadAllSocialData>>;
    try {
      result = await loadAllSocialData();
    } catch (err) {
      setIsSyncing(false);
      setSyncError(String(err));
      return;
    }
    setIsSyncing(false);
    if (result.data === null) {
      setSyncError(result.error);
      return;
    }
    setSyncError(null);
    setProfilesList(result.data.profiles);
    // Preserve optimistic (in-flight) local writes that haven't reached DB yet
    const incomingPostIds = new Set(result.data.posts.map((p) => p.id));
    setPosts((prev) => {
      const pending = prev.filter((p) => p.id.startsWith("post-local-") && !incomingPostIds.has(p.id));
      return pending.length ? [...result.data!.posts, ...pending] : result.data!.posts;
    });
    const incomingCmtIds = new Set(result.data.comments.map((c) => c.id));
    setComments((prev) => {
      const pending = prev.filter((c) => c.id.startsWith("comment-local-") && !incomingCmtIds.has(c.id));
      return pending.length ? [...result.data!.comments, ...pending] : result.data!.comments;
    });
    setReactions(result.data.reactions);
    setMediaItems(result.data.media);
    setPollVotes(result.data.pollVotes);
  }, []);

  // Debounced sync for Realtime events — batches rapid-fire changes into one reload
  const scheduledSync = useCallback(() => {
    if (syncDebounceRef.current) clearTimeout(syncDebounceRef.current);
    const elapsed = Date.now() - lastSyncRef.current;
    const delay = Math.max(0, MIN_SYNC_INTERVAL_MS - elapsed);
    syncDebounceRef.current = setTimeout(() => void syncAllData(), delay);
  }, [syncAllData]);

  useEffect(() => {
    void syncAllData();
  }, [syncAllData]);

  useEffect(() => {
    const unsubscribe = subscribeToSocialChanges(scheduledSync);
    return () => { unsubscribe(); if (syncDebounceRef.current) clearTimeout(syncDebounceRef.current); };
  }, [scheduledSync]);

  // Realtime: poll vote changes — throttled via same scheduledSync (60s min interval)
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel("poll-votes-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "poll_votes" }, scheduledSync)
      .subscribe();
    return () => { void supabase!.removeChannel(channel); };
  }, [scheduledSync]);

  // Detect new comments arriving via Realtime sync and push notifications
  const seenCommentIdsRef = useRef<Set<string>>(new Set());
  const commentsSeedDoneRef = useRef(false);
  useEffect(() => {
    if (!session || guestMode) return;
    // First batch: seed seenCommentIds; still notify for comments newer than lastNotifCheck
    if (!commentsSeedDoneRef.current) {
      const lastCheck = parseInt(localStorage.getItem("clawbook:lastNotifCheck") || "0", 10);
      const recentMissed: typeof comments = [];
      comments.forEach((c) => {
        seenCommentIdsRef.current.add(c.id);
        if (lastCheck > 0 && new Date(c.created_at).getTime() > lastCheck) recentMissed.push(c);
      });
      if (comments.length > 0) commentsSeedDoneRef.current = true;
      if (recentMissed.length > 0) {
        const myId = session.profileId;
        let needRefresh = false;
        recentMissed.forEach((c) => {
          if (c.author_id === myId) return;
          const parentPost = posts.find((p) => p.id === c.post_id);
          if (!parentPost) return;
          if (parentPost.author_id === myId) {
            pushNotification(myId, { type: "comment", from_id: c.author_id, post_id: c.post_id, snippet: c.body, created_at: c.created_at });
            needRefresh = true;
            return;
          }
          const iParticipated = comments.some((prev) => prev.post_id === c.post_id && prev.author_id === myId);
          if (iParticipated) {
            pushNotification(myId, { type: "thread", from_id: c.author_id, post_id: c.post_id, snippet: c.body, created_at: c.created_at });
            needRefresh = true;
          }
        });
        if (needRefresh) refreshNotifications();
      }
      return;
    }
    const myId = session.profileId;
    const newComments = comments.filter(
      (c) => !c.id.startsWith("comment-local-") && !seenCommentIdsRef.current.has(c.id),
    );
    if (newComments.length === 0) return;
    let needRefresh = false;
    newComments.forEach((c) => {
      seenCommentIdsRef.current.add(c.id);
      if (c.author_id === myId) return; // own comment — skip
      const parentPost = posts.find((p) => p.id === c.post_id);
      if (!parentPost) return;
      if (parentPost.author_id === myId) {
        pushNotification(myId, {
          type: "comment",
          from_id: c.author_id,
          post_id: c.post_id,
          snippet: c.body,
          created_at: c.created_at,
        });
        needRefresh = true;
        return;
      }
      // Thread-follow: I previously commented on this post
      const iParticipated = comments.some((prev) => prev.post_id === c.post_id && prev.author_id === myId);
      if (iParticipated) {
        pushNotification(myId, {
          type: "thread",
          from_id: c.author_id,
          post_id: c.post_id,
          snippet: c.body,
          created_at: c.created_at,
        });
        needRefresh = true;
      }
    });
    if (needRefresh) refreshNotifications();
  }, [comments, session, guestMode, posts, refreshNotifications]);

  useEffect(() => {
    const handler = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  // Pull-to-refresh
  useEffect(() => {
    let startY = 0;
    let canPull = false;
    const THRESHOLD = 75;
    const onTouchStart = (e: TouchEvent) => {
      if (window.scrollY === 0) { startY = e.touches[0].clientY; canPull = true; }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (!canPull) return;
      canPull = false;
      if (e.changedTouches[0].clientY - startY > THRESHOLD) scheduledSync();
    };
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [syncAllData]);

  useEffect(() => {
    smoothScrollTo({ top: 0 });
  }, [route]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        const el = document.querySelector<HTMLInputElement>(".feed-search-bar input");
        if (el) { el.focus(); el.select(); }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        const active = document.activeElement;
        const isTyping = active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT");
        if (!isTyping) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("clawbook:open-composer"));
        }
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const sortedPosts = useMemo(() => {
    const lastCommentTime = new Map<string, number>();
    comments.forEach((c) => {
      const prev = lastCommentTime.get(c.post_id) ?? 0;
      const t = new Date(c.created_at).getTime();
      if (t > prev) lastCommentTime.set(c.post_id, t);
    });
    return [...posts].sort((a, b) => {
      const ta = Math.max(new Date(a.created_at).getTime(), lastCommentTime.get(a.id) ?? 0);
      const tb = Math.max(new Date(b.created_at).getTime(), lastCommentTime.get(b.id) ?? 0);
      return tb - ta;
    });
  }, [posts, comments]);

  const visiblePosts = useMemo(() => {
    const viewerId = guestMode ? null : (session?.profileId ?? null);
    const viewerProfile = !guestMode && viewerId ? profilesList.find((p) => p.id === viewerId) : null;
    const viewerKind = viewerProfile?.kind ?? "human";
    const viewerRole = viewerProfile?.role ?? "";
    return sortedPosts.filter((p) => canSeePost(p, viewerId, viewerKind, viewerRole, guestMode));
  }, [sortedPosts, guestMode, session, profilesList]);

  const profileLastActivity = useMemo(() => {
    const map: Record<string, string> = {};
    const consider = (authorId: string, ts: string) => {
      if (!map[authorId] || ts > map[authorId]) map[authorId] = ts;
    };
    posts.forEach((p) => consider(p.author_id, p.created_at));
    comments.forEach((c) => consider(c.author_id, c.created_at));
    reactions.forEach((r) => consider(r.author_id, r.created_at));
    return map;
  }, [posts, comments, reactions]);

  const LAST_HOME_VISIT_KEY = "clawbook:lastHomeVisit";
  const [unreadPosts, setUnreadPosts] = useState(0);

  useEffect(() => {
    if (route.name === "home") {
      localStorage.setItem(LAST_HOME_VISIT_KEY, new Date().toISOString());
      setUnreadPosts(0);
    } else if (session && !guestMode) {
      const lastVisit = localStorage.getItem(LAST_HOME_VISIT_KEY);
      if (!lastVisit) return;
      const count = visiblePosts.filter(
        (p) => p.author_id !== session.profileId && new Date(p.created_at) > new Date(lastVisit),
      ).length;
      setUnreadPosts(count);
    }
  }, [route, visiblePosts, session, guestMode]);

  async function createPost(post: Post, nextMedia: Media[], files: File[]) {
    setPosts((c) => [post, ...c]);
    setMediaItems((c) => [...nextMedia, ...c]);

    // Emit mention notifications (track IDs for rollback)
    const mentionNotifs: Array<{ profileId: string; notifId: string }> = [];
    const mentionedSlugs = extractMentions(post.body ?? "");
    if (mentionedSlugs.length > 0) {
      const allProfs = profilesList.length > 0 ? profilesList : profiles;
      mentionedSlugs.forEach((slug) => {
        const mentioned = allProfs.find((p) => matchProfileSlug(p, slug));
        if (mentioned && mentioned.id !== post.author_id) {
          const nid = pushNotification(mentioned.id, {
            type: "mention",
            from_id: post.author_id,
            post_id: post.id,
            snippet: post.body ?? "",
            created_at: post.created_at,
          });
          if (nid) mentionNotifs.push({ profileId: mentioned.id, notifId: nid });
        }
      });
      if (session && !guestMode) refreshNotifications();
    }

    setIsSaving(true);
    const rollbackPost = () => {
      setPosts((c) => c.filter((p) => p.id !== post.id));
      setMediaItems((c) => c.filter((m) => !nextMedia.some((nm) => nm.id === m.id)));
      mentionNotifs.forEach(({ profileId, notifId }) => removeNotification(profileId, notifId));
      if (session && !guestMode) refreshNotifications();
    };
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
        rollbackPost();
      }
    } catch (err) {
      setSaveError(`Failed to save post: ${String(err)}`);
      rollbackPost();
    } finally {
      setIsSaving(false);
    }
  }

  async function handleQuotePost(quotedPost: Post, body: string) {
    if (!session) return;
    const now = new Date().toISOString();
    const quotePost: Post = {
      id: uniqueId("post-local"),
      author_id: session.profileId,
      target_type: quotedPost.target_type,
      target_id: quotedPost.target_id,
      body,
      tags: [],
      visibility: "public",
      quote_post_id: quotedPost.id,
      created_at: now,
      updated_at: now,
    };
    setPosts((c) => [quotePost, ...c]);
    setIsSaving(true);
    try {
      const result = await persistPost(quotePost, []);
      if (result.error) {
        setSaveError(`Failed to save quote post: ${result.error}`);
        setPosts((c) => c.filter((p) => p.id !== quotePost.id));
      }
    } catch (err) {
      setSaveError(`Failed to save quote post: ${String(err)}`);
      setPosts((c) => c.filter((p) => p.id !== quotePost.id));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleLoadComments(postId: string): Promise<boolean> {
    try {
      const all = await fetchAllCommentsForPost(postId);
      setComments((prev) => {
        const without = prev.filter((c) => c.post_id !== postId);
        return [...without, ...all];
      });
      return true;
    } catch (err) {
      setSaveError(`Failed to load comments: ${String(err)}`);
      return false;
    }
  }

  async function addComment(postId: string, body: string, replyToId?: string | null) {
    if (!session) return;
    const createdAt = new Date().toISOString();
    const comment: Comment = {
      id: uniqueId("comment-local"),
      post_id: postId,
      author_id: session.profileId,
      body,
      reply_to_id: replyToId ?? null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    setComments((c) => [...c, comment]);

    // Notify post author + previous thread participants when someone else comments
    const parentPost = posts.find((p) => p.id === postId);
    const notified = new Set<string>([session.profileId]);
    const pushedNotifs: Array<{ profileId: string; notifId: string }> = [];
    const trackPush = (pid: string, id: string | null) => { if (id) pushedNotifs.push({ profileId: pid, notifId: id }); };
    if (parentPost && parentPost.author_id !== session.profileId) {
      trackPush(parentPost.author_id, pushNotification(parentPost.author_id, {
        type: "comment",
        from_id: session.profileId,
        post_id: postId,
        snippet: body,
        created_at: createdAt,
      }));
      notified.add(parentPost.author_id);
    }
    // Notify others who previously commented on this post
    const threadParticipants = [...new Set(
      comments.filter((c) => c.post_id === postId).map((c) => c.author_id),
    )];
    threadParticipants.forEach((participantId) => {
      if (!notified.has(participantId)) {
        trackPush(participantId, pushNotification(participantId, {
          type: "thread",
          from_id: session!.profileId,
          post_id: postId,
          snippet: body,
          created_at: createdAt,
        }));
        notified.add(participantId);
      }
    });
    // Notify @mentioned users not already notified above
    const mentionedSlugs = extractMentions(body);
    if (mentionedSlugs.length > 0) {
      const allProfs = profilesList.length > 0 ? profilesList : profiles;
      mentionedSlugs.forEach((slug) => {
        const mentioned = allProfs.find((p) => matchProfileSlug(p, slug));
        if (mentioned && !notified.has(mentioned.id)) {
          trackPush(mentioned.id, pushNotification(mentioned.id, {
            type: "mention",
            from_id: session!.profileId,
            post_id: postId,
            snippet: body,
            created_at: createdAt,
          }));
          notified.add(mentioned.id);
        }
      });
    }
    if (!guestMode) refreshNotifications();

    setIsSaving(true);
    const rollbackComment = () => {
      setComments((c) => c.filter((cm) => cm.id !== comment.id));
      pushedNotifs.forEach(({ profileId, notifId }) => removeNotification(profileId, notifId));
      if (!guestMode) refreshNotifications();
    };
    try {
      const result = await persistComment(comment);
      if (result.error) {
        setSaveError(`Failed to save comment: ${result.error}`);
        rollbackComment();
      }
    } catch (err) {
      setSaveError(`Failed to save comment: ${String(err)}`);
      rollbackComment();
    } finally {
      setIsSaving(false);
    }
  }

  async function addCommentReaction(commentId: string, postId: string, emoji: string) {
    if (!session) return;
    const profileId = session.profileId;
    const exists = reactions.some(
      (r) => r.comment_id === commentId && r.author_id === profileId && r.emoji === emoji,
    );

    const reactionData: Reaction = {
      id: uniqueId("reaction-local"),
      post_id: postId,
      comment_id: commentId,
      author_id: profileId,
      emoji,
      created_at: new Date().toISOString(),
    };

    let pushedNotifId: string | null = null;
    if (exists) {
      setReactions((c) =>
        c.filter((r) => !(r.comment_id === commentId && r.author_id === profileId && r.emoji === emoji)),
      );
    } else {
      setReactions((c) => [...c, reactionData]);
      // Notify comment author
      const parentComment = comments.find((c) => c.id === commentId);
      if (parentComment && parentComment.author_id !== profileId) {
        pushedNotifId = pushNotification(parentComment.author_id, {
          type: "reaction",
          from_id: profileId,
          post_id: postId,
          snippet: emoji,
          created_at: reactionData.created_at,
        });
        if (!guestMode) refreshNotifications();
      }
    }

    const rollbackReaction = () => {
      if (exists) {
        setReactions((c) => [...c, reactionData]);
      } else {
        setReactions((c) =>
          c.filter((r) => !(r.comment_id === commentId && r.author_id === profileId && r.emoji === emoji)),
        );
        if (pushedNotifId) {
          const parentComment = comments.find((c) => c.id === commentId);
          if (parentComment) { removeNotification(parentComment.author_id, pushedNotifId); refreshNotifications(); }
        }
      }
    };
    try {
      const result = await toggleReaction(reactionData);
      if (result.error) { setSaveError(`Failed to save reaction: ${result.error}`); rollbackReaction(); }
    } catch (err) {
      setSaveError(`Failed to save reaction: ${String(err)}`);
      rollbackReaction();
    }
  }

  async function react(postId: string, emoji: string) {
    if (!session) return;
    const profileId = session.profileId;
    const exists = reactions.some(
      (r) => r.post_id === postId && r.author_id === profileId && r.emoji === emoji,
    );

    const reactionData: Reaction = {
      id: uniqueId("reaction-local"),
      post_id: postId,
      comment_id: null,
      author_id: profileId,
      emoji,
      created_at: new Date().toISOString(),
    };

    let pushedNotifId: string | null = null;
    if (exists) {
      setReactions((c) =>
        c.filter((r) => !(r.post_id === postId && r.author_id === profileId && r.emoji === emoji)),
      );
    } else {
      setReactions((c) => [...c, reactionData]);
      // Notify post author
      const parentPost = posts.find((p) => p.id === postId);
      if (parentPost && parentPost.author_id !== profileId) {
        pushedNotifId = pushNotification(parentPost.author_id, {
          type: "reaction",
          from_id: profileId,
          post_id: postId,
          snippet: emoji,
          created_at: reactionData.created_at,
        });
        if (!guestMode) refreshNotifications();
      }
    }

    const rollbackPostReaction = () => {
      if (exists) {
        setReactions((c) => [...c, reactionData]);
      } else {
        setReactions((c) =>
          c.filter((r) => !(r.post_id === postId && r.author_id === profileId && r.emoji === emoji)),
        );
        if (pushedNotifId) {
          const parentPost = posts.find((p) => p.id === postId);
          if (parentPost) { removeNotification(parentPost.author_id, pushedNotifId); refreshNotifications(); }
        }
      }
    };
    try {
      const result = await toggleReaction(reactionData);
      if (result.error) { setSaveError(`Failed to save reaction: ${result.error}`); rollbackPostReaction(); }
    } catch (err) {
      setSaveError(`Failed to save reaction: ${String(err)}`);
      rollbackPostReaction();
    }
  }

  async function voteOnPoll(postId: string, optionIdx: number, customText?: string) {
    const myVote = pollVotes.find((v) => v.post_id === postId && v.profile_id === currentProfile.id);
    const currentVoteIdx = myVote?.option_idx ?? null;
    const prevVotes = pollVotes;
    // Optimistic update
    if (currentVoteIdx === optionIdx && optionIdx !== -1) {
      setPollVotes((c) => c.filter((v) => !(v.post_id === postId && v.profile_id === currentProfile.id)));
    } else {
      const newVote: PollVote = { post_id: postId, profile_id: currentProfile.id, option_idx: optionIdx, custom_text: customText ?? null, created_at: new Date().toISOString() };
      setPollVotes((c) => [...c.filter((v) => !(v.post_id === postId && v.profile_id === currentProfile.id)), newVote]);
    }
    try {
      const result = await castPollVote(postId, currentProfile.id, optionIdx, currentVoteIdx, customText);
      if (result.error) {
        setSaveError(`Failed to record vote: ${result.error}`);
        setPollVotes(prevVotes);
        return;
      }
    } catch (err) {
      setSaveError(`Failed to record vote: ${String(err)}`);
      setPollVotes(prevVotes);
      return;
    }
    void loadPollVotes().then((votes) => { if (votes.length > 0 || isSupabaseConfigured) setPollVotes(votes); }).catch(() => {});
  }

  async function togglePin(postId: string, pinned: boolean) {
    setPosts((c) => c.map((p) => (p.id === postId ? { ...p, is_pinned: pinned } : p)));
    try {
      const result = await pinPost(postId, pinned);
      if (result.error) {
        setPosts((c) => c.map((p) => (p.id === postId ? { ...p, is_pinned: !pinned } : p)));
        setSaveError(`Failed to pin post: ${result.error}`);
      }
    } catch (err) {
      setPosts((c) => c.map((p) => (p.id === postId ? { ...p, is_pinned: !pinned } : p)));
      setSaveError(`Failed to pin post: ${String(err)}`);
    }
  }

  async function toggleCommentsDisabled(postId: string, disabled: boolean) {
    setPosts((c) => c.map((p) => (p.id === postId ? { ...p, comments_disabled: disabled } : p)));
    try {
      const result = await setCommentsDisabled(postId, disabled);
      if (result.error) {
        setPosts((c) => c.map((p) => (p.id === postId ? { ...p, comments_disabled: !disabled } : p)));
        setSaveError(`Failed to update comments: ${result.error}`);
      }
    } catch (err) {
      setPosts((c) => c.map((p) => (p.id === postId ? { ...p, comments_disabled: !disabled } : p)));
      setSaveError(`Failed to update comments: ${String(err)}`);
    }
  }

  async function editPost(postId: string, body: string, tags: string[]) {
    const prev = posts.find((p) => p.id === postId);
    if (!prev) return;
    const updated_at = new Date().toISOString();
    setPosts((c) => c.map((p) => (p.id === postId ? { ...p, body, tags, updated_at } : p)));
    setIsSaving(true);
    try {
      const result = await updatePost(postId, { body, tags });
      if (result.error) {
        setSaveError(`Failed to update post: ${result.error}`);
        setPosts((c) => c.map((p) => (p.id === postId ? prev : p)));
      }
    } catch (err) {
      setSaveError(`Failed to update post: ${String(err)}`);
      setPosts((c) => c.map((p) => (p.id === postId ? prev : p)));
    } finally {
      setIsSaving(false);
    }
  }

  async function removePost(postId: string) {
    const prev = posts.find((p) => p.id === postId);
    if (!prev) return;
    const prevComments = comments.filter((c) => c.post_id === postId);
    const prevReactions = reactions.filter((r) => r.post_id === postId);
    setPosts((c) => c.filter((p) => p.id !== postId));
    setComments((c) => c.filter((cm) => cm.post_id !== postId));
    setReactions((r) => r.filter((rx) => rx.post_id !== postId));
    setIsSaving(true);
    try {
      const result = await deletePost(postId);
      if (result.error) {
        setSaveError(`Failed to delete post: ${result.error}`);
        setPosts((c) => [prev, ...c]);
        setComments((c) => [...c, ...prevComments]);
        setReactions((c) => [...c, ...prevReactions]);
      }
    } catch (err) {
      setSaveError(`Failed to delete post: ${String(err)}`);
      setPosts((c) => [prev, ...c]);
      setComments((c) => [...c, ...prevComments]);
      setReactions((c) => [...c, ...prevReactions]);
    } finally {
      setIsSaving(false);
    }
  }

  async function editComment(commentId: string, body: string) {
    const prev = comments.find((c) => c.id === commentId);
    if (!prev) return;
    const comment_updated_at = new Date().toISOString();
    setComments((c) => c.map((cm) => (cm.id === commentId ? { ...cm, body, updated_at: comment_updated_at } : cm)));
    setIsSaving(true);
    try {
      const result = await updateComment(commentId, body);
      if (result.error) {
        setSaveError(`Failed to update comment: ${result.error}`);
        setComments((c) => c.map((cm) => (cm.id === commentId ? prev : cm)));
      }
    } catch (err) {
      setSaveError(`Failed to update comment: ${String(err)}`);
      setComments((c) => c.map((cm) => (cm.id === commentId ? prev : cm)));
    } finally {
      setIsSaving(false);
    }
  }

  async function removeComment(commentId: string) {
    const prev = comments.find((c) => c.id === commentId);
    if (!prev) return;
    const prevReactions = reactions.filter((r) => r.comment_id === commentId);
    setComments((c) => c.filter((cm) => cm.id !== commentId));
    setReactions((r) => r.filter((rx) => rx.comment_id !== commentId));
    setIsSaving(true);
    try {
      const result = await deleteComment(commentId);
      if (result.error) {
        setSaveError(`Failed to delete comment: ${result.error}`);
        setComments((c) => [...c, prev]);
        setReactions((c) => [...c, ...prevReactions]);
      }
    } catch (err) {
      setSaveError(`Failed to delete comment: ${String(err)}`);
      setComments((c) => [...c, prev]);
      setReactions((c) => [...c, ...prevReactions]);
    } finally {
      setIsSaving(false);
    }
  }

  const langValue = useMemo(() => ({ lang, setLang }), [lang, setLang]);

  if ((!session && !guestMode) || route.name === "identity") {
    return (
      <LangContext.Provider value={langValue}>
        <IdentityEntry
          liveProfiles={profilesList}
          onRefresh={() => void syncAllData()}
          onEnter={(profile) => {
            localStorage.removeItem("clawbook:guest");
            setGuestMode(false);
            setSession(saveIdentitySession(profile));
            navigate({ name: "home" });
          }}
          onGuestEnter={() => {
            clearIdentitySession();
            setSession(null);
            localStorage.setItem("clawbook:guest", "1");
            setGuestMode(true);
            navigate({ name: "home" });
          }}
        />
      </LangContext.Provider>
    );
  }

  const currentProfile = guestMode
    ? GUEST_PROFILE
    : (profilesList.find((p) => p.id === session!.profileId) ?? getProfile(session!.profileId));

  let screen = (
    <HomePage
      currentProfile={currentProfile}
      posts={visiblePosts}
      comments={comments}
      reactions={reactions}
      mediaItems={mediaItems}
      saving={isSaving}
      onCreatePost={createPost}
      onComment={addComment}
      onReaction={react}
      onCommentReaction={addCommentReaction}
      onEditPost={editPost}
      onDeletePost={removePost}
      onEditComment={editComment}
      onDeleteComment={removeComment}
      onPinPost={togglePin}
      allPollVotes={pollVotes}
      onPollVote={voteOnPoll}
      allPosts={visiblePosts}
      onQuotePost={handleQuotePost}
      onToggleComments={toggleCommentsDisabled}
      onLoadComments={handleLoadComments}
      allProfiles={profilesList}
    />
  );

  if (route.name === "profile") {
    screen = (
      <ProfilePage
        profile={profilesList.find((p) => p.id === route.id) ?? getProfile(route.id)}
        currentProfile={currentProfile}
        posts={visiblePosts}
        comments={comments}
        reactions={reactions}
        mediaItems={mediaItems}
        saving={isSaving}
        onCreatePost={createPost}
        onComment={addComment}
        onReaction={react}
        onCommentReaction={addCommentReaction}
        onEditPost={editPost}
        onDeletePost={removePost}
        onEditComment={editComment}
        onDeleteComment={removeComment}
        onPinPost={togglePin}
        allPollVotes={pollVotes}
        onPollVote={voteOnPoll}
        allPosts={visiblePosts}
        onQuotePost={handleQuotePost}
        onToggleComments={toggleCommentsDisabled}
        allProfiles={profilesList}
        onEditProfile={async (bio, status, accent, role, avatarUrl) => {
          try {
            const result = await updateProfile(currentProfile.id, { bio, status, accent, role, avatar_url: avatarUrl });
            if (result.error) { setSaveError(`Failed to update profile: ${result.error}`); return; }
            setProfilesList((c) =>
              c.map((p) => p.id === currentProfile.id ? { ...p, bio, status, accent, role, ...(avatarUrl ? { avatar_url: avatarUrl } : {}) } : p),
            );
          } catch (err) {
            setSaveError(`Failed to update profile: ${String(err)}`);
          }
        }}
        onMessage={() => {
          const target = profilesList.find((p) => p.id === route.id) ?? getProfile(route.id);
          setMessagesInitWith(target);
          setMessagesOpen(true);
        }}
        onLoadComments={handleLoadComments}
      />
    );
  }

  if (route.name === "group") {
    screen = (
      <PublicGroupPage
        groupId={route.id}
        currentProfile={currentProfile}
        posts={visiblePosts}
        comments={comments}
        reactions={reactions}
        mediaItems={mediaItems}
        saving={isSaving}
        onCreatePost={createPost}
        onComment={addComment}
        onReaction={react}
        onCommentReaction={addCommentReaction}
        onEditPost={editPost}
        onDeletePost={removePost}
        onEditComment={editComment}
        onDeleteComment={removeComment}
        onPinPost={togglePin}
        allPollVotes={pollVotes}
        onPollVote={voteOnPoll}
        allPosts={visiblePosts}
        onQuotePost={handleQuotePost}
        onToggleComments={toggleCommentsDisabled}
        onLoadComments={handleLoadComments}
        allProfiles={profilesList}
      />
    );
  }

  if (route.name === "bookmarks") {
    const bookmarkedPosts = visiblePosts.filter((p) => bookmarkIds.has(p.id));
    screen = (
      <div className="surface">
        <section className="home-intro">
          <h1>🔖 {lang === "zh" ? "書籤" : "Bookmarks"}</h1>
          {bookmarkedPosts.length === 0 && (
            <p style={{ color: "var(--text-muted)", marginTop: 8 }}>
              {lang === "zh" ? "尚無書籤。點擊帖上的 🔖 即可儲存。" : "No bookmarks yet. Tap 🔖 on any post to save it."}
            </p>
          )}
        </section>
        <Feed
          posts={bookmarkedPosts}
          currentProfile={currentProfile}
          allComments={comments}
          allReactions={reactions}
          allMedia={mediaItems}
          saving={isSaving}
          onComment={addComment}
          onReaction={react}
          onCommentReaction={addCommentReaction}
          onEditPost={editPost}
          onDeletePost={removePost}
          onEditComment={editComment}
          onDeleteComment={removeComment}
          onPinPost={togglePin}
          allPollVotes={pollVotes}
          onPollVote={voteOnPoll}
          allPosts={visiblePosts}
          onQuotePost={handleQuotePost}
          onToggleComments={toggleCommentsDisabled}
          onLoadComments={handleLoadComments}
          allProfiles={profilesList}
        />
      </div>
    );
  }

  return (
    <NowContext.Provider value={now}>
    <LangContext.Provider value={langValue}>
    <BookmarkContext.Provider value={bookmarkCtxValue}>
      <SyncingContext.Provider value={isSyncing}>
      <ReadOnlyContext.Provider value={guestMode}>
      <div className="app-shell" data-testid="app">
        <a href="#main-content" className="skip-nav">{lang === "zh" ? "跳到主要內容" : "Skip to main content"}</a>
        <Topbar
          currentProfile={currentProfile}
          syncing={isSyncing}
          guestMode={guestMode}
          unreadDms={unreadDms}
          unreadNotifs={unreadNotifs}
          notifications={notifications}
          onMenu={() => setSidebarOpen(true)}
          onMessages={() => { setUnreadDms(0); setMessagesOpen(true); }}
          onNotifRead={markNotifsRead}
          onLogout={() => {
            if (guestMode) {
              localStorage.removeItem("clawbook:guest");
              setGuestMode(false);
              navigate({ name: "identity" });
            } else {
              clearIdentitySession();
              setSession(null);
              navigate({ name: "identity" });
            }
          }}
        />
        <div className="social-layout-wrapper">
          {syncError ? (
            <div className="save-error-toast is-sync" role="alert">
              <span>Sync error: {syncError}</span>
              <button type="button" onClick={() => setSyncError(null)} aria-label="Dismiss error">
                ✕
              </button>
            </div>
          ) : null}
          {saveError ? (
            <SaveErrorToast message={saveError} onDismiss={() => setSaveError(null)} />
          ) : null}
          <div className="social-layout">
            <Sidebar currentProfile={currentProfile} route={route} open={sidebarOpen} unreadPosts={unreadPosts} lastActivityMap={profileLastActivity} onClose={() => setSidebarOpen(false)} />
            <section className="main-column" id="main-content">{screen}</section>
            <RightSidebar
              profiles={profilesList.length > 0 ? profilesList : profiles}
              posts={sortedPosts}
              comments={comments}
              reactions={reactions}
              currentProfile={currentProfile}
              onMessage={(p) => { setMessagesInitWith(p); setMessagesOpen(true); }}
            />
          </div>
        </div>
        <BottomNav route={route} currentProfile={currentProfile} unreadPosts={unreadPosts} onMenuOpen={() => setSidebarOpen(true)} />
        <BackToTop />
        {messagesOpen && !guestMode && (
          <MessagesPanel
            currentProfile={currentProfile}
            allProfiles={profilesList.length > 0 ? profilesList : profiles}
            initialWith={messagesInitWith}
            onClose={() => { setMessagesOpen(false); setMessagesInitWith(null); setUnreadDms(countUnreadDms()); }}
          />
        )}
      </div>
      </ReadOnlyContext.Provider>
      </SyncingContext.Provider>
    </BookmarkContext.Provider>
    </LangContext.Provider>
    </NowContext.Provider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found.");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <SocialApp />
    </ErrorBoundary>
  </StrictMode>,
);
