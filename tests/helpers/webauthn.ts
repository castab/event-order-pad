import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

// Minimal definite-length CBOR encoder for a standards-compliant test authenticator.
function cbor(
  value: string | number | Buffer | Map<string | number, unknown>,
): Buffer {
  function head(type: number, length: number) {
    if (length < 24) return Buffer.from([(type << 5) | length]);
    if (length < 256) return Buffer.from([(type << 5) | 24, length]);
    const result = Buffer.alloc(3);
    result[0] = (type << 5) | 25;
    result.writeUInt16BE(length, 1);
    return result;
  }
  if (typeof value === 'number')
    return head(value < 0 ? 1 : 0, value < 0 ? -1 - value : value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value);
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value))
    return Buffer.concat([head(2, value.length), value]);
  return Buffer.concat([
    head(5, value.size),
    ...Array.from(value.entries()).flatMap(([k, v]) => [
      cbor(k),
      cbor(v as Parameters<typeof cbor>[0]),
    ]),
  ]);
}
export function testAuthenticator(rpID: string, origin: string) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const publicKey = cbor(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]),
  );
  const idBytes = randomBytes(32);
  const id = idBytes.toString('base64url');
  const rpHash = createHash('sha256').update(rpID).digest();
  const client = (type: string, challenge: string, requestOrigin = origin) =>
    Buffer.from(
      JSON.stringify({
        type,
        challenge,
        origin: requestOrigin,
        crossOrigin: false,
      }),
    );
  return {
    id,
    registration(challenge: string): RegistrationResponseJSON {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(idBytes.length);
      const data = Buffer.concat([
        rpHash,
        Buffer.from([0x45]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        len,
        idBytes,
        publicKey,
      ]);
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: client('webauthn.create', challenge).toString(
            'base64url',
          ),
          attestationObject: cbor(
            new Map<string, unknown>([
              ['fmt', 'none'],
              ['attStmt', new Map()],
              ['authData', data],
            ]),
          ).toString('base64url'),
          transports: ['internal'],
        },
      };
    },
    authentication(
      challenge: string,
      counter = 1,
      requestOrigin = origin,
      verified = true,
    ): AuthenticationResponseJSON {
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const data = Buffer.concat([
        rpHash,
        Buffer.from([verified ? 0x05 : 0x01]),
        count,
      ]);
      const json = client('webauthn.get', challenge, requestOrigin);
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: json.toString('base64url'),
          authenticatorData: data.toString('base64url'),
          signature: sign(
            'sha256',
            Buffer.concat([data, createHash('sha256').update(json).digest()]),
            pair.privateKey,
          ).toString('base64url'),
        },
      };
    },
  };
}
