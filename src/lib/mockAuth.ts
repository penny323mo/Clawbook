import type { Profile } from "../types/database";

const SESSION_KEY = "clawbook:identity-session:v2";

export type IdentitySession = {
  profileId: string;
  displayName: string;
  startedAt: string;
  code: string;
};

export function loadIdentitySession(): IdentitySession | null {
  try {
    const saved = window.localStorage.getItem(SESSION_KEY);
    return saved ? (JSON.parse(saved) as IdentitySession) : null;
  } catch {
    return null;
  }
}

export function saveIdentitySession(profile: Profile, code: string) {
  const session: IdentitySession = {
    profileId: profile.id,
    displayName: profile.display_name,
    startedAt: new Date().toISOString(),
    code,
  };
  try { window.localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
  return session;
}

export function clearIdentitySession() {
  window.localStorage.removeItem(SESSION_KEY);
}
