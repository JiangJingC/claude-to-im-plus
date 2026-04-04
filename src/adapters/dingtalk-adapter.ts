import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from 'claude-to-im/src/lib/bridge/types.js';
import { BaseChannelAdapter, registerAdapterFactory } from 'claude-to-im/src/lib/bridge/channel-adapter.js';
import { getBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream';
import {
  getDingtalkWebhook,
  isDingtalkWebhookExpired,
  upsertDingtalkWebhook,
} from '../dingtalk-store.js';

const DEDUP_TTL_MS = 5 * 60 * 1000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const UNSUPPORTED_MESSAGE_TEXT = '暂不支持图片、视频或文件，请发送文字消息。';

type DingtalkConversationType = '1' | '2' | string;

interface DingtalkReplyMeta {
  isReplyMsg?: boolean;
  repliedMsg?: {
    senderId?: string;
    senderStaffId?: string;
    content?: {
      text?: string;
      richText?: unknown;
    };
  };
}

interface DingtalkRichTextPart {
  msgType?: string;
  type?: string;
  content?: string;
  atName?: string;
  text?: string;
}

interface DingtalkRobotMessage {
  msgId: string;
  conversationId: string;
  conversationType: DingtalkConversationType;
  msgtype?: string;
  senderNick?: string;
  senderStaffId?: string;
  senderId?: string;
  chatbotUserId?: string;
  isInAtList?: boolean;
  atUsers?: Array<{
    dingtalkId?: string;
    staffId?: string;
    userId?: string;
  }>;
  createAt?: number;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
  text?: {
    content?: string;
    isReplyMsg?: boolean;
    repliedMsg?: DingtalkReplyMeta['repliedMsg'];
  };
  richText?: {
    content?: unknown;
  };
  content?: {
    text?: string;
    richText?: unknown;
  };
}

interface ExtractedText {
  text: string;
  unsupported: string[];
  hasMention: boolean;
}

interface DingtalkMessageSummary {
  msgId?: string;
  conversationId?: string;
  conversationType?: DingtalkConversationType;
  msgtype?: string;
  senderStaffId?: string;
  senderId?: string;
  chatbotUserId?: string;
  textContent?: string;
  textIsReplyMsg?: boolean;
  repliedSenderId?: string;
  repliedSenderStaffId?: string;
  richTextKinds?: string[];
  hasSessionWebhook: boolean;
  sessionWebhookExpiredTime?: number | null;
}

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

interface DingtalkClientLike {
  connected: boolean;
  registerCallbackListener(topic: string, callback: (message: DWClientDownStream) => void): unknown;
  connect(): Promise<void>;
  disconnect(): void;
}

interface DingtalkTextWebhookPayload {
  msgtype: 'text';
  text: {
    content: string;
  };
}

interface DingtalkMarkdownWebhookPayload {
  msgtype: 'markdown';
  markdown: {
    title: string;
    text: string;
  };
}

type DingtalkWebhookPayload = DingtalkTextWebhookPayload | DingtalkMarkdownWebhookPayload;

interface AdapterDeps {
  createClient?: (config: { appKey: string; appSecret: string }) => DingtalkClientLike;
  postToWebhook?: (sessionWebhook: string, payload: DingtalkWebhookPayload) => Promise<Response>;
}

function createDefaultClient(config: { appKey: string; appSecret: string }): DingtalkClientLike {
  const client = new DWClient({
    clientId: config.appKey,
    clientSecret: config.appSecret,
    keepAlive: true,
    debug: false,
  } as ConstructorParameters<typeof DWClient>[0]) as unknown as DingtalkClientLike & {
    config?: { autoReconnect?: boolean };
  };
  if (client.config) {
    client.config.autoReconnect = false;
  }
  return client;
}

function extractMessageText(msg: DingtalkRobotMessage): ExtractedText {
  if (msg?.text?.content) {
    return {
      text: msg.text.content.trim(),
      unsupported: [],
      hasMention: /^@\S+/.test(msg.text.content.trim()),
    };
  }

  const unsupported: string[] = [];
  const parts: string[] = [];
  let hasMention = false;
  const richText = msg?.richText?.content ?? msg?.content?.richText;

  if (typeof richText === 'string') {
    parts.push(richText);
    if (/^@\S+/.test(richText.trim())) {
      hasMention = true;
    }
  } else if (richText && typeof richText === 'object' && !Array.isArray(richText)) {
    const value = (richText as { text?: string; content?: string }).text
      ?? (richText as { text?: string; content?: string }).content;
    if (value) {
      parts.push(value);
      if (/^@\S+/.test(value.trim())) {
        hasMention = true;
      }
    }
  } else if (Array.isArray(richText)) {
    for (const part of richText as DingtalkRichTextPart[]) {
      const type = part?.msgType ?? part?.type;
      if (type === 'text' && part?.content) {
        parts.push(part.content);
      } else if (type === 'emoji') {
        parts.push(part.content || '[表情]');
      } else if (type === 'at') {
        hasMention = true;
        parts.push(`@${part.content || part.atName || '某人'}`);
      } else if (type === 'picture' || type === 'video' || type === 'file') {
        unsupported.push(type);
      } else if (part?.text) {
        parts.push(part.text);
      }
    }
  }

  return {
    text: parts.join('').trim(),
    unsupported,
    hasMention,
  };
}

function stripLeadingMentions(text: string): string {
  return text.replace(/^(?:@\S+\s*)+/, '').trim();
}

function previewText(text: string | undefined, maxLength = 120): string | undefined {
  if (!text) return undefined;
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 3)}...`;
}

function summarizeMessage(msg: DingtalkRobotMessage): DingtalkMessageSummary {
  const richText = msg?.richText?.content ?? msg?.content?.richText;
  let richTextKinds: string[] | undefined;
  if (Array.isArray(richText)) {
    richTextKinds = richText
      .map((part) => part?.msgType ?? part?.type ?? 'unknown')
      .filter((type): type is string => typeof type === 'string');
  }

  return {
    msgId: msg.msgId,
    conversationId: msg.conversationId,
    conversationType: msg.conversationType,
    msgtype: msg.msgtype,
    senderStaffId: msg.senderStaffId,
    senderId: msg.senderId,
    chatbotUserId: msg.chatbotUserId,
    textContent: previewText(msg.text?.content),
    textIsReplyMsg: msg.text?.isReplyMsg,
    repliedSenderId: msg.text?.repliedMsg?.senderId,
    repliedSenderStaffId: msg.text?.repliedMsg?.senderStaffId,
    richTextKinds,
    hasSessionWebhook: Boolean(msg.sessionWebhook),
    sessionWebhookExpiredTime: msg.sessionWebhookExpiredTime ?? null,
  };
}

function sanitizePayloadForLog(value: unknown): JsonLike {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePayloadForLog(item));
  }
  if (typeof value === 'object') {
    const out: Record<string, JsonLike> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'sessionWebhook') {
        out[key] = raw ? '[redacted]' : null;
        continue;
      }
      out[key] = sanitizePayloadForLog(raw);
    }
    return out;
  }
  return String(value);
}

function isGroupConversation(conversationType: DingtalkConversationType): boolean {
  return String(conversationType) === '2';
}

function isPrivateConversation(conversationType: DingtalkConversationType): boolean {
  return String(conversationType) === '1';
}

function isReplyToBot(msg: DingtalkRobotMessage): boolean {
  if (!msg.text?.isReplyMsg) return false;
  const replied = msg.text.repliedMsg;
  if (!replied) return true;
  if (!msg.chatbotUserId) return true;
  return replied.senderStaffId === msg.chatbotUserId || replied.senderId === msg.chatbotUserId;
}

function hasBotMention(msg: DingtalkRobotMessage, extracted: ExtractedText): boolean {
  if (extracted.hasMention) return true;
  if (msg.isInAtList === true) return true;
  if (!Array.isArray(msg.atUsers) || msg.atUsers.length === 0) return false;
  if (!msg.chatbotUserId) return true;
  return msg.atUsers.some((user) =>
    user?.dingtalkId === msg.chatbotUserId ||
    user?.userId === msg.chatbotUserId ||
    user?.staffId === msg.chatbotUserId,
  );
}

function shouldProcessGroupMessage(msg: DingtalkRobotMessage, extracted: ExtractedText): boolean {
  return hasBotMention(msg, extracted) || isReplyToBot(msg);
}

function stripFormatting(text: string, parseMode?: 'HTML' | 'Markdown' | 'plain'): string {
  if (parseMode === 'HTML') {
    return text.replace(/<[^>]+>/g, '');
  }
  if (parseMode === 'Markdown') {
    return text
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/__(.*?)__/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/_(.*?)_/g, '$1')
      .replace(/`{3}[\s\S]*?`{3}/g, (match) => match.replace(/`{3}\w*\n?/g, '').replace(/`{3}/g, ''))
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  }
  return text;
}

function buildTextWebhookPayload(text: string): DingtalkTextWebhookPayload {
  return {
    msgtype: 'text',
    text: { content: text },
  };
}

function deriveMarkdownTitle(text: string): string {
  const firstNonEmptyLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstNonEmptyLine) {
    return 'Claude 回复';
  }

  const simplified = firstNonEmptyLine
    .replace(/^#+\s*/, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim();

  if (!simplified) {
    return 'Claude 回复';
  }

  return simplified.length > 80 ? `${simplified.slice(0, 77)}...` : simplified;
}

function buildWebhookPayload(message: OutboundMessage): DingtalkWebhookPayload {
  if (message.parseMode === 'Markdown') {
    return {
      msgtype: 'markdown',
      markdown: {
        title: deriveMarkdownTitle(message.text),
        text: message.text,
      },
    };
  }

  return buildTextWebhookPayload(stripFormatting(message.text, message.parseMode));
}

export class DingtalkAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'dingtalk';

  private _running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private client: DingtalkClientLike | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private seenMessageIds = new Map<string, number>();
  private readonly createClientImpl: NonNullable<AdapterDeps['createClient']>;
  private readonly postToWebhookImpl: NonNullable<AdapterDeps['postToWebhook']>;

  constructor(deps: AdapterDeps = {}) {
    super();
    this.createClientImpl = deps.createClient ?? createDefaultClient;
    this.postToWebhookImpl = deps.postToWebhook ?? ((sessionWebhook, payload) =>
      fetch(sessionWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }));
  }

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    this.reconnectAttempts = 0;
    try {
      await this.connectClient();
    } catch (err) {
      this._running = false;
      throw err;
    }
    this.healthTimer = setInterval(() => {
      if (!this._running) return;
      if (!this.client?.connected) {
        this.scheduleReconnect('health-check');
      }
    }, HEALTH_CHECK_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    this.client?.disconnect();
    this.client = null;
    this.queue = [];
    this.seenMessageIds.clear();

    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
  }

  isRunning(): boolean {
    return this._running;
  }

  async consumeOne(): Promise<InboundMessage | null> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    if (!this._running) {
      return null;
    }
    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const webhook = getDingtalkWebhook(message.address.chatId);
    if (!webhook) {
      return { ok: false, error: `No DingTalk sessionWebhook cached for chat ${message.address.chatId}` };
    }
    if (isDingtalkWebhookExpired(webhook)) {
      return { ok: false, error: `Cached DingTalk sessionWebhook for chat ${message.address.chatId} is expired` };
    }

    try {
      const payload = buildWebhookPayload(message);
      const response = await this.postToWebhookImpl(webhook.sessionWebhook, payload);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return {
          ok: false,
          error: `DingTalk webhook returned ${response.status}${body ? `: ${body}` : ''}`,
        };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  validateConfig(): string | null {
    const { store } = getBridgeContext();
    const appKey = store.getSetting('bridge_dingtalk_app_key');
    const appSecret = store.getSetting('bridge_dingtalk_app_secret');
    if (!appKey || !appSecret) {
      return 'Missing DingTalk config. Set CTI_DINGTALK_APP_KEY and CTI_DINGTALK_APP_SECRET.';
    }
    return null;
  }

  isAuthorized(_userId: string, _chatId: string): boolean {
    return true;
  }

  async processMessage(msg: DingtalkRobotMessage): Promise<void> {
    if (!msg.msgId || !msg.conversationId) {
      console.warn('[dingtalk-adapter] Ignoring message without msgId/conversationId:', JSON.stringify(summarizeMessage(msg)));
      return;
    }
    if (this.isDuplicate(msg.msgId)) {
      console.log(`[dingtalk-adapter] Ignoring duplicate message ${msg.msgId}`);
      return;
    }

    if (msg.sessionWebhook) {
      upsertDingtalkWebhook({
        chatId: msg.conversationId,
        sessionWebhook: msg.sessionWebhook,
        sessionWebhookExpiredTime: msg.sessionWebhookExpiredTime ?? null,
      });
    }

    const extracted = extractMessageText(msg);
    const isGroup = isGroupConversation(msg.conversationType);
    const isPrivate = isPrivateConversation(msg.conversationType);
    const replyToBot = isReplyToBot(msg);
    console.log(
      '[dingtalk-adapter] Message decision:',
      JSON.stringify({
        ...summarizeMessage(msg),
        isGroup,
        isPrivate,
        extractedText: previewText(extracted.text),
        unsupported: extracted.unsupported,
        hasMention: extracted.hasMention,
        isReplyToBot: replyToBot,
      }),
    );
    if (!isGroup && !isPrivate) {
      console.log(`[dingtalk-adapter] Ignoring message ${msg.msgId}: unsupported conversationType ${String(msg.conversationType)}`);
      return;
    }

    if (isGroup && !shouldProcessGroupMessage(msg, extracted)) {
      console.log(
        `[dingtalk-adapter] Ignoring group message ${msg.msgId}: no @mention and not a reply-to-bot`,
      );
      return;
    }

    const text = isGroup ? stripLeadingMentions(extracted.text) : extracted.text.trim();
    if (!text) {
      if (msg.sessionWebhook && extracted.unsupported.length > 0) {
        console.log(
          `[dingtalk-adapter] Replying with unsupported-message fallback for ${msg.msgId}: ${extracted.unsupported.join(',')}`,
        );
        await this.postToWebhookImpl(msg.sessionWebhook, buildTextWebhookPayload(UNSUPPORTED_MESSAGE_TEXT)).catch(() => {});
      }
      console.log(`[dingtalk-adapter] Ignoring empty text after extraction for ${msg.msgId}`);
      return;
    }

    const inbound: InboundMessage = {
      messageId: msg.msgId,
      address: {
        channelType: 'dingtalk',
        chatId: msg.conversationId,
        userId: msg.senderStaffId || msg.senderId,
        displayName: msg.senderNick,
      },
      text,
      timestamp: msg.createAt || Date.now(),
      raw: msg,
    };
    console.log(
      '[dingtalk-adapter] Enqueue inbound message:',
      JSON.stringify({
        msgId: msg.msgId,
        chatId: inbound.address.chatId,
        userId: inbound.address.userId,
        text: previewText(inbound.text),
        isGroup,
        isPrivate,
      }),
    );
    this.enqueue(inbound);
  }

  private enqueue(message: InboundMessage): void {
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter(message);
      return;
    }
    this.queue.push(message);
  }

  private async connectClient(): Promise<void> {
    const { store } = getBridgeContext();
    const appKey = store.getSetting('bridge_dingtalk_app_key');
    const appSecret = store.getSetting('bridge_dingtalk_app_secret');
    if (!appKey || !appSecret) {
      throw new Error('Missing DingTalk app key/secret');
    }

    this.client?.disconnect();
    this.client = this.createClientImpl({ appKey, appSecret });
    this.client.registerCallbackListener(TOPIC_ROBOT, (downstream) => {
      void this.handleCallback(downstream);
    });
    await this.client.connect();
  }

  private async handleCallback(downstream: DWClientDownStream): Promise<void> {
    try {
      const payload = JSON.parse(downstream.data) as DingtalkRobotMessage;
      console.log('[dingtalk-adapter] Received callback:', JSON.stringify(summarizeMessage(payload)));
      console.log('[dingtalk-adapter] Callback payload:', JSON.stringify(sanitizePayloadForLog(payload)));
      await this.processMessage(payload);
    } catch (err) {
      console.warn('[dingtalk-adapter] Failed to process callback:', err instanceof Error ? err.message : String(err));
    }
  }

  private scheduleReconnect(reason: string): void {
    if (!this._running || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * (2 ** this.reconnectAttempts), RECONNECT_MAX_MS);
    this.reconnectAttempts += 1;
    console.warn(`[dingtalk-adapter] scheduling reconnect (${reason}) in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect(reason);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(reason: string): Promise<void> {
    if (!this._running) return;
    try {
      await this.connectClient();
      this.reconnectAttempts = 0;
      console.log(`[dingtalk-adapter] reconnect succeeded (${reason})`);
    } catch (err) {
      console.warn('[dingtalk-adapter] reconnect failed:', err instanceof Error ? err.message : String(err));
      this.scheduleReconnect(reason);
    }
  }

  private isDuplicate(messageId: string): boolean {
    const now = Date.now();
    for (const [key, ts] of this.seenMessageIds) {
      if (now - ts > DEDUP_TTL_MS) {
        this.seenMessageIds.delete(key);
      }
    }
    if (this.seenMessageIds.has(messageId)) {
      return true;
    }
    this.seenMessageIds.set(messageId, now);
    return false;
  }
}

registerAdapterFactory('dingtalk', () => new DingtalkAdapter());
