import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DingtalkMediaDownloader } from '../adapters/dingtalk/dingtalk-media.js';

type FetchCall = {
  url: string;
  init?: RequestInit;
};

describe('dingtalk-media', () => {
  const originalFetch = globalThis.fetch;
  let calls: FetchCall[] = [];

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async () => {
      throw new Error('fetch mock not configured');
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('downloads image attachments through app token + downloadCode', async () => {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/v1.0/oauth2/')) {
        return Response.json({ access_token: 'token-1', expires_in: 7200 });
      }
      if (url.endsWith('/v1.0/robot/messageFiles/download')) {
        return Response.json({ downloadUrl: 'https://download.example/test.png' });
      }
      if (url === 'https://download.example/test.png') {
        return new Response(Buffer.from('png-image'), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const downloader = new DingtalkMediaDownloader(globalThis.fetch, () => 1_700_000_000_000);
    const attachment = await downloader.downloadImageAttachment({
      appKey: 'app-key',
      appSecret: 'app-secret',
      corpId: 'ding-corp-1',
      robotCode: 'ding-robot-1',
      downloadCode: 'download-code-1',
    });

    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.url, 'https://api.dingtalk.com/v1.0/oauth2/ding-corp-1/token');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      client_id: 'app-key',
      client_secret: 'app-secret',
      grant_type: 'client_credentials',
    });
    assert.equal(calls[1]?.url, 'https://api.dingtalk.com/v1.0/robot/messageFiles/download');
    assert.equal(calls[1]?.init?.headers && (calls[1].init.headers as Record<string, string>)['x-acs-dingtalk-access-token'], 'token-1');
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
      downloadCode: 'download-code-1',
      robotCode: 'ding-robot-1',
    });
    assert.equal(attachment.type, 'image/png');
    assert.equal(attachment.data, Buffer.from('png-image').toString('base64'));
  });

  it('reuses the cached app token before expiry', async () => {
    let tokenRequests = 0;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/v1.0/oauth2/')) {
        tokenRequests += 1;
        return Response.json({ access_token: 'cached-token', expires_in: 7200 });
      }
      if (url.endsWith('/v1.0/robot/messageFiles/download')) {
        return Response.json({ downloadUrl: 'https://download.example/test.jpg' });
      }
      if (url === 'https://download.example/test.jpg') {
        return new Response(Buffer.from('jpg-image'), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const downloader = new DingtalkMediaDownloader(globalThis.fetch, () => 1_700_000_000_000);
    await downloader.downloadImageAttachment({
      appKey: 'app-key',
      appSecret: 'app-secret',
      corpId: 'ding-corp-1',
      robotCode: 'ding-robot-1',
      downloadCode: 'download-code-1',
    });
    await downloader.downloadImageAttachment({
      appKey: 'app-key',
      appSecret: 'app-secret',
      corpId: 'ding-corp-1',
      robotCode: 'ding-robot-1',
      downloadCode: 'download-code-2',
    });

    assert.equal(tokenRequests, 1);
  });

  it('rejects non-image downloads', async () => {
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/v1.0/oauth2/')) {
        return Response.json({ access_token: 'token-1', expires_in: 7200 });
      }
      if (url.endsWith('/v1.0/robot/messageFiles/download')) {
        return Response.json({ downloadUrl: 'https://download.example/test.bin' });
      }
      if (url === 'https://download.example/test.bin') {
        return new Response(Buffer.from('not-an-image'), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const downloader = new DingtalkMediaDownloader(globalThis.fetch);
    await assert.rejects(
      downloader.downloadImageAttachment({
        appKey: 'app-key',
        appSecret: 'app-secret',
        corpId: 'ding-corp-1',
        robotCode: 'ding-robot-1',
        downloadCode: 'download-code-1',
      }),
      /not an image/i,
    );
  });
});
