// @flow
import { tcrypto, utils } from '@tanker/crypto';
import { InternalError } from '@tanker/errors';

import { getStaticArray, encodeListLength, unserializeGenericSub, unserializeGeneric, unserializeList } from '../Blocks/Serialize';
import { hashBlock, type Block } from '../Blocks/Block';
import { type VerificationFields } from '../Blocks/entries';

const userNatures = Object.freeze({
  device_creation_v1: 2,
  device_revocation_v1: 4,
  device_creation_v2: 6,
  device_creation_v3: 7,
  device_revocation_v2: 9,
});

const SEALED_KEY_SIZE = tcrypto.SYMMETRIC_KEY_SIZE + tcrypto.SEAL_OVERHEAD;

const hashSize = tcrypto.HASH_SIZE;

type UserPrivateKey = {|
  recipient: Uint8Array,
  key: Uint8Array,
|}

type UserKeyPair = {|
  public_encryption_key: Uint8Array,
  encrypted_private_encryption_key: Uint8Array,
|}

export type UserKeys = {|
  public_encryption_key: Uint8Array,
  previous_public_encryption_key: Uint8Array,
  encrypted_previous_encryption_key: Uint8Array,
  private_keys: Array<UserPrivateKey>,
|}

export type DeviceCreationRecord = {|
  last_reset: Uint8Array,
  ephemeral_public_signature_key: Uint8Array,
  user_id: Uint8Array,
  delegation_signature: Uint8Array,
  public_signature_key: Uint8Array,
  public_encryption_key: Uint8Array,
  user_key_pair: ?UserKeyPair,
  is_ghost_device: bool,

  revoked: number,
|}

export type DeviceRevocationRecord = {|
  device_id: Uint8Array,
  user_keys?: UserKeys,
|}

export type DeviceCreationEntry = {|
  ...DeviceCreationRecord,
  ...VerificationFields
|}

export type DeviceRevocationEntry = {|
  ...DeviceRevocationRecord,
  ...VerificationFields,
  user_id: Uint8Array
|}

export type UserEntry = DeviceCreationEntry | DeviceRevocationEntry;

function serializePrivateKey(userKey: UserPrivateKey): Uint8Array {
  return utils.concatArrays(userKey.recipient, userKey.key);
}

function serializeUserKeyPair(userKeyPair: UserKeyPair): Uint8Array {
  return utils.concatArrays(userKeyPair.public_encryption_key, userKeyPair.encrypted_private_encryption_key);
}

function serializeUserKeys(userKeys: UserKeys): Uint8Array {
  return utils.concatArrays(
    userKeys.public_encryption_key,
    userKeys.previous_public_encryption_key,
    userKeys.encrypted_previous_encryption_key,
    encodeListLength(userKeys.private_keys),
    ...userKeys.private_keys.map(serializePrivateKey),
  );
}


export function serializeUserDeviceV3(userDevice: DeviceCreationRecord): Uint8Array {
  if (!utils.equalArray(userDevice.last_reset, new Uint8Array(tcrypto.HASH_SIZE)))
    throw new InternalError('Assertion error: user device last reset must be null');
  if (userDevice.ephemeral_public_signature_key.length !== tcrypto.SIGNATURE_PUBLIC_KEY_SIZE)
    throw new InternalError('Assertion error: invalid user device ephemeral public signature key size');
  if (userDevice.user_id.length !== tcrypto.HASH_SIZE)
    throw new InternalError('Assertion error: invalid user device user id size');
  if (userDevice.delegation_signature.length !== tcrypto.SIGNATURE_SIZE)
    throw new InternalError('Assertion error: invalid user device delegation signature size');
  if (userDevice.public_signature_key.length !== tcrypto.SIGNATURE_PUBLIC_KEY_SIZE)
    throw new InternalError('Assertion error: invalid user device public signature key size');
  if (userDevice.public_encryption_key.length !== tcrypto.ENCRYPTION_PUBLIC_KEY_SIZE)
    throw new InternalError('Assertion error: invalid user device public encryption key size');
  if (!userDevice.user_key_pair)
    throw new InternalError('Assertion error: invalid user device user key pair');
  if (userDevice.user_key_pair.public_encryption_key.length !== tcrypto.ENCRYPTION_PUBLIC_KEY_SIZE)
    throw new InternalError('Assertion error: invalid user device user public encryption key size');
  if (userDevice.user_key_pair.encrypted_private_encryption_key.length !== SEALED_KEY_SIZE)
    throw new InternalError('Assertion error: invalid user device user encrypted private encryption key size');

  const deviceFlags = new Uint8Array(1);
  deviceFlags[0] = userDevice.is_ghost_device ? 1 : 0;

  return utils.concatArrays(
    userDevice.ephemeral_public_signature_key,
    userDevice.user_id,
    userDevice.delegation_signature,
    userDevice.public_signature_key,
    userDevice.public_encryption_key,
    // $FlowIssue user_key_pair is not null, I checked for that...
    serializeUserKeyPair(userDevice.user_key_pair),
    deviceFlags,
  );
}

function unserializePrivateKey(src: Uint8Array, offset: number) {
  return unserializeGenericSub(src, [
    (d, o) => getStaticArray(d, tcrypto.HASH_SIZE, o, 'recipient'),
    (d, o) => getStaticArray(d, SEALED_KEY_SIZE, o, 'key'),
  ], offset);
}

function unserializeUserKeyPair(src: Uint8Array, offset: number) {
  return unserializeGenericSub(src, [
    (d, o) => getStaticArray(d, tcrypto.ENCRYPTION_PUBLIC_KEY_SIZE, o, 'public_encryption_key'),
    (d, o) => getStaticArray(d, SEALED_KEY_SIZE, o, 'encrypted_private_encryption_key'),
  ], offset, 'user_key_pair');
}

function unserializeUserKeys(src: Uint8Array, offset: number) {
  return unserializeGenericSub(src, [
    (d, o) => getStaticArray(d, tcrypto.ENCRYPTION_PUBLIC_KEY_SIZE, o, 'public_encryption_key'),
    (d, o) => getStaticArray(d, tcrypto.ENCRYPTION_PUBLIC_KEY_SIZE, o, 'previous_public_encryption_key'),
    (d, o) => getStaticArray(d, SEALED_KEY_SIZE, o, 'encrypted_previous_encryption_key'),
    (d, o) => unserializeList(d, unserializePrivateKey, o, 'private_keys'),
  ], offset, 'user_keys');
}

export function unserializeUserDeviceV1(src: Uint8Array): DeviceCreationRecord {
  return unserializeGeneric(src, [
    (d, o) => ({ last_reset: new Uint8Array(tcrypto.HASH_SIZE), newOffset: o }),
    (d, o) => getStaticArray(d, tcrypto.SIGNATURE_PUBLIC_KEY_SIZE, o, 'ephemeral_public_signature_key'),
    (d, o) => getStaticArray(d, tcrypto.HASH_SIZE, o, 'user_id'),
    (d, o) => getStaticArray(d, tcrypto.SIGNATURE_SIZE, o, 'delegation_signature'),
    (d, o) => getStaticArray(d, tcrypto.SIGNATURE_PUBLIC_KEY_SIZE, o, 'public_signature_key'),
    (d, o) => getStaticArray(d, tcrypto.ENCRYPTION_PUBLIC_KEY_SIZE, o, 'public_encryption_key'),
    (d, o) => ({ user_key_pair: null, newOffset: o }),
    (d, o) => ({ is_ghost_device: false, newOffset: o }),
    (d, o) => ({ revoked: Number.MAX_SAFE_INTEGER, newOffset: o }),
  ]);
}

export function unserializeUserDeviceV2(src: Uint8Array): DeviceCreationRecord {
  return unserializeGeneric(src, [
    (d, o) => getStaticArray(d, tcrypto.HASH_SIZE, o, 'last_reset'),
    (d, o) => getStaticArray(d, tcrypto.SIGNATURE_PUBLIC_KEY_SIZE, o, 'ephemeral_public_signature_key'),
    (d, o) => getStaticArray(d, tcrypto.HASH_SIZE, o, 'user_id'),
    (d, o) => getStaticArray(d, tcrypto.SIGNATURE_SIZE, o, 'delegation_signature'),
    (d, o) => getStaticArray(d, tcrypto.SIGNATURE_PUBLIC_KEY_SIZE, o, 'public_signature_key'),
    (d, o) => getStaticArray(d, tcrypto.ENCRYPTION_PUBLIC_KEY_SIZE, o, 'public_encryption_key'),
    (d, o) => ({ user_key_pair: null, newOffset: o }),
    (d, o) => ({ is_ghost_device: false, newOffset: o }),
    (d, o) => ({ revoked: Number.MAX_SAFE_INTEGER, newOffset: o }),
  ]);
}

export function unserializeUserDeviceV3(src: Uint8Array): DeviceCreationRecord {
  return unserializeGeneric(src, [
    (d, o) => ({ last_reset: new Uint8Array(tcrypto.HASH_SIZE), newOffset: o }),
    (d, o) => getStaticArray(d, tcrypto.SIGNATURE_PUBLIC_KEY_SIZE, o, 'ephemeral_public_signature_key'),
    (d, o) => getStaticArray(d, tcrypto.HASH_SIZE, o, 'user_id'),
    (d, o) => getStaticArray(d, tcrypto.SIGNATURE_SIZE, o, 'delegation_signature'),
    (d, o) => getStaticArray(d, tcrypto.SIGNATURE_PUBLIC_KEY_SIZE, o, 'public_signature_key'),
    (d, o) => getStaticArray(d, tcrypto.ENCRYPTION_PUBLIC_KEY_SIZE, o, 'public_encryption_key'),
    (d, o) => unserializeUserKeyPair(d, o),
    (d, o) => ({ is_ghost_device: !!(d[o] & 0x01), newOffset: o + 1 }), // eslint-disable-line no-bitwise
    (d, o) => ({ revoked: Number.MAX_SAFE_INTEGER, newOffset: o }),
  ]);
}

export function serializeDeviceRevocationV1(deviceRevocation: DeviceRevocationRecord): Uint8Array {
  if (deviceRevocation.device_id.length !== hashSize)
    throw new InternalError('Assertion error: invalid device revocation device_id size');

  return deviceRevocation.device_id;
}

export function serializeDeviceRevocationV2(deviceRevocation: DeviceRevocationRecord): Uint8Array {
  if (deviceRevocation.device_id.length !== hashSize)
    throw new InternalError('Assertion error: invalid device revocation device_id size');
  if (!deviceRevocation.user_keys)
    throw new InternalError('Assertion error: invalid user device user keys');
  if (deviceRevocation.user_keys.public_encryption_key.length !== tcrypto.ENCRYPTION_PUBLIC_KEY_SIZE)
    throw new InternalError('Assertion error: invalid user device user public encryption key size');
  if (deviceRevocation.user_keys.previous_public_encryption_key.length !== tcrypto.ENCRYPTION_PUBLIC_KEY_SIZE)
    throw new InternalError('Assertion error: invalid user device user previous public encryption key size');
  if (deviceRevocation.user_keys.encrypted_previous_encryption_key.length !== SEALED_KEY_SIZE)
    throw new InternalError('Assertion error: invalid user device user previous encrypted private encryption key size');
  for (const key of deviceRevocation.user_keys.private_keys) {
    if (key.recipient.length !== tcrypto.HASH_SIZE)
      throw new InternalError('Assertion error: invalid user device encrypted key recipient size');
    if (key.key.length !== SEALED_KEY_SIZE)
      throw new InternalError('Assertion error: invalid user device user encrypted private encryption key size');
  }

  return utils.concatArrays(
    deviceRevocation.device_id,
    serializeUserKeys(deviceRevocation.user_keys)
  );
}

export function unserializeDeviceRevocationV1(src: Uint8Array): DeviceRevocationRecord {
  return { device_id: getStaticArray(src, hashSize, 0).value };
}

export function unserializeDeviceRevocationV2(src: Uint8Array): DeviceRevocationRecord {
  return unserializeGeneric(src, [
    (d, o) => getStaticArray(d, hashSize, o, 'device_id'),
    (d, o) => unserializeUserKeys(d, o),
  ]);
}

export function deviceCreationFromBlock(block: Block): DeviceCreationEntry {
  const author = block.author;
  const signature = block.signature;
  const nature = block.nature;
  const hash = hashBlock(block);
  const index = block.index;
  let userEntry;

  switch (block.nature) {
    case userNatures.device_creation_v1:
      userEntry = unserializeUserDeviceV1(block.payload);
      break;
    case userNatures.device_creation_v2:
      userEntry = unserializeUserDeviceV2(block.payload);
      break;
    case userNatures.device_creation_v3:
      userEntry = unserializeUserDeviceV3(block.payload);
      break;
    default: throw new InternalError('Assertion error: wrong type for deviceCreationFromBlock');
  }
  return {
    ...userEntry,
    author,
    signature,
    nature,
    hash,
    index,
  };
}

export function deviceRevocationFromBlock(block: Block, userId: Uint8Array): DeviceRevocationEntry {
  const author = block.author;
  const signature = block.signature;
  const nature = block.nature;
  const hash = hashBlock(block);
  const index = block.index;
  let userEntry;

  switch (block.nature) {
    case userNatures.device_revocation_v1:
      userEntry = unserializeDeviceRevocationV1(block.payload);
      break;
    case userNatures.device_revocation_v2:
      userEntry = unserializeDeviceRevocationV2(block.payload);
      break;
    default: throw new InternalError('Assertion error: wrong type for deviceRevocationFromBlock');
  }
  return {
    ...userEntry,
    author,
    signature,
    nature,
    hash,
    index,
    user_id: userId
  };
}

export function isDeviceCreation(block: Block): bool {
  return block.nature === userNatures.device_creation_v1 || block.nature === userNatures.device_creation_v2 || block.nature === userNatures.device_creation_v3;
}

export function isDeviceRevocation(block: Block): bool {
  return block.nature === userNatures.device_revocation_v1 || block.nature === userNatures.device_revocation_v2;
}