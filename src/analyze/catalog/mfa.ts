// Callback shapes for MFA nodes follow AM documentation and must be verified against a real tenant before v1.
import { makeCallback } from './callbacks.js';
import { type Handler, info } from './types.js';

const verifyNote = 'Callback shape not yet verified against a real tenant';

const oathVerifier: Handler = (node) => {
  const recovery = node.config.isRecoveryCodeAllowed === true;
  const code = makeCallback('NameCallback', {
    prompt: 'Enter verification code',
    variable: 'OTP',
    sourceNodeId: node.id,
  });
  const first = code.inputs[0];
  if (first) first.solver = 'totp';
  const callbacks = [code];
  if (recovery) {
    callbacks.push(
      makeCallback('ConfirmationCallback', {
        prompt: '',
        options: ['Submit', 'Use Recovery Code'],
        variable: 'OTP_ACTION',
        value: 0,
        sourceNodeId: node.id,
      }),
    );
  }
  return info({
    callbacks,
    links: recovery
      ? {
          successOutcome: { callbackIndex: 1, inputIndex: 0, value: 0 },
          recoveryCodeOutcome: { callbackIndex: 1, inputIndex: 0, value: 1 },
        }
      : undefined,
    notes: ['Needs IN_TOTP_SECRET (base32, computed with oathtool) or IN_OTP', verifyNote],
  });
};

const recoveryCollector: Handler = (node) =>
  info({
    callbacks: [
      makeCallback('NameCallback', { prompt: 'Enter recovery code', variable: 'RECOVERY_CODE', sourceNodeId: node.id }),
    ],
    notes: ['Needs IN_RECOVERY_CODE (one of the codes shown at registration)', verifyNote],
  });

const oathRegistration: Handler = (node) =>
  info({
    kind: 'manual',
    callbacks: [
      makeCallback('TextOutputCallback', { prompt: 'Scan the QR code', sourceNodeId: node.id }),
      makeCallback('TextOutputCallback', { prompt: '(QR code script)', sourceNodeId: node.id }),
      makeCallback('HiddenValueCallback', { prompt: 'mfaDeviceRegistration', sourceNodeId: node.id }),
      makeCallback('ConfirmationCallback', { prompt: '', options: ['Next'], value: 0, sourceNodeId: node.id }),
    ],
    notes: ['Register the authenticator app by scanning the QR code, then continue', verifyNote],
  });

const recoveryDisplay: Handler = (node) =>
  info({
    callbacks: [
      makeCallback('TextOutputCallback', { prompt: 'Your recovery codes', sourceNodeId: node.id }),
      makeCallback('TextOutputCallback', { prompt: '(recovery codes script)', sourceNodeId: node.id }),
    ],
    notes: ['Shows recovery codes; save them, then continue', verifyNote],
  });

const webAuthn: Handler = (node) =>
  info({
    kind: 'manual',
    callbacks: [
      makeCallback('TextOutputCallback', { prompt: '(WebAuthn script)', sourceNodeId: node.id }),
      makeCallback('HiddenValueCallback', { prompt: 'webAuthnOutcome', sourceNodeId: node.id }),
    ],
    notes: ['Needs a security key or passkey in a browser; cannot be completed with curl', verifyNote],
  });

export const mfaHandlers: Record<string, Handler> = {
  OathTokenVerifierNode: oathVerifier,
  RecoveryCodeCollectorDecisionNode: recoveryCollector,
  OathRegistrationNode: oathRegistration,
  RecoveryCodeDisplayNode: recoveryDisplay,
  WebAuthnAuthenticationNode: webAuthn,
  WebAuthnRegistrationNode: webAuthn,
};
