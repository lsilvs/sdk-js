//@flow
import fetchPonyfill from 'fetch-ponyfill';

const { fetch } = fetchPonyfill({ Promise });

type PrivateIdentity = {
  permanentIdentity: string,
  provisionalIdentity: string,
};

type PrivateIdentityResponse = {
  private_permanent_identity: string,
  private_provisional_identity?: string,
};

type PublicIdentitiesResponse = Array<{
  email: string,
  public_identity: string,
}>;

// Converts the base64 argument into the URL safe variant (RFC 4648)
const ensureUrlSafeBase64 = (b64str: string) => b64str.replace(/[/+]/g, (char: string) => {
  if (char === '/') return '_';
  if (char === '+') return '-';
  return '';
});

// Use a single '/' to join path elements, e.g.
//
//   pathJoin('http://a.com', 'api', 'v1/', '/users') === 'http://a.com/api/v1/users'
//
const pathJoin = (...args: Array<string>) => {
  const trimSlashes = args.map(p => p.replace(/(^\/|\/$)/g, ''));
  return trimSlashes.join('/');
};

type Config = $Exact<{ appId?: string, trustchainId?: string, url?: string }>;

export default class FakeAuthentication {
  appId: string;
  baseUrl: string;

  constructor(config: Config) {
    const appId = config.appId || config.trustchainId;

    if (typeof appId !== 'string')
      throw new Error('Invalid appId option');

    this.appId = ensureUrlSafeBase64(appId);

    const serverUrl = config.url || 'https://fakeauth.tanker.io';
    this.baseUrl = pathJoin(serverUrl, 'apps', encodeURIComponent(this.appId));
  }

  async getPrivateIdentity(email?: string): Promise<PrivateIdentity> {
    let url;

    if (typeof email === 'string') {
      url = pathJoin(this.baseUrl, `private_identity?email=${encodeURIComponent(email)}`);
    } else {
      url = pathJoin(this.baseUrl, 'disposable_private_identity');
    }

    const response = await fetch(url);

    if (!response.ok)
      throw new Error(`Server error: ${await response.text()}`);

    const json: PrivateIdentityResponse = await response.json();

    const privateIdentity = {};
    privateIdentity.permanentIdentity = json.private_permanent_identity;

    if (typeof json.private_provisional_identity === 'string')
      privateIdentity.provisionalIdentity = json.private_provisional_identity;

    return privateIdentity;
  }

  async getPublicIdentities(emails: Array<string>): Promise<Array<string>> {
    if (!Array.isArray(emails) || emails.some(email => typeof email !== 'string'))
      throw new Error(`Invalid emails: ${JSON.stringify(emails)}`);

    const url = pathJoin(this.baseUrl, `public_identities?emails=${encodeURIComponent(emails.join(','))}`);
    const response = await fetch(url);

    if (!response.ok)
      throw new Error(`Server error: ${await response.text()}`);

    const publicIdentities: PublicIdentitiesResponse = await response.json();

    return publicIdentities.map(pubId => pubId.public_identity);
  }
}