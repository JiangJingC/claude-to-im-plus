import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { BridgeStore } from 'claude-to-im/src/lib/bridge/host.js';
import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import { CTI_HOME } from '../config.js';
import { DingtalkAdapter } from '../adapters/dingtalk-adapter.js';
import { getDingtalkWebhooksFilePath } from '../dingtalk-store.js';

function createMockStore(settings: Record<string, string> = {}) {
  return {
    getSetting: (key: string) => settings[key] ?? null,
    insertAuditLog: () => {},
  };
}

function setupContext(store: ReturnType<typeof createMockStore>) {
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  initBridgeContext({
    store: store as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
}

class FakeClient {
  connected = false;
  listeners = new Map<string, (message: { data: string }) => void>();
  connectCalls = 0;
  disconnectCalls = 0;

  registerCallbackListener(topic: string, callback: (message: any) => void): void {
    this.listeners.set(topic, callback as (message: { data: string }) => void);
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.connected = true;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connected = false;
  }
}

const DATA_DIR = path.join(CTI_HOME, 'data');

describe('dingtalk-adapter', () => {
  beforeEach(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.rmSync(getDingtalkWebhooksFilePath(), { force: true });
    setupContext(createMockStore({
      bridge_dingtalk_app_key: 'app-key',
      bridge_dingtalk_app_secret: 'app-secret',
    }));
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('accepts private text messages', async () => {
    const adapter = new DingtalkAdapter();
    await adapter.processMessage({
      msgId: 'msg-private-1',
      conversationId: 'conv-private',
      conversationType: '1',
      senderStaffId: 'staff-1',
      senderNick: 'Alice',
      text: { content: '你好' },
      sessionWebhook: 'https://hook.example/private',
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.address.chatId, 'conv-private');
    assert.equal(inbound?.address.userId, 'staff-1');
    assert.equal(inbound?.text, '你好');
  });

  it('ignores group text without @ mention or reply-to-bot', async () => {
    const adapter = new DingtalkAdapter();
    await adapter.processMessage({
      msgId: 'msg-group-ignore',
      conversationId: 'conv-group',
      conversationType: '2',
      text: { content: '普通群消息' },
      sessionWebhook: 'https://hook.example/group',
    });

    assert.equal((adapter as any).queue.length, 0);
  });

  it('accepts group @bot messages and strips the mention prefix', async () => {
    const adapter = new DingtalkAdapter();
    await adapter.processMessage({
      msgId: 'msg-group-at',
      conversationId: 'conv-group',
      conversationType: '2',
      text: { content: '@机器人 帮我检查一下' },
      sessionWebhook: 'https://hook.example/group',
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.text, '帮我检查一下');
  });

  it('accepts group messages when DingTalk marks the bot in atUsers/isInAtList even if text omits the @ prefix', async () => {
    const adapter = new DingtalkAdapter();
    await adapter.processMessage({
      msgId: 'msg-group-atlist',
      conversationId: 'conv-group',
      conversationType: '2',
      chatbotUserId: 'bot-user',
      isInAtList: true,
      atUsers: [{ dingtalkId: 'bot-user' }],
      text: { content: ' 直接艾特但正文无前缀 ' },
      sessionWebhook: 'https://hook.example/group',
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.text, '直接艾特但正文无前缀');
  });

  it('accepts group reply-to-bot messages', async () => {
    const adapter = new DingtalkAdapter();
    await adapter.processMessage({
      msgId: 'msg-group-reply',
      conversationId: 'conv-group',
      conversationType: '2',
      chatbotUserId: 'bot-user',
      text: {
        content: '继续这个问题',
        isReplyMsg: true,
        repliedMsg: {
          senderId: 'bot-user',
        },
      },
      sessionWebhook: 'https://hook.example/group',
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.text, '继续这个问题');
  });

  it('replies with a fixed fallback for unsupported media-only messages', async () => {
    const webhookCalls: Array<{ sessionWebhook: string; text: string }> = [];
    const adapter = new DingtalkAdapter({
      postToWebhook: async (sessionWebhook, text) => {
        webhookCalls.push({ sessionWebhook, text });
        return new Response('{}', { status: 200 });
      },
    });

    await adapter.processMessage({
      msgId: 'msg-media-only',
      conversationId: 'conv-group',
      conversationType: '1',
      richText: {
        content: [{ msgType: 'picture' }],
      },
      sessionWebhook: 'https://hook.example/group',
    } as any);

    assert.deepEqual(webhookCalls, [{
      sessionWebhook: 'https://hook.example/group',
      text: '暂不支持图片、视频或文件，请发送文字消息。',
    }]);
  });

  it('send() uses the cached sessionWebhook for the chat', async () => {
    const webhookCalls: Array<{ sessionWebhook: string; text: string }> = [];
    const adapter = new DingtalkAdapter({
      postToWebhook: async (sessionWebhook, text) => {
        webhookCalls.push({ sessionWebhook, text });
        return new Response('{}', { status: 200 });
      },
    });

    await adapter.processMessage({
      msgId: 'msg-cache-webhook',
      conversationId: 'conv-send',
      conversationType: '1',
      text: { content: '缓存 webhook' },
      sessionWebhook: 'https://hook.example/send',
      sessionWebhookExpiredTime: Date.now() + 60_000,
    });
    await adapter.consumeOne();

    const result = await adapter.send({
      address: {
        channelType: 'dingtalk',
        chatId: 'conv-send',
      },
      text: 'bridge reply',
      parseMode: 'plain',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(webhookCalls, [{
      sessionWebhook: 'https://hook.example/send',
      text: 'bridge reply',
    }]);
  });

  it('send() fails clearly when webhook is missing or expired', async () => {
    const adapter = new DingtalkAdapter();

    const missing = await adapter.send({
      address: { channelType: 'dingtalk', chatId: 'conv-missing' },
      text: 'hello',
      parseMode: 'plain',
    });
    assert.equal(missing.ok, false);
    assert.match(missing.error || '', /No DingTalk sessionWebhook cached/);

    await adapter.processMessage({
      msgId: 'msg-expired-webhook',
      conversationId: 'conv-expired',
      conversationType: '1',
      text: { content: '缓存过期 webhook' },
      sessionWebhook: 'https://hook.example/expired',
      sessionWebhookExpiredTime: Date.now() - 1,
    });
    await adapter.consumeOne();

    const expired = await adapter.send({
      address: { channelType: 'dingtalk', chatId: 'conv-expired' },
      text: 'hello',
      parseMode: 'plain',
    });
    assert.equal(expired.ok, false);
    assert.match(expired.error || '', /expired/);
  });

  it('start and stop are idempotent', async () => {
    const fakeClient = new FakeClient();
    const adapter = new DingtalkAdapter({
      createClient: () => fakeClient,
    });

    await adapter.start();
    await adapter.start();
    assert.equal(fakeClient.connectCalls, 1);
    assert.equal(adapter.isRunning(), true);

    await adapter.stop();
    await adapter.stop();
    assert.equal(fakeClient.disconnectCalls, 1);
    assert.equal(adapter.isRunning(), false);
  });

  it('deduplicates repeated callback messages by msgId', async () => {
    const adapter = new DingtalkAdapter();
    const msg = {
      msgId: 'msg-dup-1',
      conversationId: 'conv-dup',
      conversationType: '1',
      text: { content: '重复消息' },
      sessionWebhook: 'https://hook.example/dup',
    };

    await adapter.processMessage(msg);
    await adapter.processMessage(msg);

    const first = await adapter.consumeOne();
    assert.ok(first);
    assert.equal((adapter as any).queue.length, 0);
  });
});
