declare module '#logbird-hooks' {
  const hooks: import('./runtime/hooks').LogbirdHooks;
  export default hooks;
}
declare module '#imports' {
  export const useRequestFetch: typeof import('nuxt/app')['useRequestFetch'];
}
