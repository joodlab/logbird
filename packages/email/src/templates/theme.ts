/**
 * Email tokens, mirrored from the app's palette (packages/ui/src/styles/globals.css): a neutral "ink & paper"
 * console with one indigo accent for links. Primary buttons stay ink-on-paper, like in the app.
 *
 * Light values are inlined (every client gets them); dark values are applied through `prefers-color-scheme`
 * (Apple Mail, iOS Mail, Outlook for Mac, Hey) and `[data-ogsc]/[data-ogsb]` (Outlook.com). Clients that force
 * their own inversion (Gmail apps, Outlook for Windows) get a design with no images and no light-only artwork, so
 * inverted output stays legible.
 */
export const light = {
  page: '#f4f4f5',
  card: '#ffffff',
  border: '#e6e6e6',
  divider: '#efefef',
  text: '#171717',
  muted: '#525252',
  faint: '#6b6b6b',
  well: '#f7f7f8',
  wellBorder: '#e4e4e7',
  link: '#4f46e5',
  button: '#171717',
  buttonText: '#ffffff',
  mark: '#171717',
  markText: '#ffffff',
  accent: '#4f46e5',
} as const;

export const dark = {
  page: '#0b0b0c',
  card: '#121213',
  border: '#242426',
  divider: '#1f1f21',
  text: '#ededed',
  muted: '#b4b4b4',
  faint: '#8f8f8f',
  well: '#1a1a1c',
  wellBorder: '#2e2e31',
  link: '#a5b4fc',
  button: '#ededed',
  buttonText: '#121213',
  mark: '#ededed',
  markText: '#0b0b0c',
  accent: '#818cf8',
} as const;

export const fonts = {
  // No web fonts: nothing is fetched when the email opens. Geist is used where it is installed.
  sans: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  mono: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
} as const;

export const type = {
  h1: { fontSize: '22px', lineHeight: '30px', fontWeight: 600, letterSpacing: '-0.3px' },
  body: { fontSize: '15px', lineHeight: '24px' },
  small: { fontSize: '13px', lineHeight: '20px' },
  tiny: { fontSize: '12px', lineHeight: '18px' },
} as const;

export const CONTAINER_WIDTH = 560;

/** Class hooks used by the dark-mode and mobile styles in the layout <head>. */
export const cx = {
  page: 'tm-page',
  card: 'tm-card',
  shell: 'tm-shell',
  h1: 'tm-h1 tm-text',
  text: 'tm-text',
  muted: 'tm-muted',
  faint: 'tm-faint',
  link: 'tm-link',
  divider: 'tm-divider',
  well: 'tm-well',
  code: 'tm-code tm-text',
  button: 'tm-btn',
  buttonLink: 'tm-btn-a',
  mark: 'tm-mark',
  label: 'tm-label tm-faint',
} as const;

const darkRules = (prefix: string, bg: string) =>
  `
${prefix}.tm-page{background-color:${dark.page}!important}
${bg}.tm-card{background-color:${dark.card}!important;border-color:${dark.border}!important}
${prefix}.tm-text{color:${dark.text}!important}
${prefix}.tm-muted{color:${dark.muted}!important}
${prefix}.tm-faint{color:${dark.faint}!important}
${prefix}.tm-link{color:${dark.link}!important}
${prefix}.tm-divider{border-color:${dark.divider}!important}
${bg}.tm-well{background-color:${dark.well}!important;border-color:${dark.wellBorder}!important}
${bg}.tm-btn{background-color:${dark.button}!important}
${prefix}.tm-btn-a{color:${dark.buttonText}!important;background-color:${dark.button}!important}
${bg}.tm-mark{background-color:${dark.mark}!important;color:${dark.markText}!important}
`.trim();

/** Base + responsive rules. Kept separate from the dark rules so a client that rejects one block keeps the other. */
export const baseCss = `
body{margin:0!important;padding:0!important;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table{border-collapse:separate;mso-table-lspace:0pt;mso-table-rspace:0pt}
a{color:${light.link}}
.tm-code{-webkit-user-select:all;user-select:all}
@media only screen and (max-width:600px){
.tm-shell{padding:24px 12px 32px!important}
.tm-card{padding:28px 22px 24px!important}
.tm-h1{font-size:20px!important;line-height:28px!important}
.tm-code{font-size:30px!important;letter-spacing:6px!important}
.tm-label{width:104px!important}
}
`.trim();

export const darkCss = `
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
${darkRules('', '')}
}
`.trim();

/** Outlook.com marks dark-mode-adjusted nodes with data-ogsc (text) / data-ogsb (background). */
export const outlookDarkCss = `${darkRules('[data-ogsc] ', '[data-ogsb] ')}`;
