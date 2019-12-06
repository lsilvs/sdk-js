// @flow
import EventEmitter from 'events';
import { InternalError, InvalidVerification, OperationCanceled, NetworkError, TankerError } from '@tanker/errors';

import Trustchain from '../Trustchain/Trustchain';
import Storage, { type DataStoreOptions } from './Storage';
import LocalUser from './LocalUser/LocalUser';
import { Client, type ClientOptions } from '../Network/Client';
import { type Status, type Verification, type VerificationMethod, type RemoteVerification, statuses } from './types';
import { Managers } from './Managers';
import { type UserData } from './UserData';

import { sendGetVerificationKey, getLastUserKey, sendUserCreation, getVerificationMethods, sendSetVerificationMethod } from './requests';

import { generateGhostDeviceKeys, extractGhostDevice, ghostDeviceToUnlockKey, ghostDeviceKeysFromUnlockKey, decryptUnlockKey } from './LocalUser/ghostDevice';

export class Session extends EventEmitter {
  localUser: LocalUser;

  storage: Storage;
  _trustchain: Trustchain;
  _client: Client;

  _status: Status;

  _managers: Managers;

  constructor(localUser: LocalUser, storage: Storage, trustchain: Trustchain, client: Client, status: Status) {
    super();

    this.storage = storage;
    this._trustchain = trustchain;
    this.localUser = localUser;
    this._client = client;
    this._status = status;

    localUser.on('device_revoked', () => this.emit('device_revoked'));
    client.on('authentication_failed', (e) => this.authenticationError(e));
    this._managers = new Managers(localUser, storage, trustchain, client);
  }

  get status(): Status {
    return this._status;
  }

  static init = async (userData: UserData, storeOptions: DataStoreOptions, clientOptions: ClientOptions) => {
    const client = new Client(userData.trustchainId, clientOptions);
    client.open().catch((e) => {
      if (!(e instanceof OperationCanceled) && !(e instanceof NetworkError)) {
        console.error(e);
      }
    });

    const storage = new Storage(storeOptions);
    await storage.open(userData.userId, userData.userSecret);

    const localUser = new LocalUser(userData, storage.keyStore);
    storage.userStore.setCallbacks({
      deviceCreation: localUser.applyDeviceCreation,
      deviceRevocation: localUser.applyDeviceRevocation,
    });

    const trustchain = await Trustchain.open(client, userData.trustchainId, userData.userId, storage);

    if (!storage.hasLocalDevice()) {
      const { deviceExists, userExists } = await client.remoteStatus(localUser.trustchainId, localUser.userId, localUser.publicSignatureKey);

      if (!userExists) {
        return new Session(localUser, storage, trustchain, client, statuses.IDENTITY_REGISTRATION_NEEDED);
      }

      if (!deviceExists) {
        return new Session(localUser, storage, trustchain, client, statuses.IDENTITY_VERIFICATION_NEEDED);
      }

      // Device registered on the trustchain, but device creation block not pulled yet...
      // Wait for the pull to catch missing blocks.
      const session = new Session(localUser, storage, trustchain, client, statuses.STOPPED);
      await session.authenticate();
      return session;
    }

    const session = new Session(localUser, storage, trustchain, client, statuses.READY);

    session.authenticate().catch((e) => session.authenticationError(e));
    return session;
  }

  authenticate = async () => {
    await this._client.authenticate(this.localUser.userId, this.storage.keyStore.signatureKeyPair);
    await this._trustchain.ready();
    this._status = statuses.READY;
  }

  authenticationError = (e: Error) => {
    // OperationCanceled: thrown if you never managed to authenticate and the session gets closed
    if (!(e instanceof NetworkError) && !(e instanceof OperationCanceled)) {
      console.error(e);
      this.emit('authentication_failed');
    }
  };

  getVerificationMethods = async (): Promise<Array<VerificationMethod>> => getVerificationMethods(this._client, this.localUser)

  setVerificationMethod = async (verification: RemoteVerification): Promise<void> => {
    await sendSetVerificationMethod(this._client, this.localUser, verification);
  }

  createUser = async (verification: Verification) => {
    let ghostDeviceKeys;
    if (verification.verificationKey) {
      try {
        ghostDeviceKeys = ghostDeviceKeysFromUnlockKey(verification.verificationKey);
      } catch (e) {
        throw new InvalidVerification(e);
      }
    } else {
      ghostDeviceKeys = generateGhostDeviceKeys();
    }

    const { userCreationBlock, firstDeviceBlock, encryptedUnlockKey } = this.localUser.generateUserCreation(ghostDeviceKeys);
    await sendUserCreation(this._client, this.localUser, userCreationBlock, firstDeviceBlock, verification, encryptedUnlockKey);

    await this.authenticate();
  }

  unlockUser = async (verification: Verification) => {
    try {
      const unlockKey = await this._getUnlockKey(verification);
      const ghostDevice = extractGhostDevice(unlockKey);

      const encryptedUserKey = await getLastUserKey(this._client, this.localUser.trustchainId, ghostDevice);

      const newDeviceBlock = this.localUser.generateDeviceFromGhostDevice(ghostDevice, encryptedUserKey);
      await this._client.send('create device', newDeviceBlock, true);
      await this.authenticate();
    } catch (e) {
      if (e instanceof TankerError) {
        throw e;
      }
      if (verification.verificationKey) {
        throw new InvalidVerification(e);
      }
      throw new InternalError(e);
    }
  }

  generateVerificationKey = async () => {
    const ghostDeviceKeys = generateGhostDeviceKeys();

    return ghostDeviceToUnlockKey({
      privateSignatureKey: ghostDeviceKeys.signatureKeyPair.privateKey,
      privateEncryptionKey: ghostDeviceKeys.encryptionKeyPair.privateKey,
    });
  }

  close = async () => {
    await this._trustchain.close();
    await this._client.close();
    await this.storage.close();
  }

  nuke = async () => {
    await this._trustchain.close();
    await this._client.close();
    await this.storage.nuke();
  }

  _getUnlockKey = async (verification: Verification) => {
    if (verification.verificationKey) {
      return verification.verificationKey;
    }
    const remoteVerification: RemoteVerification = (verification: any);
    const encryptedUnlockKey = await sendGetVerificationKey(this.localUser, this._client, remoteVerification);
    return decryptUnlockKey(encryptedUnlockKey, this.localUser.userSecret);
  }

  get userAccessor() { return this._managers.userAccessor; }
  get provisionalIdentityManager() { return this._managers.provisionalIdentityManager; }
  get deviceManager() { return this._managers.deviceManager; }
  get groupManager() { return this._managers.groupManager; }
  get cloudStorageManager() { return this._managers.cloudStorageManager; }
  get dataProtector() { return this._managers.dataProtector; }
}
