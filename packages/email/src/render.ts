import { createElement, type ReactElement } from 'react';
import { render } from 'react-email';
import { MSO_HEAD } from './templates/components';

/** One email: everything needed to produce subject, preheader, HTML and plain text from the same props. */
export interface EmailDefinition<P> {
  /** Stable id (tests, previews, logs). */
  id: string;
  subject: (props: P) => string;
  /** Inbox preheader. */
  preview: (props: P) => string;
  text: (props: P) => string;
  Component: (props: P) => ReactElement;
}

export interface RenderedEmail {
  subject: string;
  preview: string;
  html: string;
  text: string;
}

/** Subjects are a single header line: collapse anything that would break it. */
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

export async function renderEmail<P extends object>(email: EmailDefinition<P>, props: P): Promise<RenderedEmail> {
  const html = await render(createElement(email.Component, props));
  return {
    subject: oneLine(email.subject(props)),
    preview: oneLine(email.preview(props)),
    html: html.replace('</head>', `${MSO_HEAD}</head>`),
    text: email.text(props),
  };
}
