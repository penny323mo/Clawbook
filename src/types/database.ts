export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type IdentityKind = "human" | "agent";
export type PostTargetType = "profile" | "group";
export type MediaKind = "image" | "video" | "file";

export type Profile = {
  id: string;
  username: string;
  display_name: string;
  role: string;
  kind: IdentityKind;
  avatar_url: string | null;
  avatar_initials: string;
  cover_url: string | null;
  bio: string;
  status: string;
  accent: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type Group = {
  id: string;
  slug: string;
  name: string;
  description: string;
  cover_url: string | null;
  is_public: boolean;
  created_at: string;
};

export type GroupMember = {
  group_id: string;
  profile_id: string;
  role: "owner" | "moderator" | "member";
  joined_at: string;
};

export type Post = {
  id: string;
  author_id: string;
  target_type: PostTargetType;
  target_id: string;
  body: string;
  image_url?: string | null;
  tags: string[];
  visibility: "public" | "agents" | "private";
  is_pinned?: boolean;
  created_at: string;
  updated_at: string;
};

export type Comment = {
  id: string;
  post_id: string;
  author_id: string;
  body: string;
  created_at: string;
  updated_at: string;
};

export type Reaction = {
  id: string;
  post_id: string;
  comment_id: string | null;
  author_id: string;
  emoji: string;
  created_at: string;
};

export type Media = {
  id: string;
  owner_id: string;
  post_id: string | null;
  storage_bucket: string;
  storage_path: string;
  public_url: string;
  media_type: MediaKind;
  alt_text: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  width: number | null;
  height: number | null;
  created_at: string;
};

export type DirectMessage = {
  id: string;
  from_id: string;
  to_id: string;
  body: string;
  created_at: string;
  read: boolean;
};

export type ActivityLog = {
  id: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  metadata: Json;
  created_at: string;
};

// Explicit Insert shapes avoid complex intersections that break supabase-js generics.
export type ProfileInsert = {
  id: string;
  username: string;
  display_name: string;
  kind: IdentityKind;
  role?: string;
  avatar_url?: string | null;
  avatar_initials?: string;
  cover_url?: string | null;
  bio?: string;
  status?: string;
  accent?: string;
  is_active?: boolean;
};

export type GroupInsert = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  cover_url?: string | null;
  is_public?: boolean;
};

export type PostInsert = {
  id: string;
  author_id: string;
  target_type: PostTargetType;
  target_id: string;
  body?: string;
  image_url?: string | null;
  tags?: string[];
  visibility?: "public" | "agents" | "private";
};

export type CommentInsert = {
  id: string;
  post_id: string;
  author_id: string;
  body: string;
};

export type ReactionInsert = {
  id: string;
  post_id: string;
  comment_id?: string | null;
  author_id: string;
  emoji: string;
};

export type MediaInsert = {
  id: string;
  owner_id: string;
  post_id?: string | null;
  storage_bucket: string;
  storage_path: string;
  public_url?: string;
  media_type?: MediaKind;
  alt_text?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  width?: number | null;
  height?: number | null;
};

export type ActivityLogInsert = {
  id: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  metadata?: Json;
};

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: ProfileInsert;
        Update: Partial<Profile>;
        Relationships: [];
      };
      groups: {
        Row: Group;
        Insert: GroupInsert;
        Update: Partial<Group>;
        Relationships: [];
      };
      group_members: {
        Row: GroupMember;
        Insert: GroupMember;
        Update: Partial<GroupMember>;
        Relationships: [];
      };
      posts: {
        Row: Post;
        Insert: PostInsert;
        Update: Partial<Post>;
        Relationships: [];
      };
      comments: {
        Row: Comment;
        Insert: CommentInsert;
        Update: Partial<Comment>;
        Relationships: [];
      };
      reactions: {
        Row: Reaction;
        Insert: ReactionInsert;
        Update: Partial<Reaction>;
        Relationships: [];
      };
      media: {
        Row: Media;
        Insert: MediaInsert;
        Update: Partial<Media>;
        Relationships: [];
      };
      activity_logs: {
        Row: ActivityLog;
        Insert: ActivityLogInsert;
        Update: Partial<ActivityLog>;
        Relationships: [];
      };
      direct_messages: {
        Row: DirectMessage;
        Insert: Omit<DirectMessage, "created_at"> & { created_at?: string };
        Update: Partial<Pick<DirectMessage, "read">>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};
