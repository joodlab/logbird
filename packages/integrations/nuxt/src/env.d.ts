import 'nitropack';

declare module 'nitropack' {
  interface NitroRuntimeConfig {
    trailmark: { endpoint: string; ingestKey: string; readKey: string };
  }
}
