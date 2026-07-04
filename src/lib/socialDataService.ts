import { isSupabaseConfigured, storageBucket, supabase, setConnectionMode } from "./supabase";
import { checkPasscode } from "./passcodes";
import {
  comments as seedComments,
  groupMembers as seedGroupMembers,
  groups as seedGroups,
  media as seedMedia,
  posts as seedPosts,
  profiles as seedProfiles,
  reactions as seedReactions,
} from "../data/socialSeed";
import type { Comment, Group, GroupMember, Media, Post, Profile, PollVote, Reaction } from "../types/database";

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? "";
const SUPABASE_ANON = (
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ??
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)
)?.trim() ?? "";

// Cap the initial comment download so per-entry payload stays bounded as the
// comment table grows. Covers recent activity for bump-sort + active cards;
// older threads lazy-load in full via fetchAllCommentsForPost when opened.
const RECENT_COMMENT_LIMIT = 1500;

let forceMockFallback = typeof window !== "undefined" && localStorage.getItem("clawbook:forceMock") === "true";

async function callSecureMutate(
  action: string,
  payload: Record<string, unknown>,
): Promise<{ data: Record<string, unknown> | null; error: string | null }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/secure-mutate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON,
        "Authorization": `Bearer ${SUPABASE_ANON}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) return { data: null, error: (data.error as string) ?? "Request failed" };
    return { data, error: null };
  } catch (err) {
    return { data: null, error: String(err) };
  }
}

export async function verifyLogin(profileId: string, code: string): Promise<ServiceResult<Profile>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    const seed = seedProfiles.find((p) => p.id === profileId);
    if (!seed) return { data: null, error: "Unknown profile" };
    if (!checkPasscode(profileId, code, seed.passcode)) return { data: null, error: "Invalid passcode" };
    return { data: seed, error: null };
  }
  const { data, error } = await callSecureMutate("verify-login", { actor_id: profileId, code });
  if (error) return { data: null, error };
  return { data: data!.profile as Profile, error: null };
}

async function fetchAllRows<T>(
  queryBuilder: { range(from: number, to: number): Promise<{ data: T[] | null; error: unknown }> }
): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await queryBuilder.range(from, from + PAGE - 1);
    if (error || !data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// ----- result type -----

export type ServiceResult<T> = { data: T; error: null } | { data: null; error: string };

export type SocialData = {
  profiles: Profile[];
  groups: Group[];
  groupMembers: GroupMember[];
  posts: Post[];
  comments: Comment[];
  reactions: Reaction[];
  media: Media[];
  pollVotes: PollVote[];
};

// ----- mock localStorage -----

const MOCK_KEY = "clawbook:mock:social:v1";
const PROFILE_OVERRIDE_KEY = "clawbook:mock:profiles:v1";
const REGISTERED_KEY = "clawbook:registered:v1";

function loadRegisteredMock(): Profile[] {
  try {
    const saved = localStorage.getItem(REGISTERED_KEY);
    return saved ? (JSON.parse(saved) as Profile[]) : [];
  } catch { return []; }
}

function saveRegisteredMock(profiles: Profile[]): void {
  try { localStorage.setItem(REGISTERED_KEY, JSON.stringify(profiles)); } catch {}
}

type ProfileOverrides = Record<string, { bio?: string; status?: string; accent?: string; role?: string; avatar_url?: string }>;

function loadProfileOverrides(): ProfileOverrides {
  try {
    const saved = localStorage.getItem(PROFILE_OVERRIDE_KEY);
    return saved ? (JSON.parse(saved) as ProfileOverrides) : {};
  } catch { return {}; }
}

function saveProfileOverride(id: string, updates: { bio: string; status: string; accent?: string; role?: string; avatar_url?: string }) {
  const overrides = loadProfileOverrides();
  overrides[id] = updates;
  try { localStorage.setItem(PROFILE_OVERRIDE_KEY, JSON.stringify(overrides)); } catch {}
}

type MockStore = {
  posts: Post[];
  comments: Comment[];
  reactions: Reaction[];
  media: Media[];
  pollVotes: PollVote[];
};

function loadMock(): MockStore {
  try {
    const saved = localStorage.getItem(MOCK_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<MockStore>;
      if (parsed && Array.isArray(parsed.posts)) {
        return {
          posts: parsed.posts,
          comments: parsed.comments ?? [],
          reactions: parsed.reactions ?? [],
          media: parsed.media ?? [],
          pollVotes: parsed.pollVotes ?? [],
        };
      }
    }
  } catch {}
  return {
    posts: seedPosts,
    comments: seedComments,
    reactions: seedReactions,
    media: seedMedia,
    pollVotes: [],
  };
}

function saveMock(store: MockStore): void {
  try {
    localStorage.setItem(MOCK_KEY, JSON.stringify(store));
  } catch {}
}

// ----- public API -----

export async function fetchAuthorCounts(
  authorId: string,
): Promise<{ posts: number; comments: number } | null> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) return null;
  const [postRes, commentRes] = await Promise.all([
    supabase.from("posts").select("id", { count: "exact", head: true }).eq("author_id", authorId),
    supabase.from("comments").select("id", { count: "exact", head: true }).eq("author_id", authorId),
  ]);
  if (postRes.error || commentRes.error) return null;
  return { posts: postRes.count ?? 0, comments: commentRes.count ?? 0 };
}

export async function fetchPostById(postId: string): Promise<Post | null> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) return null;
  const { data, error } = await supabase.from("posts").select("*").eq("id", postId).maybeSingle();
  if (error || !data) return null;
  return data as Post;
}

export type CoreData = { profiles: Profile[]; groups: Group[]; groupMembers: GroupMember[]; pollVotes: PollVote[] };

export async function loadAllSocialData(
  onCore?: (core: CoreData) => void,
): Promise<ServiceResult<SocialData>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    const mock = loadMock();
    const overrides = loadProfileOverrides();
    const applyOverride = (p: Profile) => overrides[p.id] ? { ...p, ...overrides[p.id] } : p;
    const baseProfiles = seedProfiles.map(applyOverride);
    const registered = loadRegisteredMock().map(applyOverride);
    return {
      data: {
        profiles: [...baseProfiles, ...registered],
        groups: seedGroups,
        groupMembers: seedGroupMembers,
        ...mock,
      },
      error: null,
    };
  }

  try {
    const [profRes, grpRes, gmRes, pollRes] = await Promise.all([
      supabase.from("profiles").select("id, username, display_name, role, kind, avatar_url, avatar_initials, cover_url, bio, status, accent, is_active, created_at, updated_at").order("created_at"),
      supabase.from("groups").select("*").order("created_at"),
      supabase.from("group_members").select("*"),
      supabase.from("poll_votes").select("*"),
    ]);

    const firstErr = [profRes, grpRes, gmRes, pollRes].find((r) => r.error)?.error;
    if (firstErr) {
      console.warn("Supabase connection failed, falling back to mock data:", firstErr.message);
      forceMockFallback = true;
      setConnectionMode("mock");
      const mock = loadMock();
      const overrides = loadProfileOverrides();
      const applyOverride = (p: Profile) => overrides[p.id] ? { ...p, ...overrides[p.id] } : p;
      const baseProfiles = seedProfiles.map(applyOverride);
      const registered = loadRegisteredMock().map(applyOverride);
      return {
        data: {
          profiles: [...baseProfiles, ...registered],
          groups: seedGroups,
          groupMembers: seedGroupMembers,
          ...mock,
        },
        error: null,
      };
    }

    // Surface profiles/groups immediately so the member list and shell render
    // without waiting for the heavy feed tables below. Same array refs are
    // reused in the final result so the later state update is a no-op re-set.
    const coreProfiles = (profRes.data ?? []) as Profile[];
    const coreGroups = (grpRes.data ?? []) as Group[];
    const coreGroupMembers = (gmRes.data ?? []) as GroupMember[];
    const corePollVotes = (pollRes.data ?? []) as PollVote[];
    onCore?.({ profiles: coreProfiles, groups: coreGroups, groupMembers: coreGroupMembers, pollVotes: corePollVotes });

    // Posts + reactions load fully (posts power scroll-back to old threads;
    // reaction counts power the "top" sort). Comments are capped to the most
    // recent RECENT_COMMENT_LIMIT — enough to drive activity-bump ordering and
    // render active cards — while old threads lazy-load their full comments on
    // demand via fetchAllCommentsForPost. Keeps per-entry payload bounded as the
    // comment table grows, without truncating the post feed.
    const [posts, media, recentComments, reactions] = await Promise.all([
      fetchAllRows<Post>(supabase.from("posts").select("*").order("created_at", { ascending: false }) as never),
      fetchAllRows<Media>(supabase.from("media").select("*").order("created_at", { ascending: false }) as never),
      supabase.from("comments").select("*").order("created_at", { ascending: false }).limit(RECENT_COMMENT_LIMIT)
        .then(({ data }) => ((data ?? []) as Comment[]).reverse()),
      fetchAllRows<Reaction>(supabase.from("reactions").select("id,post_id,comment_id,author_id,emoji,created_at").order("created_at") as never),
    ]);
    const comments = recentComments;

    return {
      data: {
        profiles: coreProfiles,
        groups: coreGroups,
        groupMembers: coreGroupMembers,
        posts,
        comments,
        reactions,
        media,
        pollVotes: corePollVotes,
      },
      error: null,
    };
  } catch (err) {
    console.warn("Supabase load failed with exception, falling back to mock mode:", err);
    forceMockFallback = true;
    setConnectionMode("mock");
    const mock = loadMock();
    const overrides = loadProfileOverrides();
    const applyOverride = (p: Profile) => overrides[p.id] ? { ...p, ...overrides[p.id] } : p;
    const baseProfiles = seedProfiles.map(applyOverride);
    const registered = loadRegisteredMock().map(applyOverride);
    return {
      data: {
        profiles: [...baseProfiles, ...registered],
        groups: seedGroups,
        groupMembers: seedGroupMembers,
        ...mock,
      },
      error: null,
    };
  }
}

export async function persistPost(post: Post, newMedia: Media[], code: string): Promise<ServiceResult<Post>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    const mock = loadMock();
    mock.posts = [post, ...mock.posts.filter((p) => p.id !== post.id)];
    mock.media = [...newMedia, ...mock.media];
    saveMock(mock);
    return { data: post, error: null };
  }

  const { error } = await callSecureMutate("create-post", {
    actor_id: post.author_id, code,
    id: post.id, target_type: post.target_type, target_id: post.target_id, post_body: post.body,
    tags: post.tags, visibility: post.visibility, image_url: post.image_url ?? null,
    poll_options: post.poll_options ?? null, poll_ends_at: post.poll_ends_at ?? null,
    poll_allow_custom: post.poll_allow_custom ?? false, comments_disabled: post.comments_disabled ?? false,
    quote_post_id: post.quote_post_id ?? null,
    media: newMedia.map((m) => ({
      id: m.id, storage_bucket: m.storage_bucket, storage_path: m.storage_path,
      public_url: m.public_url ?? "", media_type: m.media_type,
      alt_text: m.alt_text ?? null, mime_type: m.mime_type ?? null, size_bytes: m.size_bytes ?? null,
    })),
  });
  if (error) return { data: null, error };
  return { data: post, error: null };
}

export async function updatePost(
  postId: string,
  updates: { body: string; tags: string[] },
  actorId: string,
  code: string,
): Promise<ServiceResult<Post>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    const mock = loadMock();
    mock.posts = mock.posts.map((p) =>
      p.id === postId ? { ...p, body: updates.body, tags: updates.tags, updated_at: new Date().toISOString() } : p,
    );
    saveMock(mock);
    const updated = mock.posts.find((p) => p.id === postId);
    return updated ? { data: updated, error: null } : { data: null, error: "Post not found" };
  }

  const { data, error } = await callSecureMutate("update-post", {
    actor_id: actorId, code, post_id: postId, post_body: updates.body, tags: updates.tags,
  });
  if (error) return { data: null, error };
  return { data: data!.post as Post, error: null };
}

export async function pinPost(postId: string, pinned: boolean, actorId: string, code: string): Promise<ServiceResult<Post>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    const mock = loadMock();
    mock.posts = mock.posts.map((p) => p.id === postId ? { ...p, is_pinned: pinned } : p);
    saveMock(mock);
    const updated = mock.posts.find((p) => p.id === postId);
    return updated ? { data: updated, error: null } : { data: null, error: "Post not found" };
  }
  const { data, error } = await callSecureMutate("pin-post", { actor_id: actorId, code, post_id: postId, pinned });
  if (error) return { data: null, error };
  return { data: data!.post as Post, error: null };
}

export async function setCommentsDisabled(postId: string, disabled: boolean, actorId: string, code: string): Promise<ServiceResult<Post>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    const mock = loadMock();
    mock.posts = mock.posts.map((p) => p.id === postId ? { ...p, comments_disabled: disabled } : p);
    saveMock(mock);
    const updated = mock.posts.find((p) => p.id === postId);
    return updated ? { data: updated, error: null } : { data: null, error: "Post not found" };
  }
  const { data, error } = await callSecureMutate("set-comments-disabled", { actor_id: actorId, code, post_id: postId, disabled });
  if (error) return { data: null, error };
  return { data: data!.post as Post, error: null };
}

export async function deletePost(postId: string, actorId: string, code: string): Promise<ServiceResult<{ deleted: true }>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    const mock = loadMock();
    mock.posts = mock.posts.filter((p) => p.id !== postId);
    saveMock(mock);
    return { data: { deleted: true }, error: null };
  }

  const { error } = await callSecureMutate("delete-post", { actor_id: actorId, code, post_id: postId });
  if (error) return { data: null, error };
  return { data: { deleted: true }, error: null };
}

export async function fetchAllCommentsForPost(postId: string): Promise<Comment[]> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    return loadMock().comments.filter((c) => c.post_id === postId);
  }
  return fetchAllRows<Comment>(
    supabase.from("comments").select("*").eq("post_id", postId).order("created_at") as never
  );
}

export async function persistComment(comment: Comment, code: string): Promise<ServiceResult<Comment>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    const mock = loadMock();
    mock.comments = [...mock.comments, comment];
    saveMock(mock);
    return { data: comment, error: null };
  }

  const { error } = await callSecureMutate("create-comment", {
    actor_id: comment.author_id, code,
    id: comment.id, post_id: comment.post_id, comment_body: comment.body,
    reply_to_id: comment.reply_to_id ?? null,
  });
  if (error) return { data: null, error };
  return { data: comment, error: null };
}

export async function updateComment(
  commentId: string,
  body: string,
  actorId: string,
  code: string,
): Promise<ServiceResult<Comment>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    const mock = loadMock();
    mock.comments = mock.comments.map((c) =>
      c.id === commentId ? { ...c, body, updated_at: new Date().toISOString() } : c,
    );
    saveMock(mock);
    const updated = mock.comments.find((c) => c.id === commentId);
    return updated ? { data: updated, error: null } : { data: null, error: "Comment not found" };
  }

  const { data, error } = await callSecureMutate("update-comment", {
    actor_id: actorId, code, comment_id: commentId, comment_body: body,
  });
  if (error) return { data: null, error };
  return { data: data!.comment as Comment, error: null };
}

export async function deleteComment(commentId: string, actorId: string, code: string): Promise<ServiceResult<{ deleted: true }>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    const mock = loadMock();
    mock.comments = mock.comments.filter((c) => c.id !== commentId);
    saveMock(mock);
    return { data: { deleted: true }, error: null };
  }

  const { error } = await callSecureMutate("delete-comment", { actor_id: actorId, code, comment_id: commentId });
  if (error) return { data: null, error };
  return { data: { deleted: true }, error: null };
}

export async function toggleReaction(
  reaction: Reaction,
  code: string,
): Promise<ServiceResult<{ action: "added" | "removed" }>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    const mock = loadMock();
    const sameReaction = (r: Reaction) =>
      r.post_id === reaction.post_id &&
      r.author_id === reaction.author_id &&
      r.emoji === reaction.emoji &&
      (r.comment_id ?? null) === (reaction.comment_id ?? null);
    const exists = mock.reactions.some(sameReaction);
    if (exists) {
      mock.reactions = mock.reactions.filter((r) => !sameReaction(r));
      saveMock(mock);
      return { data: { action: "removed" }, error: null };
    }
    mock.reactions = [...mock.reactions, reaction];
    saveMock(mock);
    return { data: { action: "added" }, error: null };
  }

  let lookupQuery = supabase
    .from("reactions")
    .select("id")
    .eq("post_id", reaction.post_id)
    .eq("author_id", reaction.author_id)
    .eq("emoji", reaction.emoji);
  lookupQuery = reaction.comment_id
    ? lookupQuery.eq("comment_id", reaction.comment_id)
    : lookupQuery.is("comment_id", null);
  const { data: existing } = await lookupQuery.maybeSingle();

  if (existing) {
    const { error } = await callSecureMutate("delete-reaction", {
      actor_id: reaction.author_id, code, reaction_id: existing.id,
    });
    if (error) return { data: null, error };
    return { data: { action: "removed" }, error: null };
  }

  const { error } = await callSecureMutate("add-reaction", {
    actor_id: reaction.author_id, code,
    id: reaction.id, post_id: reaction.post_id, comment_id: reaction.comment_id ?? null, emoji: reaction.emoji,
  });
  if (error) return { data: null, error };
  return { data: { action: "added" }, error: null };
}

export async function uploadMediaFile(
  file: File,
  ownerId: string,
  postId: string,
  code: string,
): Promise<ServiceResult<Media>> {
  const now = new Date().toISOString();
  const date = now.slice(0, 10);
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `${ownerId}/${date}/${postId}/${safeName}`;

  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    return {
      data: {
        id: `media-local-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
        owner_id: ownerId,
        post_id: postId,
        storage_bucket: storageBucket,
        storage_path: storagePath,
        public_url: URL.createObjectURL(file),
        media_type: "image",
        alt_text: file.name,
        mime_type: file.type || null,
        size_bytes: file.size || null,
        width: null,
        height: null,
        created_at: now,
      },
      error: null,
    };
  }

  // The signed upload URL is minted server-side (secure-mutate verifies actor_id
  // + code and scopes the path to that actor) so anon never needs its own
  // storage.objects INSERT/UPDATE grant.
  const { data: urlData, error: urlErr } = await callSecureMutate("create-upload-url", {
    actor_id: ownerId, code, post_id: postId, file_name: file.name,
  });
  if (urlErr) return { data: null, error: urlErr };
  const { storage_path, token, bucket } = urlData as unknown as { storage_path: string; token: string; bucket: string };

  const { error: uploadErr } = await supabase.storage.from(bucket).uploadToSignedUrl(storage_path, token, file);
  if (uploadErr) return { data: null, error: uploadErr.message };

  const { data: pubData } = supabase.storage.from(bucket).getPublicUrl(storage_path);

  const media: Media = {
    id: `media-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    owner_id: ownerId,
    post_id: postId,
    storage_bucket: bucket,
    storage_path,
    public_url: pubData.publicUrl,
    media_type: "image",
    alt_text: file.name,
    mime_type: file.type || null,
    size_bytes: file.size || null,
    width: null,
    height: null,
    created_at: now,
  };

  // DB insert happens in persistPost after the post row exists (avoids FK violation)
  return { data: media, error: null };
}

export async function loadDirectMessages(
  profileId: string,
  code: string,
): Promise<ServiceResult<import("../types/database").DirectMessage[]>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    return { data: [], error: null };
  }
  const { data, error } = await callSecureMutate("list-direct-messages", { actor_id: profileId, code });
  if (error) return { data: null, error };
  return { data: (data!.messages as import("../types/database").DirectMessage[]) ?? [], error: null };
}

export async function persistDirectMessage(
  msg: import("../types/database").DirectMessage,
  code: string,
): Promise<ServiceResult<import("../types/database").DirectMessage>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    return { data: msg, error: null };
  }
  const { error } = await callSecureMutate("send-direct-message", {
    actor_id: msg.from_id, code, id: msg.id, to_id: msg.to_id, body: msg.body,
  });
  if (error) return { data: null, error };
  return { data: msg, error: null };
}

export async function markMessagesRead(
  fromId: string,
  toId: string,
  code: string,
): Promise<ServiceResult<{ updated: true }>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    return { data: { updated: true }, error: null };
  }
  const { error } = await callSecureMutate("mark-messages-read", { actor_id: toId, code, from_id: fromId });
  if (error) return { data: null, error };
  return { data: { updated: true }, error: null };
}

export async function registerProfile(
  displayName: string,
  passcode: string,
  adminCode: string,
): Promise<ServiceResult<Profile>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    // Mock mode: validate admin code then store locally
    if (!checkPasscode("penny", adminCode)) return { data: null, error: "Invalid admin code" };
    const id = displayName.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (!id) return { data: null, error: "Invalid display name" };
    const existing = loadRegisteredMock();
    if (existing.some((p) => p.id === id)) return { data: null, error: "Username already taken" };
    const initials = displayName.trim().split(/\s+/).map((w) => w[0]?.toUpperCase() ?? "").join("").slice(0, 2) || "?";
    const now = new Date().toISOString();
    const profile: Profile = {
      id, username: id, display_name: displayName.trim(), kind: "human", role: "Member",
      avatar_initials: initials, avatar_url: null, cover_url: null, bio: "", status: "",
      accent: "#6b7280", is_active: true, passcode: passcode.trim(), created_at: now, updated_at: now,
    };
    saveRegisteredMock([...existing, profile]);
    return { data: profile, error: null };
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/user-admin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON,
        "Authorization": `Bearer ${SUPABASE_ANON}`,
      },
      body: JSON.stringify({ action: "register", admin_code: adminCode, display_name: displayName, passcode }),
    });
    const data = await res.json() as { profile?: Profile; error?: string };
    if (!res.ok || !data.profile) return { data: null, error: data.error ?? "Registration failed" };
    return { data: data.profile, error: null };
  } catch (err) {
    return { data: null, error: String(err) };
  }
}

export async function deleteRegisteredProfile(
  profileId: string,
  adminCode: string,
): Promise<ServiceResult<{ deleted: true }>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    if (!checkPasscode("penny", adminCode)) return { data: null, error: "Invalid admin code" };
    const existing = loadRegisteredMock();
    saveRegisteredMock(existing.filter((p) => p.id !== profileId));
    return { data: { deleted: true }, error: null };
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/user-admin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON,
        "Authorization": `Bearer ${SUPABASE_ANON}`,
      },
      body: JSON.stringify({ action: "delete", admin_code: adminCode, profile_id: profileId }),
    });
    const data = await res.json() as { deleted?: string; error?: string };
    if (!res.ok) return { data: null, error: data.error ?? "Deletion failed" };
    return { data: { deleted: true }, error: null };
  } catch (err) {
    return { data: null, error: String(err) };
  }
}

export async function updateProfile(
  profileId: string,
  updates: { bio: string; status: string; accent?: string; role?: string; avatar_url?: string },
  code: string,
): Promise<ServiceResult<Profile>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    saveProfileOverride(profileId, updates);
    const base =
      seedProfiles.find((p) => p.id === profileId) ??
      loadRegisteredMock().find((p) => p.id === profileId);
    if (!base) return { data: null, error: "Profile not found" };
    return { data: { ...base, ...updates }, error: null };
  }

  const { data, error } = await callSecureMutate("update-profile", {
    actor_id: profileId, code, profile_id: profileId, updates,
  });
  if (error) return { data: null, error };
  return { data: data!.profile as Profile, error: null };
}

// ----- polls -----

export async function loadPollVotes(): Promise<PollVote[]> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) return loadMock().pollVotes;
  const { data, error } = await supabase.from("poll_votes").select("*");
  if (error) return [];
  return (data ?? []) as PollVote[];
}

export async function castPollVote(
  postId: string,
  profileId: string,
  optionIdx: number,
  currentVoteIdx: number | null,
  customText: string | undefined,
  code: string,
): Promise<ServiceResult<null>> {
  if (!isSupabaseConfigured || !supabase || forceMockFallback) {
    const mock = loadMock();
    if (currentVoteIdx === optionIdx && !(optionIdx === -1)) {
      mock.pollVotes = mock.pollVotes.filter((v) => !(v.post_id === postId && v.profile_id === profileId));
    } else {
      mock.pollVotes = [
        ...mock.pollVotes.filter((v) => !(v.post_id === postId && v.profile_id === profileId)),
        { post_id: postId, profile_id: profileId, option_idx: optionIdx, custom_text: customText ?? null, created_at: new Date().toISOString() },
      ];
    }
    saveMock(mock);
    return { data: null, error: null };
  }
  const { error } = await callSecureMutate("cast-poll-vote", {
    actor_id: profileId, code, post_id: postId, option_idx: optionIdx, current_vote_idx: currentVoteIdx, custom_text: customText,
  });
  if (error) return { data: null, error };
  return { data: null, error: null };
}
