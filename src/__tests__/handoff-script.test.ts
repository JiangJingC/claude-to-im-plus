import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = process.cwd();
const HANDOFF_SH = path.join(REPO_ROOT, 'scripts', 'handoff.sh');

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

describe('handoff.sh', () => {
  let tmpRoot: string;
  let ctiHome: string;
  let codexHome: string;
  let claudeHome: string;
  let stateFile: string;
  let logFile: string;
  let fakeDaemon: string;
  let configFile: string;

  function run(args: string[], extraEnv: Record<string, string> = {}) {
    return spawnSync('bash', [HANDOFF_SH, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CTI_HOME: ctiHome,
        CODEX_HOME: codexHome,
        CLAUDE_HOME: claudeHome,
        CTI_DAEMON_SH: fakeDaemon,
        CTI_TEST_STATE_FILE: stateFile,
        CTI_TEST_LOG_FILE: logFile,
        ...extraEnv,
      },
    });
  }

  function writeConfig(contents: string): void {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, contents, 'utf8');
  }

  function readConfig(): string {
    return fs.readFileSync(configFile, 'utf8');
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-handoff-wrapper-'));
    ctiHome = path.join(tmpRoot, 'cti-home');
    codexHome = path.join(tmpRoot, 'codex-home');
    claudeHome = path.join(tmpRoot, 'claude-home');
    stateFile = path.join(tmpRoot, 'daemon.state');
    logFile = path.join(tmpRoot, 'daemon.log');
    fakeDaemon = path.join(tmpRoot, 'fake-daemon.sh');
    configFile = path.join(ctiHome, 'config.env');

    writeConfig(
      [
        'CTI_RUNTIME=codex',
        'CTI_ENABLED_CHANNELS=weixin',
        'CTI_DEFAULT_WORKDIR=/tmp/workspace/project-z',
        '',
      ].join('\n'),
    );

    writeJson(path.join(ctiHome, 'data', 'bindings.json'), {
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
    writeJson(path.join(ctiHome, 'data', 'sessions.json'), {
      'old-session-id': {
        id: 'old-session-id',
        working_directory: '/tmp/workspace/project-z',
        model: 'gpt-5.4',
        sdk_session_id: 'old-thread-id',
      },
    });
    writeJsonl(path.join(codexHome, 'sessions', '2026', '04', '01', 'thread-1.jsonl'), [
      {
        timestamp: '2026-04-01T09:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'thread-1',
          cwd: '/tmp/workspace/project-a',
        },
      },
    ]);

    fs.writeFileSync(
      fakeDaemon,
      `#!/usr/bin/env bash
set -euo pipefail
echo "$1" >> "$CTI_TEST_LOG_FILE"
case "$1" in
  status)
    if [ -f "$CTI_TEST_STATE_FILE" ]; then
      echo "Bridge process is running"
      echo '{"running":true}'
    else
      echo "Bridge is not running"
    fi
    ;;
  stop)
    rm -f "$CTI_TEST_STATE_FILE"
    echo "Bridge stopped"
    ;;
  start)
    if [ "\${CTI_TEST_FAIL_START:-0}" = "1" ]; then
      echo "Bridge failed to start" >&2
      exit 1
    fi
    touch "$CTI_TEST_STATE_FILE"
    echo "Bridge started"
    ;;
  *)
    echo "unsupported" >&2
    exit 1
    ;;
esac
`,
      { mode: 0o755 },
    );
  });

  // -------------------------------------------------------------------------
  // Codex / weixin handoff (existing tests — must continue to pass)
  // -------------------------------------------------------------------------

  it('restarts the bridge around a successful weixin handoff', () => {
    fs.writeFileSync(stateFile, 'running', 'utf8');

    const result = run(['weixin', 'thread-1']);
    assert.equal(result.status, 0, result.stderr);

    const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['status', 'stop', 'start', 'status']);
    assert.match(result.stderr, /Pending permission requests will be lost/);

    const bindings = JSON.parse(
      fs.readFileSync(path.join(ctiHome, 'data', 'bindings.json'), 'utf8'),
    );
    assert.equal(bindings['weixin:chat-a'].sdkSessionId, 'thread-1');
    assert.match(readConfig(), /^CTI_RUNTIME=codex$/m);
    assert.match(result.stderr, /Global runtime already set to: codex/);
  });

  it('does not auto-start the bridge if it was not already running', () => {
    const result = run(['weixin', 'thread-1']);
    assert.equal(result.status, 0, result.stderr);

    const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['status', 'status']);
    assert.match(readConfig(), /^CTI_RUNTIME=codex$/m);
  });

  // -------------------------------------------------------------------------
  // Claude handoff — projects / sessions list (no daemon interaction)
  // -------------------------------------------------------------------------

  it('claude projects: delegates to claude-handoff.mjs projects', () => {
    writeJson(path.join(ctiHome, 'projects.json'), {
      projects: [
        { id: 'myproj', name: 'My Project', cwd: '/tmp/workspace/project-a' },
      ],
    });

    const result = run(['claude', 'projects']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /myproj/);
    assert.match(result.stdout, /My Project/);
  });

  it('claude sessions: delegates to claude-handoff.mjs sessions', () => {
    writeJson(path.join(ctiHome, 'projects.json'), {
      projects: [
        { id: 'myproj', name: 'My Project', cwd: '/tmp/workspace/project-a' },
      ],
    });

    // Seed a Claude session file
    const encodedCwd = 'tmp-workspace-project-a';
    writeJsonl(path.join(claudeHome, 'projects', encodedCwd, 'sess-001.jsonl'), [
      {
        type: 'user',
        message: { role: 'user', content: 'Hello Claude' },
        uuid: 'msg-1',
        timestamp: '2026-04-01T12:00:00.000Z',
        sessionId: 'sess-001',
        cwd: '/tmp/workspace/project-a',
        permissionMode: 'default',
        userType: 'external',
        entrypoint: 'cli',
      },
    ]);

    const result = run(['claude', 'sessions', 'myproj']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sess-001/);
  });

  it('claude sessions: shows error when project-id is missing', () => {
    const result = run(['claude', 'sessions']);
    assert.equal(result.status, 1);
    // error comes from the shell or the helper
    assert.match(result.stderr, /project-id|project_id|sessions/i);
  });

  // -------------------------------------------------------------------------
  // Claude handoff — bind with explicit session-id (daemon restart lifecycle)
  // -------------------------------------------------------------------------

  it('claude <session-id>: restarts bridge around successful handoff', () => {
    fs.writeFileSync(stateFile, 'running', 'utf8');

    // Seed a Claude session so cwd can be resolved
    const encodedCwd = 'tmp-workspace-project-a';
    writeJsonl(path.join(claudeHome, 'projects', encodedCwd, 'claude-sess-1.jsonl'), [
      {
        type: 'user',
        message: { role: 'user', content: 'test' },
        uuid: 'u1',
        timestamp: '2026-04-01T12:00:00.000Z',
        sessionId: 'claude-sess-1',
        cwd: '/tmp/workspace/project-a',
        permissionMode: 'default',
        userType: 'external',
        entrypoint: 'cli',
      },
    ]);

    const result = run(['claude', 'claude-sess-1']);
    assert.equal(result.status, 0, result.stderr);

    const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['status', 'stop', 'start', 'status']);
    assert.match(result.stderr, /Pending permission requests will be lost/);

    const bindings = JSON.parse(
      fs.readFileSync(path.join(ctiHome, 'data', 'bindings.json'), 'utf8'),
    );
    assert.equal(bindings['weixin:chat-a'].sdkSessionId, 'claude-sess-1');
    assert.match(readConfig(), /^CTI_RUNTIME=claude$/m);
    assert.match(result.stderr, /Global runtime switched: codex -> claude/);
  });

  it('claude <session-id>: does not restart bridge when not running', () => {
    const encodedCwd = 'tmp-workspace-project-a';
    writeJsonl(path.join(claudeHome, 'projects', encodedCwd, 'claude-sess-2.jsonl'), [
      {
        type: 'user',
        message: { role: 'user', content: 'test' },
        uuid: 'u1',
        timestamp: '2026-04-01T12:00:00.000Z',
        sessionId: 'claude-sess-2',
        cwd: '/tmp/workspace/project-a',
        permissionMode: 'default',
        userType: 'external',
        entrypoint: 'cli',
      },
    ]);

    const result = run(['claude', 'claude-sess-2']);
    assert.equal(result.status, 0, result.stderr);

    const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['status', 'status']);
    assert.match(readConfig(), /^CTI_RUNTIME=claude$/m);
    assert.match(result.stderr, /Bridge was not running/);
  });

  // -------------------------------------------------------------------------
  // Claude handoff — auto-detect via CLAUDE_SESSION_ID
  // -------------------------------------------------------------------------

  it('claude (no session-id): auto-detects via CLAUDE_SESSION_ID env', () => {
    const result = run(['claude'], {
      CLAUDE_SESSION_ID: 'env-detected-session',
    });
    assert.equal(result.status, 0, result.stderr);

    const bindings = JSON.parse(
      fs.readFileSync(path.join(ctiHome, 'data', 'bindings.json'), 'utf8'),
    );
    assert.equal(bindings['weixin:chat-a'].sdkSessionId, 'env-detected-session');
    assert.match(readConfig(), /^CTI_RUNTIME=claude$/m);
  });

  it('claude (no session-id): errors with actionable message when auto-detect fails', () => {
    const result = run(['claude'], {
      CLAUDE_SESSION_ID: '',
      CMUX_CLAUDE_PID: '',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot detect current Claude session ID/);
    assert.match(result.stderr, /handoff claude sessions/);
  });

  it('switches global runtime back to codex for Codex weixin handoff', () => {
    writeConfig(
      [
        'CTI_RUNTIME=claude',
        'CTI_ENABLED_CHANNELS=weixin',
        'CTI_DEFAULT_WORKDIR=/tmp/workspace/project-z',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(stateFile, 'running', 'utf8');

    const result = run(['weixin', 'thread-1']);
    assert.equal(result.status, 0, result.stderr);

    assert.match(readConfig(), /^CTI_RUNTIME=codex$/m);
    assert.match(result.stderr, /Global runtime switched: claude -> codex/);
  });

  it('restores the original runtime and daemon when bind fails', () => {
    const failingHelper = path.join(tmpRoot, 'failing-claude-helper.mjs');
    fs.writeFileSync(
      failingHelper,
      "console.error('bind failed intentionally'); process.exit(1);\n",
      'utf8',
    );
    fs.writeFileSync(stateFile, 'running', 'utf8');

    const result = run(['claude'], {
      CLAUDE_SESSION_ID: 'env-detected-session',
      CTI_CLAUDE_HANDOFF_HELPER: failingHelper,
    });
    assert.equal(result.status, 1);

    const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['status', 'stop', 'start']);
    assert.match(readConfig(), /^CTI_RUNTIME=codex$/m);
    assert.match(result.stderr, /Bind failed\. Restored global runtime to codex\./);
    assert.ok(fs.existsSync(stateFile));
  });

  it('keeps the switched runtime and written binding when restart fails', () => {
    fs.writeFileSync(stateFile, 'running', 'utf8');

    const result = run(['claude'], {
      CLAUDE_SESSION_ID: 'env-detected-session',
      CTI_TEST_FAIL_START: '1',
    });
    assert.equal(result.status, 1);

    const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['status', 'stop', 'start']);
    assert.match(readConfig(), /^CTI_RUNTIME=claude$/m);

    const bindings = JSON.parse(
      fs.readFileSync(path.join(ctiHome, 'data', 'bindings.json'), 'utf8'),
    );
    assert.equal(bindings['weixin:chat-a'].sdkSessionId, 'env-detected-session');
    assert.match(result.stderr, /binding was written/i);
    assert.match(result.stderr, /Bridge restart: failed/);
  });

  it('appends CTI_RUNTIME when it is missing and preserves other config lines', () => {
    writeConfig(
      [
        'CTI_ENABLED_CHANNELS=weixin',
        'CTI_DEFAULT_WORKDIR=/tmp/workspace/project-z',
        'CUSTOM_VALUE=keep-me',
        '',
      ].join('\n'),
    );

    const result = run(['claude'], {
      CLAUDE_SESSION_ID: 'env-detected-session',
    });
    assert.equal(result.status, 0, result.stderr);

    const config = readConfig();
    assert.match(config, /^CTI_ENABLED_CHANNELS=weixin$/m);
    assert.match(config, /^CTI_DEFAULT_WORKDIR=\/tmp\/workspace\/project-z$/m);
    assert.match(config, /^CUSTOM_VALUE=keep-me$/m);
    assert.match(config, /^CTI_RUNTIME=claude$/m);
  });
});
