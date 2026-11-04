/** People signed in by OTP may not have a name yet: show their email's local part until they add one. */
export function displayName(user: { name?: string | null; email: string } | null | undefined): string {
  if (!user) return '';
  return user.name?.trim() || user.email.split('@')[0] || user.email;
}

export const hasName = (user: { name?: string | null } | null | undefined): boolean => Boolean(user?.name?.trim());
