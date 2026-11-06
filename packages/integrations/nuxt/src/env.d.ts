import 'nitropack';

declare module 'nitropack' {
  interface NitroRuntimeConfig {
    logbird: { endpoint: string; ingestKey: string; readKey: string };
  }
}
