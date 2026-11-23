import * as React from 'react';
import type { EmailDefinition } from '../render';
import { plainText } from '../text';
import { Button, EmailLayout, Paragraph, Title } from './components';

export interface WebhookDisabledEmailProps {
  appUrl: string;
  email: string;
  project: string;
  reason: 'gone_410' | 'consecutive_failures';
}

const title = ({ project }: WebhookDisabledEmailProps) => `A webhook was disabled in ${project}`;
const explanation = ({ reason }: WebhookDisabledEmailProps) =>
  reason === 'gone_410'
    ? 'The receiver returned HTTP 410 Gone.'
    : 'The receiver reached the consecutive failure limit or continued to fail for 24 hours.';
const guidance = 'Open the project’s webhook settings to review the delivery history and re-enable the endpoint when it is ready.';

function WebhookDisabledEmail(props: WebhookDisabledEmailProps) {
  return (
    <EmailLayout appUrl={props.appUrl} preview={explanation(props)} reason="you manage this project." title={title(props)}>
      <Title>{title(props)}</Title>
      <Paragraph>{explanation(props)}</Paragraph>
      <Paragraph>{guidance}</Paragraph>
      <Button href={props.appUrl}>Open Logbird</Button>
    </EmailLayout>
  );
}

export const webhookDisabled: EmailDefinition<WebhookDisabledEmailProps> = {
  id: 'webhook-disabled',
  name: 'Webhook disabled',
  recipient: 'email',
  subject: title,
  preview: explanation,
  text: (props) =>
    plainText({ title: title(props), appUrl: props.appUrl, reason: 'you manage this project.', blocks: [explanation(props), guidance] }),
  Component: WebhookDisabledEmail,
};
