import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { BridgeStore } from 'claude-to-im/src/lib/bridge/host.js';
import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import { CTI_HOME } from '../config.js';
import { DingtalkAdapter } from '../adapters/dingtalk-adapter.js';
import { getDingtalkWebhook, getDingtalkWebhooksFilePath } from '../dingtalk-store.js';

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

    const record = getDingtalkWebhook('conv-private');
    assert.equal(record?.senderNick, 'Alice');
    assert.equal(record?.conversationType, '1');
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
      conversationTitle: '研发群',
      text: { content: '@机器人 帮我检查一下' },
      sessionWebhook: 'https://hook.example/group',
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.text, '帮我检查一下');

    const record = getDingtalkWebhook('conv-group');
    assert.equal(record?.conversationTitle, '研发群');
    assert.equal(record?.conversationType, '2');
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

  it('accepts private picture messages and forwards image attachments', async () => {
    const requests: Array<{ downloadCode: string; robotCode: string; corpId: string }> = [];
    const adapter = new DingtalkAdapter({
      downloadImageAttachment: async (request) => {
        requests.push({
          downloadCode: request.downloadCode,
          robotCode: request.robotCode,
          corpId: request.corpId,
        });
        return {
          id: 'img-1',
          name: 'test.png',
          type: 'image/png',
          size: 4,
          data: 'cG5n',
        };
      },
    });

    await adapter.processMessage({
      msgId: 'msg-picture-private',
      msgtype: 'picture',
      conversationId: 'conv-private-picture',
      conversationType: '1',
      chatbotCorpId: 'ding-corp-1',
      robotCode: 'ding-robot-1',
      senderStaffId: 'staff-1',
      senderNick: 'Alice',
      content: {
        pictureDownloadCode: 'picture-code-1',
      },
      sessionWebhook: 'https://hook.example/private',
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.text, '');
    assert.equal(inbound?.attachments?.length, 1);
    assert.equal(inbound?.attachments?.[0]?.type, 'image/png');
    assert.deepEqual(requests, [{
      downloadCode: 'picture-code-1',
      robotCode: 'ding-robot-1',
      corpId: 'ding-corp-1',
    }]);
  });

  it('accepts group richText with text and picture attachments', async () => {
    const requests: Array<{ downloadCode: string }> = [];
    const adapter = new DingtalkAdapter({
      downloadImageAttachment: async (request) => {
        requests.push({ downloadCode: request.downloadCode });
        return {
          id: 'img-2',
          name: 'diagram.jpg',
          type: 'image/jpeg',
          size: 8,
          data: 'aW1hZ2U=',
        };
      },
    });

    await adapter.processMessage({
      msgId: 'msg-picture-group',
      msgtype: 'richText',
      conversationId: 'conv-group-picture',
      conversationType: '2',
      chatbotCorpId: 'ding-corp-1',
      robotCode: 'ding-robot-1',
      richText: {
        content: [
          { msgType: 'at', content: '机器人' },
          { msgType: 'text', content: '看下这张图' },
          { msgType: 'picture', pictureDownloadCode: 'picture-code-2', downloadCode: 'download-code-2' },
        ],
      },
      sessionWebhook: 'https://hook.example/group',
    } as any);

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.text, '看下这张图');
    assert.equal(inbound?.attachments?.length, 1);
    assert.equal(inbound?.attachments?.[0]?.name, 'diagram.jpg');
    assert.deepEqual(requests, [{ downloadCode: 'download-code-2' }]);
  });

  it('surfaces a clear inbound error when image download fails', async () => {
    const adapter = new DingtalkAdapter({
      downloadImageAttachment: async () => {
        throw new Error('download failed');
      },
    });

    await adapter.processMessage({
      msgId: 'msg-picture-failed',
      msgtype: 'picture',
      conversationId: 'conv-private-picture',
      conversationType: '1',
      chatbotCorpId: 'ding-corp-1',
      robotCode: 'ding-robot-1',
      content: {
        pictureDownloadCode: 'picture-code-3',
      },
      sessionWebhook: 'https://hook.example/private',
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.text, '');
    assert.equal(
      (inbound?.raw as { userVisibleError?: string } | undefined)?.userVisibleError,
      'Failed to download the DingTalk image attachment. Please send it again.',
    );
  });

  it('replies with a fixed fallback for unsupported non-image media-only messages', async () => {
    const webhookCalls: Array<{ sessionWebhook: string; payload: unknown }> = [];
    const adapter = new DingtalkAdapter({
      postToWebhook: async (sessionWebhook, payload) => {
        webhookCalls.push({ sessionWebhook, payload });
        return new Response('{}', { status: 200 });
      },
    });

    await adapter.processMessage({
      msgId: 'msg-media-only',
      conversationId: 'conv-group',
      conversationType: '1',
      richText: {
        content: [{ msgType: 'video' }],
      },
      sessionWebhook: 'https://hook.example/group',
    } as any);

    assert.deepEqual(webhookCalls, [{
      sessionWebhook: 'https://hook.example/group',
      payload: {
        msgtype: 'text',
        text: { content: '暂不支持视频、语音或文件，请发送文字或图片消息。' },
      },
    }]);
  });

  it('send() uses the cached sessionWebhook for the chat', async () => {
    const webhookCalls: Array<{ sessionWebhook: string; payload: unknown }> = [];
    const adapter = new DingtalkAdapter({
      postToWebhook: async (sessionWebhook, payload) => {
        webhookCalls.push({ sessionWebhook, payload });
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
      payload: {
        msgtype: 'text',
        text: { content: 'bridge reply' },
      },
    }]);
  });

  it('send() uses DingTalk markdown payloads when parseMode is Markdown', async () => {
    const webhookCalls: Array<{ sessionWebhook: string; payload: unknown }> = [];
    const adapter = new DingtalkAdapter({
      postToWebhook: async (sessionWebhook, payload) => {
        webhookCalls.push({ sessionWebhook, payload });
        return new Response('{}', { status: 200 });
      },
    });

    await adapter.processMessage({
      msgId: 'msg-cache-markdown',
      conversationId: 'conv-markdown',
      conversationType: '1',
      text: { content: '缓存 markdown webhook' },
      sessionWebhook: 'https://hook.example/markdown',
      sessionWebhookExpiredTime: Date.now() + 60_000,
    });
    await adapter.consumeOne();

    const result = await adapter.send({
      address: {
        channelType: 'dingtalk',
        chatId: 'conv-markdown',
      },
      text: '## 标题\n\n**加粗** `代码`',
      parseMode: 'Markdown',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(webhookCalls, [{
      sessionWebhook: 'https://hook.example/markdown',
      payload: {
        msgtype: 'markdown',
        markdown: {
          title: '标题',
          text: '## 标题\n\n**加粗** `代码`',
        },
      },
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
