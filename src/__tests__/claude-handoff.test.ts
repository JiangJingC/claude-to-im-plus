import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = process.cwd();
const HANDOFF_SCRIPT = path.join(REPO_ROOT, 'scripts', 'claude-handoff.mjs');

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

describe('claude-handoff helper', () => {
  let tmpRoot: string;
  let ctiHome: string;
  let claudeHome: string;

  function run(args: string[], extraEnv: Record<string, string> = {}) {
    return spawnSync('node', [HANDOFF_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CTI_HOME: ctiHome,
        CLAUDE_HOME: claudeHome,
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
        CLAUDE_HOME: claudeHome,
        ...extraEnv,
      },
    });
  }

  function seedProjects(projects: Array<{ id: string; name: string; cwd: string }>): void {
    writeJson(path.join(ctiHome, 'projects.json'), { projects });
  }

  /**
   * Seeds Claude session data using the real ~/.claude/ on-disk format.
   *
   * For each session we write:
   *  - A session-meta JSON at usage-data/session-meta/<uuid>.json
   *  - A JSONL conversation file at projects/<encoded-cwd>/<uuid>.jsonl
   *    with a user message record that contains the cwd and timestamp.
   */
  function seedClaudeSession(options: {
    sessionId: string;
    cwd: string;
    updatedAt: string;
    startTime: string;
    firstPrompt?: string;
  }): void {
    // session-meta
    const metaPath = path.join(claudeHome, 'usage-data', 'session-meta', `${options.sessionId}.json`);
    writeJson(metaPath, {
      session_id: options.sessionId,
      project_path: options.cwd,
      start_time: options.startTime,
      first_prompt: options.firstPrompt || '',
    });

    // project JSONL — encode cwd by replacing / with -
    const encodedCwd = options.cwd.replace(/\//g, '-').replace(/^-/, '');
    const projectDir = path.join(claudeHome, 'projects', encodedCwd);
    const jsonlPath = path.join(projectDir, `${options.sessionId}.jsonl`);
    writeJsonl(jsonlPath, [
      {
        type: 'user',
        message: { role: 'user', content: options.firstPrompt || 'hello' },
        uuid: 'msg-1',
        timestamp: options.updatedAt,
        sessionId: options.sessionId,
        cwd: options.cwd,
        permissionMode: 'default',
        userType: 'external',
        entrypoint: 'cli',
      },
    ]);
  }

  function seedBindingData(bindings: Record<string, unknown>, sessions: Record<string, unknown> = {}): void {
    writeJson(path.join(ctiHome, 'data', 'bindings.json'), bindings);
    writeJson(path.join(ctiHome, 'data', 'sessions.json'), sessions);
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-claude-handoff-test-'));
    ctiHome = path.join(tmpRoot, 'cti-home');
    claudeHome = path.join(tmpRoot, 'claude-home');
    fs.mkdirSync(ctiHome, { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true });
  });

  // -----------------------------------------------------------------------
  // projects
  // -----------------------------------------------------------------------

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

  it('lists configured projects as JSON', () => {
    seedProjects([
      { id: 'skill', name: 'Skill Project', cwd: '/tmp/workspace/project-a' },
    ]);

    const result = run(['projects', '--json']);
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.projects.length, 1);
    assert.equal(payload.projects[0].id, 'skill');
    assert.equal(payload.projects[0].cwd, '/tmp/workspace/project-a');
  });

  it('current: returns the current Claude session as JSON', () => {
    const result = run(['current', '--json'], {
      CLAUDE_SESSION_ID: 'session-from-env',
    });
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.sessionId, 'session-from-env');
    assert.equal(payload.source, 'env');
  });

  it('runs main when executed through a symlink path', () => {
    const linkedScript = path.join(tmpRoot, 'claude-handoff-link.mjs');
    fs.symlinkSync(HANDOFF_SCRIPT, linkedScript);

    const result = runScriptPath(linkedScript, ['help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /claude-handoff\.mjs bind/);
  });

  // -----------------------------------------------------------------------
  // sessions
  // -----------------------------------------------------------------------

  it('sessions: requires project-id argument', () => {
    seedProjects([{ id: 'skill', name: 'Skill', cwd: '/tmp/workspace/project-a' }]);
    const result = run(['sessions']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /sessions requires <project-id>/);
  });

  it('sessions: rejects unknown project id', () => {
    seedProjects([{ id: 'skill', name: 'Skill', cwd: '/tmp/workspace/project-a' }]);
    const result = run(['sessions', 'unknown-id', '--json']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown project id "unknown-id"/);
  });

  it('sessions: returns empty list when no Claude sessions exist', () => {
    seedProjects([{ id: 'skill', name: 'Skill', cwd: '/tmp/workspace/project-a' }]);
    const result = run(['sessions', 'skill', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.sessions.length, 0);
  });

  it('sessions: lists sessions whose cwd matches project cwd (normalized)', () => {
    seedProjects([
      { id: 'skill', name: 'Project A', cwd: '/tmp/workspace/project-a' },
      { id: 'other', name: 'Project B', cwd: '/tmp/workspace/project-b' },
    ]);

    // session-1: exact cwd match
    seedClaudeSession({
      sessionId: 'session-1',
      cwd: '/tmp/workspace/project-a',
      updatedAt: '2026-04-01T12:00:00.000Z',
      startTime: '2026-04-01T11:00:00.000Z',
      firstPrompt: 'Fix the bug',
    });

    // session-2: trailing slash (should normalize to same)
    seedClaudeSession({
      sessionId: 'session-2',
      cwd: '/tmp/workspace/project-a/',
      updatedAt: '2026-04-01T11:00:00.000Z',
      startTime: '2026-04-01T10:00:00.000Z',
      firstPrompt: 'Add a feature',
    });

    // session-3: subdirectory (should NOT match)
    seedClaudeSession({
      sessionId: 'session-3',
      cwd: '/tmp/workspace/project-a/subdir',
      updatedAt: '2026-04-01T13:00:00.000Z',
      startTime: '2026-04-01T09:00:00.000Z',
      firstPrompt: 'Subdir work',
    });

    // session-4: different project (should NOT match)
    seedClaudeSession({
      sessionId: 'session-4',
      cwd: '/tmp/workspace/project-b',
      updatedAt: '2026-04-01T14:00:00.000Z',
      startTime: '2026-04-01T08:00:00.000Z',
      firstPrompt: 'Other project',
    });

    const result = run(['sessions', 'skill', '10', '--json']);
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.project.id, 'skill');
    assert.equal(payload.sessions.length, 2);

    const ids = payload.sessions.map((s: { sessionId: string }) => s.sessionId);
    assert.ok(ids.includes('session-1'));
    assert.ok(ids.includes('session-2'));
    assert.ok(!ids.includes('session-3'), 'subdir should not match');
    assert.ok(!ids.includes('session-4'), 'other project should not match');

    // session-1 should be first (later updatedAt)
    assert.equal(payload.sessions[0].sessionId, 'session-1');
  });

  it('sessions: respects the limit argument', () => {
    seedProjects([{ id: 'skill', name: 'Skill', cwd: '/tmp/workspace/project-a' }]);
    for (let i = 0; i < 5; i++) {
      seedClaudeSession({
        sessionId: `sess-${i}`,
        cwd: '/tmp/workspace/project-a',
        updatedAt: `2026-04-01T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
        startTime: `2026-04-01T${String(9 + i).padStart(2, '0')}:00:00.000Z`,
        firstPrompt: `prompt ${i}`,
      });
    }

    const result = run(['sessions', 'skill', '3', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.sessions.length, 3);
  });

  // -----------------------------------------------------------------------
  // bind
  // -----------------------------------------------------------------------

  it('bind: requires a binding prefix when multiple weixin bindings exist', () => {
    seedBindingData({
      'weixin:chat-a': {
        id: 'binding-aaa111',
        channelType: 'weixin',
        chatId: 'chat-a',
        codepilotSessionId: 'old-a',
        sdkSessionId: 'old-session-a',
        workingDirectory: '/tmp/workspace/project-a',
        model: '',
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
        sdkSessionId: 'old-session-b',
        workingDirectory: '/tmp/workspace/project-b',
        model: '',
        mode: 'code',
        active: true,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
    });

    const result = run(['bind', '--channel', 'weixin', '--session-id', 'session-1']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Multiple weixin bindings found/);
    assert.match(result.stderr, /binding-aaa111/);
    assert.match(result.stderr, /binding-bbb222/);
  });

  it('bind: creates a new bridge session and updates the selected binding', () => {
    seedClaudeSession({
      sessionId: 'session-abc',
      cwd: '/tmp/workspace/project-a',
      updatedAt: '2026-04-01T12:00:00.000Z',
      startTime: '2026-04-01T11:00:00.000Z',
      firstPrompt: 'Handoff test',
    });

    seedBindingData(
      {
        'weixin:chat-a': {
          id: 'binding-aaa111',
          channelType: 'weixin',
          chatId: 'chat-a',
          codepilotSessionId: 'old-session-id',
          sdkSessionId: 'old-claude-session',
          workingDirectory: '/tmp/workspace/project-z',
          model: 'claude-5',
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
          sdkSessionId: 'feishu-claude',
          workingDirectory: '/tmp/workspace/project-b',
          model: '',
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
          model: 'claude-5',
          sdk_session_id: 'old-claude-session',
        },
      },
    );

    const result = run(['bind', '--channel', 'weixin', '--session-id', 'session-abc', '--json']);
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.bindingId, 'binding-aaa111');
    assert.equal(payload.sdkSessionId, 'session-abc');
    assert.equal(payload.workingDirectory, '/tmp/workspace/project-a');
    assert.equal(payload.model, '');  // cleared by default
    assert.notEqual(payload.newCodepilotSessionId, 'old-session-id');

    const bindings = JSON.parse(
      fs.readFileSync(path.join(ctiHome, 'data', 'bindings.json'), 'utf8'),
    );
    const sessions = JSON.parse(
      fs.readFileSync(path.join(ctiHome, 'data', 'sessions.json'), 'utf8'),
    );

    // Weixin binding updated
    assert.equal(bindings['weixin:chat-a'].sdkSessionId, 'session-abc');
    assert.equal(bindings['weixin:chat-a'].workingDirectory, '/tmp/workspace/project-a');
    assert.equal(bindings['weixin:chat-a'].model, '');

    // Feishu binding NOT touched
    assert.equal(bindings['feishu:chat-b'].sdkSessionId, 'feishu-claude');

    // Old bridge session preserved
    assert.ok(sessions['old-session-id'], 'old bridge session must not be deleted');

    // New bridge session added
    assert.ok(sessions[payload.newCodepilotSessionId]);
    assert.equal(sessions[payload.newCodepilotSessionId].sdk_session_id, 'session-abc');
    assert.equal(sessions[payload.newCodepilotSessionId].working_directory, '/tmp/workspace/project-a');
    assert.equal(sessions[payload.newCodepilotSessionId].model, '');
  });

  it('bind: falls back to process.cwd when session has no cwd metadata', () => {
    seedBindingData({
      'weixin:chat-a': {
        id: 'binding-aaa111',
        channelType: 'weixin',
        chatId: 'chat-a',
        codepilotSessionId: 'old-session-id',
        sdkSessionId: 'old-session',
        workingDirectory: '/tmp/workspace',
        model: '',
        mode: 'code',
        active: true,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
    });

    // session with NO project JSONL — only meta (no cwd in projects dir)
    const metaPath = path.join(claudeHome, 'usage-data', 'session-meta', 'bare-session.json');
    writeJson(metaPath, {
      session_id: 'bare-session',
      project_path: '',
      start_time: '2026-04-01T10:00:00.000Z',
      first_prompt: '',
    });

    const result = run(['bind', '--channel', 'weixin', '--session-id', 'bare-session', '--json']);
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.sdkSessionId, 'bare-session');
    // Should fall back to REPO_ROOT (process.cwd of the spawnSync call)
    assert.equal(payload.workingDirectory, REPO_ROOT);
  });

  it('bind: CLAUDE_SESSION_ID env var is used for auto-detect', () => {
    seedBindingData({
      'weixin:chat-a': {
        id: 'binding-aaa111',
        channelType: 'weixin',
        chatId: 'chat-a',
        codepilotSessionId: 'old-session-id',
        sdkSessionId: 'old-session',
        workingDirectory: '/tmp/workspace',
        model: '',
        mode: 'code',
        active: true,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
    });

    const result = run(['bind', '--channel', 'weixin', '--json'], {
      CLAUDE_SESSION_ID: 'session-from-env',
    });
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.sdkSessionId, 'session-from-env');
  });

  it('bind: rejects unknown explicit session ids', () => {
    seedBindingData({
      'weixin:chat-a': {
        id: 'binding-aaa111',
        channelType: 'weixin',
        chatId: 'chat-a',
        codepilotSessionId: 'old-session-id',
        sdkSessionId: 'old-session',
        workingDirectory: '/tmp/workspace',
        model: '',
        mode: 'code',
        active: true,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
    });

    const result = run(['bind', '--channel', 'weixin', '--session-id', 'does-not-exist']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown Claude session ID "does-not-exist"/);
  });

  it('bind: errors when no session id and no auto-detect possible', () => {
    seedBindingData({
      'weixin:chat-a': {
        id: 'binding-aaa111',
        channelType: 'weixin',
        chatId: 'chat-a',
        codepilotSessionId: 'old-session-id',
        sdkSessionId: 'old-session',
        workingDirectory: '/tmp/workspace',
        model: '',
        mode: 'code',
        active: true,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
    });

    // No CLAUDE_SESSION_ID, no CMUX_CLAUDE_PID, sessions dir is empty
    const result = run(['bind', '--channel', 'weixin', '--json'], {
      CLAUDE_SESSION_ID: '',
      CMUX_CLAUDE_PID: '',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot detect the current Claude Code session/);
  });

  it('current: errors when no Claude session can be detected', () => {
    const result = run(['current', '--json'], {
      CLAUDE_SESSION_ID: '',
      CMUX_CLAUDE_PID: '',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot detect the current Claude Code session/);
  });

  it('bind: auto-detects session from CMUX_CLAUDE_PID sessions file', () => {
    // Write a fake sessions/<PID>.json
    const fakePid = '99999';
    const sessionFilePath = path.join(claudeHome, 'sessions', `${fakePid}.json`);
    writeJson(sessionFilePath, {
      pid: Number(fakePid),
      sessionId: 'cmux-detected-session',
      cwd: '/tmp/workspace/project-a',
      startedAt: Date.now(),
      kind: 'interactive',
      entrypoint: 'cli',
    });

    seedBindingData({
      'weixin:chat-a': {
        id: 'binding-aaa111',
        channelType: 'weixin',
        chatId: 'chat-a',
        codepilotSessionId: 'old-session-id',
        sdkSessionId: 'old-session',
        workingDirectory: '/tmp/workspace',
        model: '',
        mode: 'code',
        active: true,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
    });

    const result = run(['bind', '--channel', 'weixin', '--json'], {
      CMUX_CLAUDE_PID: fakePid,
      CLAUDE_SESSION_ID: '',
    });
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.sdkSessionId, 'cmux-detected-session');
  });

  it('bind: errors if multiple bindings and no prefix provided', () => {
    seedBindingData({
      'weixin:chat-a': { id: 'binding-aaa111', channelType: 'weixin', chatId: 'chat-a', codepilotSessionId: '', sdkSessionId: '', workingDirectory: '', model: '', mode: 'code', active: true, createdAt: '', updatedAt: '' },
      'weixin:chat-b': { id: 'binding-bbb222', channelType: 'weixin', chatId: 'chat-b', codepilotSessionId: '', sdkSessionId: '', workingDirectory: '', model: '', mode: 'code', active: true, createdAt: '', updatedAt: '' },
    });

    const result = run(['bind', '--channel', 'weixin', '--session-id', 'any-session-id']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Multiple weixin bindings found/);
  });

  it('bind: selects correct binding when prefix is provided', () => {
    seedClaudeSession({
      sessionId: 'session-xyz',
      cwd: REPO_ROOT,
      updatedAt: '2026-04-01T12:00:00.000Z',
      startTime: '2026-04-01T11:00:00.000Z',
      firstPrompt: 'test',
    });

    seedBindingData({
      'weixin:chat-a': {
        id: 'binding-aaa111',
        channelType: 'weixin',
        chatId: 'chat-a',
        codepilotSessionId: 'old-a',
        sdkSessionId: 'old-session-a',
        workingDirectory: '',
        model: '',
        mode: 'code',
        active: true,
        createdAt: '',
        updatedAt: '',
      },
      'weixin:chat-b': {
        id: 'binding-bbb222',
        channelType: 'weixin',
        chatId: 'chat-b',
        codepilotSessionId: 'old-b',
        sdkSessionId: 'old-session-b',
        workingDirectory: '',
        model: '',
        mode: 'code',
        active: true,
        createdAt: '',
        updatedAt: '',
      },
    });

    const result = run([
      'bind', '--channel', 'weixin',
      '--session-id', 'session-xyz',
      '--binding', 'binding-bbb',
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.bindingId, 'binding-bbb222');
  });
});
