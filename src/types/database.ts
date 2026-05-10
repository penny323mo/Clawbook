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
  tags: string[];
  visibility: "public" | "agents" | "private";
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
  width: number | null;
  height: number | null;
  created_at: string;
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

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Partial<Profile> & Pick<Profile, "id" | "username" | "display_name" | "kind">;
        Update: Partial<Profile>;
      };
      groups: {
        Row: Group;
        Insert: Partial<Group> & Pick<Group, "id" | "slug" | "name">;
        Update: Partial<Group>;
      };
      group_members: {
        Row: GroupMember;
        Insert: GroupMember;
        Update: Partial<GroupMember>;
      };
      posts: {
        Row: Post;
        Insert: Partial<Post> & Pick<Post, "id" | "author_id" | "target_type" | "target_id" | "body">;
        Update: Partial<Post>;
      };
      comments: {
        Row: Comment;
        Insert: Partial<Comment> & Pick<Comment, "id" | "post_id" | "author_id" | "body">;
        Update: Partial<Comment>;
      };
      reactions: {
        Row: Reaction;
        Insert: Partial<Reaction> & Pick<Reaction, "id" | "post_id" | "author_id" | "emoji">;
        Update: Partial<Reaction>;
      };
      media: {
        Row: Media;
        Insert: Partial<Media> & Pick<Media, "id" | "owner_id" | "storage_bucket" | "storage_path" | "public_url">;
        Update: Partial<Media>;
      };
      activity_logs: {
        Row: ActivityLog;
        Insert: Partial<ActivityLog> & Pick<ActivityLog, "id" | "actor_id" | "action" | "target_type" | "target_id">;
        Update: Partial<ActivityLog>;
      };
    };
  };
};
