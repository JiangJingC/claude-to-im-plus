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
  let stateFile: string;
  let logFile: string;
  let fakeDaemon: string;

  function run(args: string[]) {
    return spawnSync('bash', [HANDOFF_SH, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CTI_HOME: ctiHome,
        CODEX_HOME: codexHome,
        CTI_DAEMON_SH: fakeDaemon,
        CTI_TEST_STATE_FILE: stateFile,
        CTI_TEST_LOG_FILE: logFile,
      },
    });
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-handoff-wrapper-'));
    ctiHome = path.join(tmpRoot, 'cti-home');
    codexHome = path.join(tmpRoot, 'codex-home');
    stateFile = path.join(tmpRoot, 'daemon.state');
    logFile = path.join(tmpRoot, 'daemon.log');
    fakeDaemon = path.join(tmpRoot, 'fake-daemon.sh');

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
  });

  it('does not auto-start the bridge if it was not already running', () => {
    const result = run(['weixin', 'thread-1']);
    assert.equal(result.status, 0, result.stderr);

    const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['status', 'status']);
  });
});
