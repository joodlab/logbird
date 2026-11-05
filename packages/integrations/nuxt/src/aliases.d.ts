declare module '#trailmark-hooks' {
  const hooks: import('./runtime/hooks').TrailmarkHooks;
  export default hooks;
}
declare module '#imports' {
  export const useRequestFetch: typeof import('nuxt/app')['useRequestFetch'];
}
