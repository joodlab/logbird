export const CONSOLE_ROUTES = {
  webhookSettings: '/p/$projectId/settings/webhooks',
} as const;

export function webhookSettingsPath(projectId: string) {
  return CONSOLE_ROUTES.webhookSettings.replace('$projectId', encodeURIComponent(projectId));
}
