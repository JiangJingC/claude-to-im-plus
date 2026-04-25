import crypto from 'node:crypto';
import type { FileAttachment } from 'claude-to-im/src/lib/bridge/types.js';

const DINGTALK_API_BASE = 'https://api.dingtalk.com';
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const MAX_IMAGE_SIZE = 100 * 1024 * 1024;

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

interface AccessTokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface DownloadUrlResponse {
  downloadUrl?: string;
}

interface AccessTokenCacheEntry {
  token: string;
  expiresAt: number;
}

export interface DingtalkImageDownloadRequest {
  appKey: string;
  appSecret: string;
  corpId: string;
  robotCode: string;
  downloadCode: string;
  filenameHint?: string;
}

export interface DingtalkImageDownloaderLike {
  downloadImageAttachment(request: DingtalkImageDownloadRequest): Promise<FileAttachment>;
}

function trimBody(body: string): string {
  const singleLine = body.replace(/\s+/g, ' ').trim();
  if (!singleLine) return '';
  return singleLine.length > 200 ? `${singleLine.slice(0, 197)}...` : singleLine;
}

function parseMimeType(contentType: string | null): string | undefined {
  if (!contentType) return undefined;
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mime || undefined;
}

function getExtensionFromUrl(downloadUrl: string): string | undefined {
  try {
    const pathname = new URL(downloadUrl, DINGTALK_API_BASE).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
    return match?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

function inferImageMimeType(downloadUrl: string, contentType: string | null, filenameHint?: string): string | undefined {
  const mimeFromHeader = parseMimeType(contentType);
  if (mimeFromHeader?.startsWith('image/')) {
    return mimeFromHeader === 'image/jpg' ? 'image/jpeg' : mimeFromHeader;
  }

  const extFromHint = filenameHint?.split('.').pop()?.toLowerCase();
  if (extFromHint && IMAGE_EXT_TO_MIME[extFromHint]) {
    return IMAGE_EXT_TO_MIME[extFromHint];
  }

  const extFromUrl = getExtensionFromUrl(downloadUrl);
  if (extFromUrl && IMAGE_EXT_TO_MIME[extFromUrl]) {
    return IMAGE_EXT_TO_MIME[extFromUrl];
  }

  return undefined;
}

function buildFilename(mimeType: string, filenameHint?: string): string {
  if (filenameHint?.trim()) {
    return filenameHint.trim();
  }
  const ext = MIME_TO_EXT[mimeType] || '.jpg';
  return `dingtalk-image-${Date.now()}${ext}`;
}

export class DingtalkMediaDownloader implements DingtalkImageDownloaderLike {
  private readonly tokenCache = new Map<string, AccessTokenCacheEntry>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async downloadImageAttachment(request: DingtalkImageDownloadRequest): Promise<FileAttachment> {
    const accessToken = await this.getAccessToken(request);
    const downloadUrl = await this.getDownloadUrl(request, accessToken);
    const response = await this.fetchImpl(downloadUrl, {
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const body = trimBody(await response.text().catch(() => ''));
      throw new Error(`DingTalk image download failed: ${response.status}${body ? `: ${body}` : ''}`);
    }

    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0) {
      throw new Error('DingTalk image download returned an empty body');
    }
    if (data.length > MAX_IMAGE_SIZE) {
      throw new Error(`DingTalk image too large: ${data.length} bytes`);
    }

    const mimeType = inferImageMimeType(downloadUrl, response.headers.get('content-type'), request.filenameHint);
    if (!mimeType?.startsWith('image/')) {
      throw new Error(`DingTalk media is not an image: ${parseMimeType(response.headers.get('content-type')) || 'unknown'}`);
    }

    return {
      id: crypto.randomUUID(),
      name: buildFilename(mimeType, request.filenameHint),
      type: mimeType,
      size: data.length,
      data: data.toString('base64'),
    };
  }

  private cacheKey(request: DingtalkImageDownloadRequest): string {
    return `${request.corpId}\u0000${request.appKey}`;
  }

  private async getAccessToken(request: DingtalkImageDownloadRequest): Promise<string> {
    const cacheKey = this.cacheKey(request);
    const cached = this.tokenCache.get(cacheKey);
    const now = this.now();
    if (cached && cached.expiresAt > now) {
      return cached.token;
    }

    const response = await this.fetchImpl(
      `${DINGTALK_API_BASE}/v1.0/oauth2/${encodeURIComponent(request.corpId)}/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: request.appKey,
          client_secret: request.appSecret,
          grant_type: 'client_credentials',
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!response.ok) {
      const body = trimBody(await response.text().catch(() => ''));
      throw new Error(`DingTalk access token request failed: ${response.status}${body ? `: ${body}` : ''}`);
    }

    const payload = await response.json() as AccessTokenResponse;
    if (!payload.access_token) {
      throw new Error('DingTalk access token response did not include access_token');
    }

    const expiresInMs = Math.max((payload.expires_in ?? 7200) * 1000 - TOKEN_EXPIRY_SKEW_MS, 60_000);
    this.tokenCache.set(cacheKey, {
      token: payload.access_token,
      expiresAt: now + expiresInMs,
    });
    return payload.access_token;
  }

  private async getDownloadUrl(request: DingtalkImageDownloadRequest, accessToken: string): Promise<string> {
    const response = await this.fetchImpl(`${DINGTALK_API_BASE}/v1.0/robot/messageFiles/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken,
      },
      body: JSON.stringify({
        downloadCode: request.downloadCode,
        robotCode: request.robotCode,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = trimBody(await response.text().catch(() => ''));
      throw new Error(`DingTalk download URL request failed: ${response.status}${body ? `: ${body}` : ''}`);
    }

    const payload = await response.json() as DownloadUrlResponse;
    if (!payload.downloadUrl) {
      throw new Error('DingTalk download URL response did not include downloadUrl');
    }

    return payload.downloadUrl;
  }
}
