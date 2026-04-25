import fs from 'node:fs';
import path from 'node:path';
import { CTI_HOME } from './config.js';

export interface DingtalkWebhookRecord {
  chatId: string;
  sessionWebhook: string | null;
  sessionWebhookExpiredTime: number | null;
  conversationTitle?: string;
  conversationType?: string;
  senderNick?: string;
  updatedAt: string;
}

const DATA_DIR = path.join(CTI_HOME, 'data');
const WEBHOOKS_PATH = path.join(DATA_DIR, 'dingtalk-webhooks.json');

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, data, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readRecords(): Record<string, DingtalkWebhookRecord> {
  ensureDir(DATA_DIR);
  return readJson<Record<string, DingtalkWebhookRecord>>(WEBHOOKS_PATH, {});
}

function writeRecords(records: Record<string, DingtalkWebhookRecord>): void {
  ensureDir(DATA_DIR);
  atomicWrite(WEBHOOKS_PATH, JSON.stringify(records, null, 2));
}

function now(): string {
  return new Date().toISOString();
}

export function getDingtalkWebhook(chatId: string): DingtalkWebhookRecord | undefined {
  const records = readRecords();
  return records[chatId];
}

export function upsertDingtalkWebhook(params: {
  chatId: string;
  sessionWebhook?: string | null;
  sessionWebhookExpiredTime?: number | null;
  conversationTitle?: string;
  conversationType?: string;
  senderNick?: string;
}): DingtalkWebhookRecord {
  const records = readRecords();
  const existing = records[params.chatId];
  const next: DingtalkWebhookRecord = {
    chatId: params.chatId,
    sessionWebhook: params.sessionWebhook ?? existing?.sessionWebhook ?? null,
    sessionWebhookExpiredTime: params.sessionWebhookExpiredTime ?? existing?.sessionWebhookExpiredTime ?? null,
    conversationTitle: params.conversationTitle ?? existing?.conversationTitle,
    conversationType: params.conversationType ?? existing?.conversationType,
    senderNick: params.senderNick ?? existing?.senderNick,
    updatedAt: now(),
  };
  records[params.chatId] = next;
  writeRecords(records);
  return next;
}

export function isDingtalkWebhookExpired(record: DingtalkWebhookRecord, atMs = Date.now()): boolean {
  if (!record.sessionWebhookExpiredTime || record.sessionWebhookExpiredTime <= 0) return false;
  return atMs >= record.sessionWebhookExpiredTime;
}

export function getDingtalkWebhooksFilePath(): string {
  return WEBHOOKS_PATH;
}
