// @flow
import { tcrypto, utils, type b64string } from '@tanker/crypto';
import { TankerError, DeviceRevoked, InternalError, InvalidArgument, InvalidVerification, OperationCanceled, PreconditionFailed } from '@tanker/errors';
import { fetch, retry, exponentialDelayGenerator } from '@tanker/http-utils';
import type { DelayGenerator } from '@tanker/http-utils'; // eslint-disable-line no-unused-vars

import { PromiseWrapper } from '../PromiseWrapper';
import { signChallenge } from './Authenticator';
import { genericErrorHandler } from './ErrorHandler';
import { b64RequestObject, urlize } from './utils';

export const defaultApiEndpoint = 'https://appd.tanker.io';

export type ClientOptions = {
  url: string,
  sdkInfo: { type: string, version: string },
}

const MAX_QUERY_STRING_ITEMS = 100;

/**
 * Network communication
 */
export class Client {
  /*:: _accessToken: string; */
  /*:: _apiEndpoint: string; */
  /*:: _apiRootPath: string; */
  /*:: _appId: Uint8Array; */
  /*:: _authenticating: ?Promise<void>; */
  /*:: _cancelationHandle: PromiseWrapper<string>; */
  /*:: _deviceId: Uint8Array | null; */
  /*:: _deviceSignatureKeyPair: tcrypto.SodiumKeyPair | null; */
  /*:: _isRevoked: bool; */
  /*:: _retryDelayGenerator: DelayGenerator; */
  /*:: _sdkType: string; */
  /*:: _sdkVersion: string; */
  /*:: _userId: Uint8Array; */

  constructor(appId: Uint8Array, userId: Uint8Array, options: ClientOptions) {
    const { url, sdkInfo } = { url: defaultApiEndpoint, ...options };
    this._accessToken = '';
    this._apiEndpoint = url;
    this._apiRootPath = `/v2/apps/${urlize(appId)}`;
    this._appId = appId;
    this._cancelationHandle = new PromiseWrapper<string>();
    this._deviceId = null;
    this._deviceSignatureKeyPair = null;
    this._isRevoked = false;
    this._retryDelayGenerator = exponentialDelayGenerator;
    this._sdkType = sdkInfo.type;
    this._sdkVersion = sdkInfo.version;
    this._userId = userId;
  }

  _cancelable = <F: Function>(fun: F): F => { // eslint-disable-line arrow-body-style
    // $FlowIgnore Our first promise will always reject so the return type doesn't matter
    return (...args: Array<any>) => Promise.race([
      this._cancelationHandle.promise.then((message) => { throw new OperationCanceled(message); }),
      fun(...args),
    ]);
  }

  // Simple fetch wrapper with:
  //   - proper headers set (sdk info and authorization)
  //   - generic error handling
  _baseApiCall = async (path: string, init?: RequestOptions): Promise<any> => {
    try {
      if (!path || path[0] !== '/') {
        throw new InvalidArgument('"path" should be non empty and start with "/"');
      }

      // $FlowIgnore Only using bare objects as headers so we're fine...
      const headers: { [string]: string } = (init && init.headers) || {};
      headers['X-Tanker-Sdktype'] = this._sdkType;
      headers['X-Tanker-Sdkversion'] = this._sdkVersion;

      if (this._accessToken) {
        headers['Authorization'] = `Bearer ${this._accessToken}`; // eslint-disable-line dot-notation
      }

      const url = `${this._apiEndpoint}${this._apiRootPath}${path}`;

      const response = await fetch(url, { ...init, headers });

      if (response.status === 204) { // no-content: no JSON response to parse
        return;
      }

      const { error, ...responseBody } = await response.json();

      if (response.ok) {
        return responseBody;
      }

      const apiMethod = init && init.method || 'GET';
      genericErrorHandler(apiMethod, url, error);
    } catch (e) {
      if (e instanceof DeviceRevoked) this._isRevoked = true;
      if (e instanceof TankerError) throw e;
      throw new InternalError(e.toString());
    }
  }

  // Advanced _baseApiCall wrapper with additional capabilities:
  //   - await authentication if in progress
  //   - smart retry on authentication failure (e.g. expired token)
  //   - call in progress can be canceled if close() called
  _apiCall = this._cancelable(async (path: string, init?: RequestOptions): Promise<any> => {
    if (this._authenticating) {
      await this._authenticating;
    }

    const retryOptions = {
      delayGenerator: this._retryDelayGenerator,
      retries: 1,
      retryCondition: async (error: Error) => {
        if (error instanceof PreconditionFailed && error.apiCode === 'invalid_token') {
          this._accessToken = '';
          await this._authenticate();
          return true;
        }
        return false;
      },
    };

    return retry(() => this._baseApiCall(path, init), retryOptions);
  })

  _authenticate = this._cancelable(async () => {
    if (this._authenticating) {
      return this._authenticating;
    }

    if (!this._deviceId)
      throw new InternalError('Assertion error: trying to authenticate without a device id');
    const deviceId = this._deviceId;

    if (!this._deviceSignatureKeyPair)
      throw new InternalError('Assertion error: trying to sign a challenge without a signature key pair');
    const deviceSignatureKeyPair = this._deviceSignatureKeyPair;

    const auth = async () => {
      const challengePath = `/devices/${urlize(deviceId)}/challenges`;
      const { challenge } = await this._baseApiCall(challengePath, { method: 'POST' });

      const signature = signChallenge(deviceSignatureKeyPair, challenge);

      const sessionPath = `/devices/${urlize(deviceId)}/sessions`;
      const { access_token: accessToken, is_revoked: isRevoked } = await this._baseApiCall(sessionPath, {
        method: 'POST',
        body: JSON.stringify(b64RequestObject({ signature, challenge })),
        headers: { 'Content-Type': 'application/json' },
      });

      this._accessToken = accessToken;
      this._isRevoked = isRevoked;
    };

    this._authenticating = auth().finally(() => {
      this._authenticating = null;
    });

    return this._authenticating;
  });

  authenticateDevice = async (deviceId: Uint8Array, signatureKeyPair: tcrypto.SodiumKeyPair) => {
    this._deviceId = deviceId;
    this._deviceSignatureKeyPair = signatureKeyPair;

    return this._authenticate().then(() => {
      if (this._isRevoked) {
        throw new DeviceRevoked();
      }
    });
  }

  getUser = async () => {
    const path = `/users/${urlize(this._userId)}`;

    try {
      const { user } = await this._apiCall(path);
      return user;
    } catch (e) {
      if (e instanceof TankerError) {
        if (e.apiCode === 'app_not_found') throw new PreconditionFailed(e);
        if (e.apiCode === 'user_not_found') return null;
      }
      throw e;
    }
  }

  getVerificationKey = async (body: any): Promise<Uint8Array> => {
    const path = `/users/${urlize(this._userId)}/verification-key`;

    const options = {
      method: 'POST',
      body: JSON.stringify(b64RequestObject(body)),
      headers: { 'Content-Type': 'application/json' },
    };

    const { encrypted_verification_key: key } = await this._apiCall(path, options);

    return utils.fromBase64(key);
  }

  getEncryptionKey = async (ghostDevicePublicSignatureKey: Uint8Array) => {
    const query = `ghost_device_public_signature_key=${urlize(ghostDevicePublicSignatureKey)}`;

    const path = `/users/${urlize(this._userId)}/encryption-key?${query}`;

    try {
      const { encrypted_user_private_encryption_key: key, ghost_device_id: id } = await this._apiCall(path);

      return {
        encryptedPrivateUserKey: utils.fromBase64(key),
        deviceId: utils.fromBase64(id),
      };
    } catch (e) {
      if (e instanceof TankerError) {
        if (e.apiCode === 'device_not_found') throw new InvalidVerification(e);
      }
      throw e;
    }
  }

  createUser = async (deviceId: Uint8Array, deviceSignatureKeyPair: tcrypto.SodiumKeyPair, body: any): Promise<void> => {
    const path = `/users/${urlize(this._userId)}`;

    const options = {
      method: 'POST',
      body: JSON.stringify(b64RequestObject(body)),
      headers: { 'Content-Type': 'application/json' },
    };

    const { access_token: accessToken } = await this._apiCall(path, options);

    this._accessToken = accessToken;
    this._deviceId = deviceId;
    this._deviceSignatureKeyPair = deviceSignatureKeyPair;
  }

  createDevice = async (deviceId: Uint8Array, deviceSignatureKeyPair: tcrypto.SodiumKeyPair, body: any): Promise<void> => {
    const options = {
      method: 'POST',
      body: JSON.stringify(b64RequestObject(body)),
      headers: { 'Content-Type': 'application/json' },
    };

    const { access_token: accessToken } = await this._apiCall('/devices', options);

    this._accessToken = accessToken;
    this._deviceId = deviceId;
    this._deviceSignatureKeyPair = deviceSignatureKeyPair;
  }

  getUserHistories = async (query: string): Promise<$Exact<{ root: b64string, histories: Array<b64string> }>> => {
    const path = `/user-histories?${query}`;
    const { root, histories } = await this._apiCall(path);
    return { root, histories };
  }

  getRevokedDeviceHistory = async (): Promise<$Exact<{ root: b64string, histories: Array<b64string> }>> => {
    if (!this._deviceId)
      throw new InternalError('Assertion error: trying to get revoked device history without a device id');
    const deviceId = this._deviceId;
    const { root, history: histories } = await this._apiCall(`/devices/${urlize(deviceId)}/revoked-device-history`);
    return { root, histories };
  }

  getUserHistoriesByUserIds = async (userIds: Array<Uint8Array>) => {
    if (this._isRevoked && userIds.length === 1 && utils.equalArray(userIds[0], this._userId)) {
      return this.getRevokedDeviceHistory();
    }

    const result = { root: '', histories: [] };
    for (let i = 0; i < userIds.length; i += MAX_QUERY_STRING_ITEMS) {
      const query = `user_ids[]=${userIds.slice(i, i + MAX_QUERY_STRING_ITEMS).map(id => urlize(id)).join('&user_ids[]=')}`;
      const response = await this.getUserHistories(query);
      result.root = response.root;
      result.histories = result.histories.concat(response.histories);
    }
    return result;
  }

  getUserHistoriesByDeviceIds = async (deviceIds: Array<Uint8Array>) => {
    const result = { root: '', histories: [] };
    for (let i = 0; i < deviceIds.length; i += MAX_QUERY_STRING_ITEMS) {
      const query = `device_ids[]=${deviceIds.slice(i, i + MAX_QUERY_STRING_ITEMS).map(id => urlize(id)).join('&device_ids[]=')}`;
      const response = await this.getUserHistories(query);
      result.root = response.root;
      result.histories = result.histories.concat(response.histories);
    }
    return result;
  }

  getVerificationMethods = async () => {
    const path = `/users/${urlize(this._userId)}/verification-methods`;
    const { verification_methods: verificationMethods } = await this._apiCall(path);
    return verificationMethods;
  }

  setVerificationMethod = async (body: any) => {
    await this._apiCall(`/users/${urlize(this._userId)}/verification-methods`, {
      method: 'POST',
      body: JSON.stringify(b64RequestObject(body)),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  getResourceKey = async (resourceId: Uint8Array): Promise<b64string> => {
    const query = `resource_ids[]=${urlize(resourceId)}`;
    const { resource_keys: resourceKeys } = await this._apiCall(`/resource-keys?${query}`);
    if (resourceKeys.length === 0) {
      throw new InvalidArgument(`could not find key for resource: ${utils.toBase64(resourceId)}`);
    }
    return resourceKeys[0];
  }

  publishResourceKeys = async (body: any): Promise<void> => {
    await this._apiCall('/resource-keys', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  revokeDevice = async (body: any): Promise<void> => {
    await this._apiCall('/device-revocations', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  createGroup = async (body: any): Promise<void> => {
    await this._apiCall('/user-groups', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  patchGroup = async (body: any): Promise<void> => {
    await this._apiCall('/user-groups', {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  getGroupHistories = (query: string): Promise<$Exact<{ histories: Array<b64string> }>> => { // eslint-disable-line arrow-body-style
    return this._apiCall(`/user-group-histories?${query}`);
  }

  getGroupHistoriesByGroupIds = async (groupIds: Array<Uint8Array>): Promise<$Exact<{ histories: Array<b64string> }>> => {
    const result = { histories: [] };

    for (let i = 0; i < groupIds.length; i += MAX_QUERY_STRING_ITEMS) {
      const query = `user_group_ids[]=${groupIds.slice(i, i + MAX_QUERY_STRING_ITEMS).map(id => urlize(id)).join('&user_group_ids[]=')}`;
      const response = await this.getGroupHistories(query);
      result.histories = result.histories.concat(response.histories);
    }
    return result;
  }

  getGroupHistoriesByGroupPublicEncryptionKey = (groupPublicEncryptionKey: Uint8Array) => {
    const query = `user_group_public_encryption_key=${urlize(groupPublicEncryptionKey)}`;
    return this.getGroupHistories(query);
  }

  getFileUploadURL = (resourceId: Uint8Array, metadata: b64string, uploadContentLength: number) => {
    const query = `metadata=${urlize(metadata)}&upload_content_length=${uploadContentLength}`;
    return this._apiCall(`/resources/${urlize(resourceId)}/upload-url?${query}`);
  }

  getFileDownloadURL = (resourceId: Uint8Array) => { // eslint-disable-line arrow-body-style
    return this._apiCall(`/resources/${urlize(resourceId)}/download-url`);
  }

  getPublicProvisionalIdentities = async (hashedEmails: Array<Uint8Array>) => {
    let result = {};
    for (let i = 0; i < hashedEmails.length; i += MAX_QUERY_STRING_ITEMS) {
      const query = `hashed_emails[]=${hashedEmails.slice(i, i + MAX_QUERY_STRING_ITEMS).map(id => urlize(id)).join('&hashed_emails[]=')}`;
      const path = `/public-provisional-identities?${query}`;
      const { public_provisional_identities: publicProvisionalIdentitiesByHashedEmail } = await this._apiCall(path);
      result = { ...result, ...publicProvisionalIdentitiesByHashedEmail };
    }
    return result;
  }

  getProvisionalIdentityClaims = async () => {
    const path = `/users/${urlize(this._userId)}/provisional-identity-claims`;
    const { provisional_identity_claims: claims } = await this._apiCall(path);
    return claims;
  }

  getProvisionalIdentity = async (body: any) => {
    const options = {
      method: 'POST',
      body: body ? JSON.stringify(b64RequestObject(body)) : '{}',
      headers: { 'Content-Type': 'application/json' },
    };

    try {
      const { provisional_identity: provisionalIdentity } = await this._apiCall('/provisional-identities', options);
      return provisionalIdentity;
    } catch (e) {
      if (e instanceof TankerError) {
        if (e.apiCode === 'provisional_identity_not_found') return null;
      }
      throw e;
    }
  }

  claimProvisionalIdentity = async (body: any): Promise<void> => {
    await this._apiCall('/provisional-identity-claims', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  close = async (): Promise<void> => {
    this._cancelationHandle.resolve('Closing the client');

    this._accessToken = '';
    this._deviceId = null;
    this._deviceSignatureKeyPair = null;
  }
}
