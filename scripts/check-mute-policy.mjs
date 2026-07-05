import { readFile } from "node:fs/promises";

const secureMutate = await readFile("supabase/functions/secure-mutate/index.ts", "utf8");
const migration = await readFile("supabase/migrations/018_profile_wall_mute.sql", "utf8")
  .catch(() => "");
const types = await readFile("src/types/database.ts", "utf8");
const service = await readFile("src/lib/socialDataService.ts", "utf8");
const main = await readFile("src/main.tsx", "utf8");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  migration.includes("profile_muted_until"),
  "migration must add profile_muted_until for optional profile-wall muting",
);
assert(
  secureMutate.includes("profile_muted_until"),
  "secure-mutate must read and update profile_muted_until",
);
assert(
  /function isMutedTarget\([^)]*targetType[^)]*targetId[^)]*actorRow/.test(secureMutate),
  "isMutedTarget must consider the target and the authenticated actor mute state",
);
assert(
  /targetType === "profile"[\s\S]*actorRow\.profile_muted_until/.test(secureMutate) &&
    !/targetType === "profile" && targetId === actorId/.test(secureMutate),
  "profile-wall mute must cover every profile wall, not only the muted user's own wall",
);
assert(
  /profile_muted_until && new Date\(actorRow\.profile_muted_until\)/.test(secureMutate),
  "create-post/create-comment must enforce profile_muted_until",
);
assert(
  types.includes("profile_muted_until?: string | null"),
  "Profile type must expose profile_muted_until",
);
assert(
  /profileMutedUntil: string \| null/.test(service) &&
    service.includes("profile_muted_until: profileMutedUntil"),
  "setMute client call must send profile_muted_until separately",
);
assert(
  main.includes("muteProfileWall") && main.includes("profile_muted_until"),
  "moderation UI must expose a profile-wall mute option",
);
assert(
  main.includes("customMuteUntil") &&
    main.includes('type="datetime-local"') &&
    main.includes("applyCustomMute"),
  "moderation UI must allow a custom mute date/time",
);

console.log("Mute policy checks passed.");
