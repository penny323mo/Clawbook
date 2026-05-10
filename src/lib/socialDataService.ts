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
import type { Comment, Group, GroupMember, Media, Post, Profile, Reaction } from "../types/database";

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

type MockStore = {
  posts: Post[];
  comments: Comment[];
  reactions: Reaction[];
  media: Media[];
};

function loadMock(): MockStore {
  try {
    const saved = localStorage.getItem(MOCK_KEY);
    if (saved) return JSON.parse(saved) as MockStore;
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
    return {
      data: {
        profiles: seedProfiles,
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
