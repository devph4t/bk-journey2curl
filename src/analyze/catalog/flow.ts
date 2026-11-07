import { makeCallback } from './callbacks.js';
import { type Handler, info, localized, str } from './types.js';

const emailSuspend: Handler = (node) =>
  info({
    kind: 'suspend',
    callbacks: [
      makeCallback('SuspendedTextOutputCallback', {
        prompt:
          localized(node.config.emailSuspendMessage) ??
          'An email has been sent. Click the link in that email to proceed.',
        sourceNodeId: node.id,
      }),
    ],
    notes: [
      `Email template: ${str(node.config.emailTemplateName) ?? '?'}`,
      'The journey continues when the link in the email is opened (it carries ?suspendedId=...)',
    ],
  });

const zeroPage: Handler = (node) =>
  info({
    headers: {
      [str(node.config.usernameHeader) ?? 'X-OpenAM-Username']: 'IN_USERNAME',
      [str(node.config.passwordHeader) ?? 'X-OpenAM-Password']: 'IN_PASSWORD',
    },
    notes: ['Credentials are sent as request headers on the first call'],
  });

const innerTree: Handler = (node) => info({ innerJourney: str(node.config.tree) });

const sessionData: Handler = (node) =>
  info({
    needsSession: true,
    notes: [`Reads "${str(node.config.sessionDataKey) ?? '?'}" from the current session`],
  });

const polling: Handler = (node) =>
  info({
    kind: 'poll',
    callbacks: [
      makeCallback('PollingWaitCallback', {
        prompt: localized(node.config.message) ?? 'Waiting',
        sourceNodeId: node.id,
      }),
    ],
    branching: 'server',
    serverReason: 'polling',
  });

export const flowHandlers: Record<string, Handler> = {
  EmailSuspendNode: emailSuspend,
  ZeroPageLoginNode: zeroPage,
  InnerTreeEvaluatorNode: innerTree,
  SessionDataNode: sessionData,
  PollingWaitNode: polling,
};
