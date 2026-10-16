import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/browser';
import { authRequest } from './client';

/** Register a passkey for the signed-in user; requires recent authentication. */
export async function registerPasskey(name: string): Promise<void> {
  const data = await authRequest('passkey/register/options', {});
  const options = data.options as PublicKeyCredentialCreationOptionsJSON;
  if (!options || typeof options.challenge !== 'string')
    throw new Error('Invalid passkey options.');
  const response = await startRegistration({ optionsJSON: options });
  await authRequest('passkey/register/verify', { response, name });
}

/** A starting name for a new passkey, so most people can accept it as is. */
export function defaultDeviceName(): string {
  return window.matchMedia('(pointer: coarse)').matches
    ? 'This phone'
    : 'This computer';
}
