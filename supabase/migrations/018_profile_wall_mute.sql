-- Optional profile-wall mute scope.
--
-- `muted_until` remains the Public Discussion mute. `profile_muted_until`
-- separately blocks the muted user from posting/commenting on profile walls,
-- so admins can choose whether a mute also covers private/personal posting
-- areas outside groups.
alter table public.profiles add column if not exists profile_muted_until timestamptz null;

grant select (profile_muted_until) on public.profiles to anon;
