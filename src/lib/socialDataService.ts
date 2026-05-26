import { isSupabaseConfigured, storageBucket, supabase } from "./supabase";
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
        };
      }
    }
  } catch {}
  return {
    posts: seedPosts,
    comments: seedComments,
    reactions: seedReactions,
    media: seedMedia,
  };
}

function saveMock(store: MockStore): void {
  try {
    localStorage.setItem(MOCK_KEY, JSON.stringify(store));
  } catch {}
}

// ----- public API -----

export async function loadAllSocialData(): Promise<ServiceResult<SocialData>> {
  if (!isSupabaseConfigured || !supabase) {
    const mock = loadMock();
    const overrides = loadProfileOverrides();
    const baseProfiles = seedProfiles.map((p) =>
      overrides[p.id] ? { ...p, ...overrides[p.id] } : p,
    );
    const registered = loadRegisteredMock();
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
    const [profRes, grpRes, gmRes, postRes, cmtRes, rxRes, mediaRes] = await Promise.all([
      supabase.from("profiles").select("*").order("created_at"),
      supabase.from("groups").select("*").order("created_at"),
      supabase.from("group_members").select("*"),
      supabase.from("posts").select("*").order("created_at", { ascending: false }),
      supabase.from("comments").select("*").order("created_at"),
      supabase.from("reactions").select("*"),
      supabase.from("media").select("*").order("created_at"),
    ]);

    const firstErr = [profRes, grpRes, gmRes, postRes, cmtRes, rxRes, mediaRes].find((r) => r.error)?.error;
    if (firstErr) return { data: null, error: firstErr.message };

    return {
      data: {
        profiles: (profRes.data ?? []) as Profile[],
        groups: (grpRes.data ?? []) as Group[],
        groupMembers: (gmRes.data ?? []) as GroupMember[],
        posts: (postRes.data ?? []) as Post[],
        comments: (cmtRes.data ?? []) as Comment[],
        reactions: (rxRes.data ?? []) as Reaction[],
        media: (mediaRes.data ?? []) as Media[],
      },
      error: null,
    };
  } catch (err) {
    return { data: null, error: String(err) };
  }
}

export async function persistPost(post: Post, newMedia: Media[]): Promise<ServiceResult<Post>> {
  if (!isSupabaseConfigured || !supabase) {
    const mock = loadMock();
    mock.posts = [post, ...mock.posts.filter((p) => p.id !== post.id)];
    mock.media = [...newMedia, ...mock.media];
    saveMock(mock);
    return { data: post, error: null };
  }

  const { error: postErr } = await supabase.from("posts").insert({
    id: post.id,
    author_id: post.author_id,
    target_type: post.target_type,
    target_id: post.target_id,
    body: post.body,
    tags: post.tags,
    visibility: post.visibility,
    image_url: post.image_url ?? null,
  });
  if (postErr) return { data: null, error: postErr.message };

  if (newMedia.length > 0) {
    const { error: mediaErr } = await supabase.from("media").insert(
      newMedia.map((m) => ({
        id: m.id,
        owner_id: m.owner_id,
        post_id: post.id,
        storage_bucket: m.storage_bucket,
        storage_path: m.storage_path,
        public_url: m.public_url ?? "",
        media_type: m.media_type,
        alt_text: m.alt_text ?? null,
        mime_type: m.mime_type ?? null,
        size_bytes: m.size_bytes ?? null,
      })),
    );
    if (mediaErr) return { data: null, error: mediaErr.message };
  }

  return { data: post, error: null };
}

export async function updatePost(
  postId: string,
  updates: { body: string; tags: string[] },
): Promise<ServiceResult<Post>> {
  if (!isSupabaseConfigured || !supabase) {
    const mock = loadMock();
    mock.posts = mock.posts.map((p) =>
      p.id === postId ? { ...p, body: updates.body, tags: updates.tags, updated_at: new Date().toISOString() } : p,
    );
    saveMock(mock);
    const updated = mock.posts.find((p) => p.id === postId);
    return updated ? { data: updated, error: null } : { data: null, error: "Post not found" };
  }

  const { data, error } = await supabase
    .from("posts")
    .update({ body: updates.body, tags: updates.tags, updated_at: new Date().toISOString() })
    .eq("id", postId)
    .select()
    .single();
  if (error) return { data: null, error: error.message };
  return { data: data as Post, error: null };
}

export async function pinPost(postId: string, pinned: boolean): Promise<ServiceResult<Post>> {
  if (!isSupabaseConfigured || !supabase) {
    const mock = loadMock();
    mock.posts = mock.posts.map((p) => p.id === postId ? { ...p, is_pinned: pinned } : p);
    saveMock(mock);
    const updated = mock.posts.find((p) => p.id === postId);
    return updated ? { data: updated, error: null } : { data: null, error: "Post not found" };
  }
  const { data, error } = await supabase
    .from("posts")
    .update({ is_pinned: pinned })
    .eq("id", postId)
    .select()
    .single();
  if (error) return { data: null, error: error.message };
  return { data: data as Post, error: null };
}

export async function deletePost(postId: string): Promise<ServiceResult<{ deleted: true }>> {
  if (!isSupabaseConfigured || !supabase) {
    const mock = loadMock();
    mock.posts = mock.posts.filter((p) => p.id !== postId);
    saveMock(mock);
    return { data: { deleted: true }, error: null };
  }

  const { error } = await supabase.from("posts").delete().eq("id", postId);
  if (error) return { data: null, error: error.message };
  return { data: { deleted: true }, error: null };
}

export async function persistComment(comment: Comment): Promise<ServiceResult<Comment>> {
  if (!isSupabaseConfigured || !supabase) {
    const mock = loadMock();
    mock.comments = [...mock.comments, comment];
    saveMock(mock);
    return { data: comment, error: null };
  }

  const { error } = await supabase.from("comments").insert({
    id: comment.id,
    post_id: comment.post_id,
    author_id: comment.author_id,
    body: comment.body,
  });
  if (error) return { data: null, error: error.message };
  return { data: comment, error: null };
}

export async function updateComment(
  commentId: string,
  body: string,
): Promise<ServiceResult<Comment>> {
  if (!isSupabaseConfigured || !supabase) {
    const mock = loadMock();
    mock.comments = mock.comments.map((c) =>
      c.id === commentId ? { ...c, body, updated_at: new Date().toISOString() } : c,
    );
    saveMock(mock);
    const updated = mock.comments.find((c) => c.id === commentId);
    return updated ? { data: updated, error: null } : { data: null, error: "Comment not found" };
  }

  const { data, error } = await supabase
    .from("comments")
    .update({ body, updated_at: new Date().toISOString() })
    .eq("id", commentId)
    .select()
    .single();
  if (error) return { data: null, error: error.message };
  return { data: data as Comment, error: null };
}

export async function deleteComment(commentId: string): Promise<ServiceResult<{ deleted: true }>> {
  if (!isSupabaseConfigured || !supabase) {
    const mock = loadMock();
    mock.comments = mock.comments.filter((c) => c.id !== commentId);
    saveMock(mock);
    return { data: { deleted: true }, error: null };
  }

  const { error } = await supabase.from("comments").delete().eq("id", commentId);
  if (error) return { data: null, error: error.message };
  return { data: { deleted: true }, error: null };
}

export async function toggleReaction(
  reaction: Reaction,
): Promise<ServiceResult<{ action: "added" | "removed" }>> {
  if (!isSupabaseConfigured || !supabase) {
    const mock = loadMock();
    const exists = mock.reactions.some(
      (r) => r.post_id === reaction.post_id && r.author_id === reaction.author_id && r.emoji === reaction.emoji,
    );
    if (exists) {
      mock.reactions = mock.reactions.filter(
        (r) => !(r.post_id === reaction.post_id && r.author_id === reaction.author_id && r.emoji === reaction.emoji),
      );
      saveMock(mock);
      return { data: { action: "removed" }, error: null };
    }
    mock.reactions = [...mock.reactions, reaction];
    saveMock(mock);
    return { data: { action: "added" }, error: null };
  }

  const { data: existing } = await supabase
    .from("reactions")
    .select("id")
    .eq("post_id", reaction.post_id)
    .eq("author_id", reaction.author_id)
    .eq("emoji", reaction.emoji)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase.from("reactions").delete().eq("id", existing.id);
    if (error) return { data: null, error: error.message };
    return { data: { action: "removed" }, error: null };
  }

  const { error } = await supabase.from("reactions").insert({
    id: reaction.id,
    post_id: reaction.post_id,
    comment_id: reaction.comment_id ?? null,
    author_id: reaction.author_id,
    emoji: reaction.emoji,
  });
  if (error) return { data: null, error: error.message };
  return { data: { action: "added" }, error: null };
}

export async function uploadMediaFile(
  file: File,
  ownerId: string,
  postId: string,
): Promise<ServiceResult<Media>> {
  const now = new Date().toISOString();
  const date = now.slice(0, 10);
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `${ownerId}/${date}/${postId}/${safeName}`;

  if (!isSupabaseConfigured || !supabase) {
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

  const { error: uploadErr } = await supabase.storage
    .from(storageBucket)
    .upload(storagePath, file, { cacheControl: "3600", upsert: false });
  if (uploadErr) return { data: null, error: uploadErr.message };

  const { data: urlData } = supabase.storage.from(storageBucket).getPublicUrl(storagePath);

  const media: Media = {
    id: `media-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    owner_id: ownerId,
    post_id: postId,
    storage_bucket: storageBucket,
    storage_path: storagePath,
    public_url: urlData.publicUrl,
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
): Promise<ServiceResult<import("../types/database").DirectMessage[]>> {
  if (!isSupabaseConfigured || !supabase) {
    return { data: [], error: null };
  }
  const { data, error } = await supabase
    .from("direct_messages")
    .select("*")
    .or(`from_id.eq.${profileId},to_id.eq.${profileId}`)
    .order("created_at");
  if (error) return { data: null, error: error.message };
  return { data: data as import("../types/database").DirectMessage[], error: null };
}

export async function persistDirectMessage(
  msg: import("../types/database").DirectMessage,
): Promise<ServiceResult<import("../types/database").DirectMessage>> {
  if (!isSupabaseConfigured || !supabase) {
    return { data: msg, error: null };
  }
  const { error } = await supabase.from("direct_messages").insert({
    id: msg.id,
    from_id: msg.from_id,
    to_id: msg.to_id,
    body: msg.body,
    read: msg.read,
  });
  if (error) return { data: null, error: error.message };
  return { data: msg, error: null };
}

export async function markMessagesRead(
  fromId: string,
  toId: string,
): Promise<ServiceResult<{ updated: true }>> {
  if (!isSupabaseConfigured || !supabase) {
    return { data: { updated: true }, error: null };
  }
  const { error } = await supabase
    .from("direct_messages")
    .update({ read: true })
    .eq("from_id", fromId)
    .eq("to_id", toId)
    .eq("read", false);
  if (error) return { data: null, error: error.message };
  return { data: { updated: true }, error: null };
}

export async function registerProfile(
  displayName: string,
  passcode: string,
  adminCode: string,
): Promise<ServiceResult<Profile>> {
  if (!isSupabaseConfigured || !supabase) {
    // Mock mode: store locally
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
  if (!isSupabaseConfigured || !supabase) {
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
): Promise<ServiceResult<Profile>> {
  if (!isSupabaseConfigured || !supabase) {
    saveProfileOverride(profileId, updates);
    const base = seedProfiles.find((p) => p.id === profileId);
    if (!base) return { data: null, error: "Profile not found" };
    return { data: { ...base, ...updates }, error: null };
  }

  const patch: Partial<Profile> = { bio: updates.bio, status: updates.status };
  if (updates.accent) patch.accent = updates.accent;
  if (updates.role) patch.role = updates.role;
  if (updates.avatar_url) patch.avatar_url = updates.avatar_url;

  const { data, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", profileId)
    .select()
    .single();
  if (error) return { data: null, error: error.message };
  return { data: data as Profile, error: null };
}

// ----- polls -----

export async function loadPollVotes(): Promise<PollVote[]> {
  if (!isSupabaseConfigured || !supabase) return [];
  const { data, error } = await supabase.from("poll_votes").select("*");
  if (error) return [];
  return (data ?? []) as PollVote[];
}

export async function castPollVote(
  postId: string,
  profileId: string,
  optionIdx: number,
  currentVoteIdx: number | null,
): Promise<ServiceResult<null>> {
  if (!isSupabaseConfigured || !supabase) return { data: null, error: "Not connected" };
  if (currentVoteIdx === optionIdx) {
    // Toggle off — remove vote
    const { error } = await supabase
      .from("poll_votes")
      .delete()
      .eq("post_id", postId)
      .eq("profile_id", profileId);
    if (error) return { data: null, error: error.message };
    return { data: null, error: null };
  }
  // Insert or update to new option
  const { error } = await supabase
    .from("poll_votes")
    .upsert({ post_id: postId, profile_id: profileId, option_idx: optionIdx }, { onConflict: "post_id,profile_id" });
  if (error) return { data: null, error: error.message };
  return { data: null, error: null };
}
