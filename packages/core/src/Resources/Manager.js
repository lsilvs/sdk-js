// @flow
import { utils, type Key } from '@tanker/crypto';
import { InternalError, InvalidArgument } from '@tanker/errors';

import { getKeyPublishEntryFromBlock } from './Serialize';
import { KeyDecryptor } from './KeyDecryptor';

import { Client } from '../Network/Client';
import ResourceStore from './ResourceStore';
import LocalUserManager from '../LocalUser/Manager';
import GroupManager from '../Groups/Manager';
import ProvisionalIdentityManager from '../ProvisionalIdentity/Manager';

export class ResourceManager {
  _resourceStore: ResourceStore;
  _client: Client;
  _keyDecryptor: KeyDecryptor;

  constructor(
    client: Client,
    resourceStore: ResourceStore,
    localUserManager: LocalUserManager,
    groupManager: GroupManager,
    provisionalIdentityManager: ProvisionalIdentityManager
  ) {
    this._resourceStore = resourceStore;
    this._client = client;
    this._keyDecryptor = new KeyDecryptor(localUserManager, groupManager, provisionalIdentityManager);
  }

  async findKeyFromResourceId(resourceId: Uint8Array): Promise<Key> {
    let resourceKey = await this._resourceStore.findResourceKey(resourceId);
    if (!resourceKey) {
      const keyPublish = await this._getKeyPublish(this._client, resourceId);
      resourceKey = await this._keyDecryptor.keyFromKeyPublish(keyPublish);
      await this._resourceStore.saveResourceKey(resourceId, resourceKey);
    }
    return resourceKey;
  }

  _getKeyPublish = async (client: Client, resourceId: Uint8Array) => {
    const response = await client.send('get key publishes', {
      resource_ids: [utils.toBase64(resourceId)],
    });
    if (!Array.isArray(response)) {
      throw new InternalError('Invalid response from server');
    }
    if (response.length === 0) {
      throw new InvalidArgument(`could not find key for resource: ${utils.toBase64(resourceId)}`);
    }
    return getKeyPublishEntryFromBlock(response[0]);
  };

  saveResourceKey = async (resourceId: Uint8Array, key: Uint8Array): Promise<void> => this._resourceStore.saveResourceKey(resourceId, key)
}

export default ResourceManager;
