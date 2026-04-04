import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = process.cwd();
const HANDOFF_SCRIPT = path.join(REPO_ROOT, 'scripts', 'codex-handoff.mjs');

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function writeJsonl(filePath: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8',
  );
}

describe('codex-handoff helper', () => {
  let tmpRoot: string;
  let ctiHome: string;
  let codexHome: string;

  function run(args: string[], extraEnv: Record<string, string> = {}) {
    return spawnSync('node', [HANDOFF_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CTI_HOME: ctiHome,
        CODEX_HOME: codexHome,
        ...extraEnv,
      },
    });
  }

  function runScriptPath(scriptPath: string, args: string[], extraEnv: Record<string, string> = {}) {
    return spawnSync('node', [scriptPath, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CTI_HOME: ctiHome,
        CODEX_HOME: codexHome,
        ...extraEnv,
      },
    });
  }

  function seedProjects(projects: Array<{ id: string; name: string; cwd: string }>): void {
    writeJson(path.join(ctiHome, 'projects.json'), { projects });
  }

  function seedThreadData(): void {
    writeJsonl(path.join(codexHome, 'session_index.jsonl'), [
      { id: 'thread-1', thread_name: 'Older name', updated_at: '2026-04-01T10:00:00.000Z' },
      { id: 'thread-1', thread_name: 'Newest name', updated_at: '2026-04-01T12:00:00.000Z' },
      { id: 'thread-2', thread_name: 'Second thread', updated_at: '2026-04-01T11:00:00.000Z' },
      { id: 'thread-3', thread_name: 'Subdir thread', updated_at: '2026-04-01T13:00:00.000Z' },
    ]);

    writeJsonl(path.join(codexHome, 'sessions', '2026', '04', '01', 'thread-1.jsonl'), [
      {
        timestamp: '2026-04-01T09:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'thread-1',
          cwd: '/tmp/workspace/project-a/',
        },
      },
      { type: 'message', payload: {} },
    ]);

    writeJsonl(path.join(codexHome, 'sessions', '2026', '04', '01', 'thread-2.jsonl'), [
      {
        timestamp: '2026-04-01T10:30:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'thread-2',
          cwd: '/tmp/workspace/project-a',
        },
      },
    ]);

    writeJsonl(path.join(codexHome, 'sessions', '2026', '04', '01', 'thread-3.jsonl'), [
      {
        timestamp: '2026-04-01T10:45:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'thread-3',
          cwd: '/tmp/workspace/project-a/subdir',
        },
      },
    ]);
  }

  function seedBindingData(bindings: Record<string, unknown>, sessions: Record<string, unknown> = {}): void {
    writeJson(path.join(ctiHome, 'data', 'bindings.json'), bindings);
    writeJson(path.join(ctiHome, 'data', 'sessions.json'), sessions);
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-handoff-test-'));
    ctiHome = path.join(tmpRoot, 'cti-home');
    codexHome = path.join(tmpRoot, 'codex-home');
    fs.mkdirSync(ctiHome, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
  });

  it('shows a template when projects.json is missing', () => {
    const result = run(['projects']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No projects config found/);
    assert.match(result.stderr, /"projects"/);
  });

  it('validates duplicate project ids and absolute cwd values', () => {
    seedProjects([
      { id: 'skill', name: 'Skill', cwd: '/tmp/workspace/project-a' },
      { id: 'skill', name: 'Duplicate', cwd: '/tmp/workspace/project-b' },
    ]);

    const duplicate = run(['projects']);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /Duplicate project id "skill"/);

    seedProjects([{ id: 'relative', name: 'Relative', cwd: 'project-a' }]);
    const relative = run(['projects']);
    assert.equal(relative.status, 1);
    assert.match(relative.stderr, /must be an absolute path/);
  });

  it('lists threads for a project using normalized cwd equality and latest updated_at', () => {
    seedProjects([
      { id: 'skill', name: 'Project A', cwd: '/tmp/workspace/project-a' },
      { id: 'other', name: 'Project B', cwd: '/tmp/workspace/project-b' },
    ]);
    seedThreadData();

    const result = run(['threads', 'skill', '5', '--json']);
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.project.id, 'skill');
    assert.equal(payload.threads.length, 2);
    assert.deepEqual(
      payload.threads.map((thread: { id: string }) => thread.id),
      ['thread-1', 'thread-2'],
    );
    assert.equal(payload.threads[0].threadName, 'Newest name');
    assert.equal(payload.threads[0].cwd, '/tmp/workspace/project-a');
  });

  it('runs main when executed through a symlink path', () => {
    const linkedScript = path.join(tmpRoot, 'codex-handoff-link.mjs');
    fs.symlinkSync(HANDOFF_SCRIPT, linkedScript);

    const result = runScriptPath(linkedScript, ['help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /codex-handoff\.mjs bind/);
  });

  it('requires a binding prefix when multiple weixin bindings exist', () => {
    seedBindingData({
      'weixin:chat-a': {
        id: 'binding-aaa111',
        channelType: 'weixin',
        chatId: 'chat-a',
        codepilotSessionId: 'old-a',
        sdkSessionId: 'old-thread-a',
        workingDirectory: '/tmp/workspace/project-a',
        model: 'gpt-5.4',
        mode: 'code',
        active: true,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
      'weixin:chat-b': {
        id: 'binding-bbb222',
        channelType: 'weixin',
        chatId: 'chat-b',
        codepilotSessionId: 'old-b',
        sdkSessionId: 'old-thread-b',
        workingDirectory: '/tmp/workspace/project-b',
        model: 'gpt-5.4',
        mode: 'code',
        active: true,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
    });

    const result = run(['bind', '--channel', 'weixin', '--thread-id', 'thread-1']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Multiple weixin bindings found/);
    assert.match(result.stderr, /binding-aaa111/);
    assert.match(result.stderr, /binding-bbb222/);
  });

  it('creates a new bridge session, clears model, and updates the selected binding', () => {
    seedThreadData();
    seedBindingData(
      {
        'weixin:chat-a': {
          id: 'binding-aaa111',
          channelType: 'weixin',
          chatId: 'chat-a',
          codepilotSessionId: 'old-session-id',
          sdkSessionId: 'old-thread-id',
          workingDirectory: '/tmp/workspace/project-z',
          model: 'gpt-5.4',
          mode: 'code',
          active: true,
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-01T00:00:00.000Z',
        },
        'feishu:chat-b': {
          id: 'binding-feishu',
          channelType: 'feishu',
          chatId: 'chat-b',
          codepilotSessionId: 'feishu-session',
          sdkSessionId: 'feishu-thread',
          workingDirectory: '/tmp/workspace/project-b',
          model: 'gpt-5.4',
          mode: 'code',
          active: true,
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-01T00:00:00.000Z',
        },
      },
      {
        'old-session-id': {
          id: 'old-session-id',
          working_directory: '/tmp/workspace/project-z',
          model: 'gpt-5.4',
          sdk_session_id: 'old-thread-id',
        },
      },
    );

    const result = run(['bind', '--channel', 'weixin', '--thread-id', 'thread-1', '--json']);
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.bindingId, 'binding-aaa111');
    assert.equal(payload.sdkSessionId, 'thread-1');
    assert.equal(payload.workingDirectory, '/tmp/workspace/project-a');
    assert.equal(payload.model, '');
    assert.notEqual(payload.newCodepilotSessionId, 'old-session-id');

    const bindings = JSON.parse(
      fs.readFileSync(path.join(ctiHome, 'data', 'bindings.json'), 'utf8'),
    );
    const sessions = JSON.parse(
      fs.readFileSync(path.join(ctiHome, 'data', 'sessions.json'), 'utf8'),
    );

    assert.equal(bindings['weixin:chat-a'].sdkSessionId, 'thread-1');
    assert.equal(bindings['weixin:chat-a'].workingDirectory, '/tmp/workspace/project-a');
    assert.equal(bindings['weixin:chat-a'].model, '');
    assert.ok(sessions[payload.newCodepilotSessionId]);
    assert.equal(sessions[payload.newCodepilotSessionId].sdk_session_id, 'thread-1');
    assert.equal(sessions[payload.newCodepilotSessionId].working_directory, '/tmp/workspace/project-a');
    assert.equal(sessions[payload.newCodepilotSessionId].model, '');
  });

  it('updates a dingtalk binding when bind --channel dingtalk is used', () => {
    seedThreadData();
    seedBindingData({
      'dingtalk:chat-a': {
        id: 'binding-ddd111',
        channelType: 'dingtalk',
        chatId: 'cid-123',
        codepilotSessionId: 'old-session-id',
        sdkSessionId: 'old-thread-id',
        workingDirectory: '/tmp/workspace/project-z',
        model: 'gpt-5.4',
        mode: 'code',
        active: true,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
    });

    const result = run(['bind', '--channel', 'dingtalk', '--thread-id', 'thread-1', '--json']);
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.bindingId, 'binding-ddd111');
    assert.equal(payload.channelType, 'dingtalk');

    const bindings = JSON.parse(
      fs.readFileSync(path.join(ctiHome, 'data', 'bindings.json'), 'utf8'),
    );
    assert.equal(bindings['dingtalk:chat-a'].sdkSessionId, 'thread-1');
    assert.equal(bindings['dingtalk:chat-a'].workingDirectory, '/tmp/workspace/project-a');
  });

  it('falls back to CODEX_THREAD_ID when thread-id is omitted', () => {
    seedBindingData({
      'weixin:chat-a': {
        id: 'binding-aaa111',
        channelType: 'weixin',
        chatId: 'chat-a',
        codepilotSessionId: 'old-session-id',
        sdkSessionId: 'old-thread-id',
        workingDirectory: '/tmp/workspace/project-z',
        model: 'gpt-5.4',
        mode: 'code',
        active: true,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
    });

    const result = run(['bind', '--channel', 'weixin', '--json'], {
      CODEX_THREAD_ID: 'thread-from-env',
    });
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.sdkSessionId, 'thread-from-env');
    assert.equal(payload.workingDirectory, REPO_ROOT);
  });
});
