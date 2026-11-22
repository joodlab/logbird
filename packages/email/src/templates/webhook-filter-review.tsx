import { webhookSettingsPath } from '@logbird/contracts';
import * as React from 'react';
import type { EmailDefinition } from '../render';
import { plainText } from '../text';
import { Button, EmailLayout, Paragraph, Title } from './components';

export interface WebhookFilterReviewEmailProps {
  appUrl: string;
  email: string;
  projectId: string;
  project: string;
  host: string;
  description: string | null;
}

const title = 'Review a webhook filter';
const guidance = 'Deliveries are paused until you review and save the filter.';
const reason = 'you manage this project.';
const endpoint = (props: WebhookFilterReviewEmailProps) =>
  `Webhook in ${props.project} at ${props.host}${props.description ? ` (${props.description})` : ''}.`;
const settings = (props: WebhookFilterReviewEmailProps) => new URL(webhookSettingsPath(props.projectId), props.appUrl).href;

function WebhookFilterReviewEmail(props: WebhookFilterReviewEmailProps) {
  return (
    <EmailLayout appUrl={props.appUrl} preview={guidance} reason={reason} title={title}>
      <Title>{title}</Title>
      <Paragraph>{endpoint(props)}</Paragraph>
      <Paragraph>{guidance}</Paragraph>
      <Button href={settings(props)}>Open webhook settings</Button>
    </EmailLayout>
  );
}

export const webhookFilterReview: EmailDefinition<WebhookFilterReviewEmailProps> = {
  id: 'webhook-filter-review',
  name: 'Webhook filter review',
  recipient: 'email',
  subject: () => title,
  preview: () => guidance,
  text: (props) =>
    plainText({
      title,
      appUrl: props.appUrl,
      reason,
      blocks: [endpoint(props), guidance, { action: 'Open webhook settings', url: settings(props) }],
    }),
  Component: WebhookFilterReviewEmail,
};
