import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CTI_HOME } from '../config.js';
import {
  getDingtalkWebhook,
  getDingtalkWebhooksFilePath,
  isDingtalkWebhookExpired,
  upsertDingtalkWebhook,
} from '../dingtalk-store.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const WEBHOOKS_PATH = getDingtalkWebhooksFilePath();

describe('dingtalk-store', () => {
  beforeEach(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.rmSync(WEBHOOKS_PATH, { force: true });
  });

  it('upserts and reads webhook records by chatId', () => {
    upsertDingtalkWebhook({
      chatId: 'conv-1',
      sessionWebhook: 'https://hook.example/1',
      sessionWebhookExpiredTime: 12345,
    });

    const record = getDingtalkWebhook('conv-1');
    assert.equal(record?.chatId, 'conv-1');
    assert.equal(record?.sessionWebhook, 'https://hook.example/1');
    assert.equal(record?.sessionWebhookExpiredTime, 12345);
  });

  it('updates existing webhook records', () => {
    upsertDingtalkWebhook({
      chatId: 'conv-1',
      sessionWebhook: 'https://hook.example/old',
      sessionWebhookExpiredTime: 100,
    });
    upsertDingtalkWebhook({
      chatId: 'conv-1',
      sessionWebhook: 'https://hook.example/new',
      sessionWebhookExpiredTime: 200,
    });

    const record = getDingtalkWebhook('conv-1');
    assert.equal(record?.sessionWebhook, 'https://hook.example/new');
    assert.equal(record?.sessionWebhookExpiredTime, 200);
  });

  it('detects expiry from sessionWebhookExpiredTime', () => {
    const active = {
      chatId: 'conv-active',
      sessionWebhook: 'https://hook.example/active',
      sessionWebhookExpiredTime: 2_000,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const expired = {
      chatId: 'conv-expired',
      sessionWebhook: 'https://hook.example/expired',
      sessionWebhookExpiredTime: 1_000,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    assert.equal(isDingtalkWebhookExpired(active, 1_500), false);
    assert.equal(isDingtalkWebhookExpired(expired, 1_500), true);
  });
});
