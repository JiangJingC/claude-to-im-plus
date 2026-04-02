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
        CODEX_THREAD_ID: '',
        CLAUDE_SESSION_ID: '',
        CMUX_CLAUDE_PID: '',
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
  // Public handoff entrypoint: `handoff weixin`
  // -------------------------------------------------------------------------

  it('restarts the bridge around a successful Codex weixin handoff', () => {
    fs.writeFileSync(stateFile, 'running', 'utf8');

    const result = run(['weixin'], {
      CODEX_THREAD_ID: 'thread-1',
    });
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
    const result = run(['weixin'], {
      CODEX_THREAD_ID: 'thread-1',
    });
    assert.equal(result.status, 0, result.stderr);

    const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['status', 'status']);
    assert.match(readConfig(), /^CTI_RUNTIME=codex$/m);
  });

  it('auto-detects the current Claude session via CLAUDE_SESSION_ID', () => {
    fs.writeFileSync(stateFile, 'running', 'utf8');
    const result = run(['weixin'], {
      CLAUDE_SESSION_ID: 'env-detected-session',
    });
    assert.equal(result.status, 0, result.stderr);

    const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['status', 'stop', 'start', 'status']);
    assert.match(result.stderr, /Pending permission requests will be lost/);

    const bindings = JSON.parse(
      fs.readFileSync(path.join(ctiHome, 'data', 'bindings.json'), 'utf8'),
    );
    assert.equal(bindings['weixin:chat-a'].sdkSessionId, 'env-detected-session');
    assert.match(readConfig(), /^CTI_RUNTIME=claude$/m);
    assert.match(result.stderr, /Global runtime switched: codex -> claude/);
  });

  it('auto-detects the current Claude session via CMUX_CLAUDE_PID', () => {
    const fakePid = '42424';
    writeJson(path.join(claudeHome, 'sessions', `${fakePid}.json`), {
      sessionId: 'pid-detected-session',
      cwd: '/tmp/workspace/project-a',
      startedAt: 1775102000000,
    });

    const result = run(['weixin'], {
      CMUX_CLAUDE_PID: fakePid,
    });
    assert.equal(result.status, 0, result.stderr);

    const bindings = JSON.parse(
      fs.readFileSync(path.join(ctiHome, 'data', 'bindings.json'), 'utf8'),
    );
    assert.equal(bindings['weixin:chat-a'].sdkSessionId, 'pid-detected-session');
    assert.match(readConfig(), /^CTI_RUNTIME=claude$/m);
  });

  it('errors with a clear message when the current session cannot be detected', () => {
    const result = run(['weixin'], {
      CLAUDE_SESSION_ID: '',
      CMUX_CLAUDE_PID: '',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot detect the current Claude Code session|Cannot detect the current Codex or Claude Code session/);
  });

  it('prefers CODEX_THREAD_ID when both Codex and Claude hints are present', () => {
    fs.writeFileSync(stateFile, 'running', 'utf8');

    const result = run(['weixin'], {
      CODEX_THREAD_ID: 'thread-1',
      CLAUDE_SESSION_ID: 'env-detected-session',
    });
    assert.equal(result.status, 0, result.stderr);

    const bindings = JSON.parse(
      fs.readFileSync(path.join(ctiHome, 'data', 'bindings.json'), 'utf8'),
    );
    assert.equal(bindings['weixin:chat-a'].sdkSessionId, 'thread-1');
    assert.match(readConfig(), /^CTI_RUNTIME=codex$/m);
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

    const result = run(['weixin'], {
      CODEX_THREAD_ID: 'thread-1',
    });
    assert.equal(result.status, 0, result.stderr);

    assert.match(readConfig(), /^CTI_RUNTIME=codex$/m);
    assert.match(result.stderr, /Global runtime switched: claude -> codex/);
  });

  it('restores the original runtime and daemon when bind fails', () => {
    const failingHelper = path.join(tmpRoot, 'failing-claude-helper.mjs');
    fs.writeFileSync(
      failingHelper,
      [
        '#!/usr/bin/env node',
        "const command = process.argv[2] || '';",
        "if (command === 'current') {",
        "  console.log(JSON.stringify({ sessionId: 'env-detected-session', cwd: process.cwd(), source: 'test' }));",
        '  process.exit(0);',
        '}',
        "console.error('bind failed intentionally');",
        'process.exit(1);',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(stateFile, 'running', 'utf8');

    const result = run(['weixin'], {
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

    const result = run(['weixin'], {
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

    const result = run(['weixin'], {
      CLAUDE_SESSION_ID: 'env-detected-session',
    });
    assert.equal(result.status, 0, result.stderr);

    const config = readConfig();
    assert.match(config, /^CTI_ENABLED_CHANNELS=weixin$/m);
    assert.match(config, /^CTI_DEFAULT_WORKDIR=\/tmp\/workspace\/project-z$/m);
    assert.match(config, /^CUSTOM_VALUE=keep-me$/m);
    assert.match(config, /^CTI_RUNTIME=claude$/m);
  });

  it('errors when there are multiple weixin bindings', () => {
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
      'weixin:chat-b': {
        id: 'binding-bbb222',
        channelType: 'weixin',
        chatId: 'chat-b',
        codepilotSessionId: 'other-session-id',
        sdkSessionId: 'other-thread-id',
        workingDirectory: '/tmp/workspace/project-b',
        model: '',
        mode: 'code',
        active: true,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
    });

    const result = run(['weixin'], {
      CODEX_THREAD_ID: 'thread-1',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Multiple weixin bindings found/);
  });

  it('errors when there is no weixin binding yet', () => {
    writeJson(path.join(ctiHome, 'data', 'bindings.json'), {});

    const result = run(['weixin'], {
      CODEX_THREAD_ID: 'thread-1',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No weixin bindings found/);
  });

  it('errors when explicit thread or session arguments are provided', () => {
    const result = run(['weixin', 'thread-1']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Explicit session\/thread selection has been removed/);
  });

  it('returns a clear error for removed commands', () => {
    for (const args of [['projects'], ['threads'], ['claude']]) {
      const result = run(args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /has been removed/);
      assert.match(result.stderr, /handoff weixin/);
    }
  });
});
