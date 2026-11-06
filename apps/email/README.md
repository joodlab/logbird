# @logbird/email-preview

Preview and send Logbird's transactional emails. The templates themselves live in
[`packages/email`](../../packages/email) (`@logbird/email`); this app only renders and sends them.

| Command | What it does |
|---|---|
| `pnpm --filter @logbird/email-preview dev` | react-email preview on http://localhost:4602: desktop / mobile, dark toggle, HTML source, client compatibility linter. |
| `pnpm --filter @logbird/email-preview send` | Sends every email (rendered from the shared fixtures, links to `APP_URL`, dates relative to now) through the SMTP server in the root `.env`, which is Mailpit locally (http://127.0.0.1:8025). |
| `pnpm --filter @logbird/email-preview send --to me@logbird.local --only invitation,signInCode` | Sends a subset to another address. `--list` prints the email keys. |
| `pnpm --filter @logbird/email-preview build` | Exports static HTML for every preview to `dist/`. |

`send` only mails test domains (`*.logbird.local`, `*.test`, `example.com`, …) unless you pass `--allow-external`,
so a production SMTP config cannot reach real people by accident.

## Package layout

```
packages/email/src
  index.ts            side-effect free: emails registry, renderEmail, fixtures, template components
  send.ts             @logbird/email/send: SMTP transport, sendEmail + per-email helpers (reads SMTP_*, MAIL_FROM, APP_URL)
  render.ts           EmailDefinition { id, name, recipient, subject, preview, text, Component } -> { subject, preview, html, text }
  fixtures.ts         createFixtures({ appUrl, now }): sample props shared by tests, previews and `send`
  templates/          theme tokens, components (layout, button, code block, detail rows) and one file per email
apps/email/emails     one preview entry per email (or variant), rendering a template with fixtures
```

## Adding an email

1. Create `packages/email/src/templates/<name>.tsx` exporting the component and an `EmailDefinition`
   (subject, preheader, plain text, recipient prop), built from the shared components.
2. Register it in `emails` (`src/index.ts`), add fixtures in `src/fixtures.ts`, and a `send<Name>` helper in `src/send.ts`.
3. Add `apps/email/emails/<name>.tsx` for the preview. The Vitest suite in `packages/email` picks it up from the registry
   (HTML validation, size, links, placeholders, plain-text snapshot).
