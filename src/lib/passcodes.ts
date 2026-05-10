const DEFAULT_PASSCODE = "9999";

function getPasscode(profileId: string): string {
  const key = profileId.toUpperCase().replace(/-/g, "_");
  return (import.meta.env[`VITE_PASSCODE_${key}`] as string | undefined) || DEFAULT_PASSCODE;
}

export function requiresPasscode(_profileId: string): boolean {
  return true;
}

export function checkPasscode(profileId: string, input: string): boolean {
  return input.trim() === getPasscode(profileId);
}
