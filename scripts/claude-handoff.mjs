#!/usr/bin/env node
/**
 * claude-handoff.mjs — Claude Code session handoff helper for claude-to-im
 *
 * Reads Claude Code session data from ~/.claude/ and bridges a selected session
 * to a supported IM binding in ~/.claude-to-im/.
 *
 * Claude resume / settings limitations (v1):
 *   - Only the session UUID is passed to the bridge.  The bridge resumes it via
 *     the `--resume` flag of `claude` CLI.
 *   - The `--settings`, `--permission-mode`, sandbox flags, and any extra
 *     `--add-dir` that were active in the original desktop/CLI session are NOT
 *     replicated.  The resumed session inherits only what the bridge's own
 *     daemon environment provides (CTI_ENV_ISOLATION, CTI_DEFAULT_MODE, etc.).
 *   - This means: tool policies, allowed directories, and dangerously-skip-
 *     permissions status may differ from the original Claude Code window.
 *   - Do not assume "fully inherits desktop permissions".  Read the bridge's
 *     own config.env to understand what is actually granted.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const CTI_HOME = process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im');
const CLAUDE_HOME = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');

const DATA_DIR = path.join(CTI_HOME, 'data');
const PROJECTS_PATH = path.join(CTI_HOME, 'projects.json');
const BINDINGS_PATH = path.join(DATA_DIR, 'bindings.json');
const DINGTALK_WEBHOOKS_PATH = path.join(DATA_DIR, 'dingtalk-webhooks.json');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');

// Claude Code data paths
const CLAUDE_SESSIONS_DIR = path.join(CLAUDE_HOME, 'sessions');       // <PID>.json live sessions
const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');       // <encoded-path>/<uuid>.jsonl
const CLAUDE_META_DIR = path.join(CLAUDE_HOME, 'usage-data', 'session-meta'); // <uuid>.json

// ---------------------------------------------------------------------------
// Generic helpers (intentionally kept in-file; no runtime deps other than stdlib)
// ---------------------------------------------------------------------------

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function atomicWriteJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function readJsonFile(filePath, fallback) {
  if (!fileExists(filePath)) {
    return fallback;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function normalizePathValue(value) {
  const resolved = path.resolve(value);
  if (resolved.length > 1 && resolved.endsWith(path.sep)) {
    return resolved.slice(0, -1);
  }
  return resolved;
}

function normalizeProjectCwd(cwd, projectId) {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw new Error(`Project "${projectId}" is missing a valid cwd.`);
  }
  if (!path.isAbsolute(cwd)) {
    throw new Error(`Project "${projectId}" cwd must be an absolute path: ${cwd}`);
  }
  return normalizePathValue(cwd);
}

function nowIso() {
  return new Date().toISOString();
}

function safeTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) {
    if (typeof value === 'number' && !Number.isNaN(value)) {
      // Unix-ms (e.g. from history.jsonl)
      return new Date(value).toISOString();
    }
    return '';
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

function compareDescByTimestamp(left, right) {
  const leftTs = safeTimestamp(left);
  const rightTs = safeTimestamp(right);
  if (leftTs === rightTs) return 0;
  if (!leftTs) return 1;
  if (!rightTs) return -1;
  return leftTs < rightTs ? 1 : -1;
}

function normalizeTtyValue(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === '?' || trimmed === '??' || trimmed === '-') {
    return '';
  }
  return trimmed;
}

function projectConfigExample() {
  return [
    'Example ~/.claude-to-im/projects.json:',
    '{',
    '  "projects": [',
    '    {',
    '      "id": "skill",',
    '      "name": "Claude-to-IM Plus",',
    '      "cwd": "/absolute/path/to/project"',
    '    }',
    '  ]',
    '}',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// projects.json reader (shared with codex-handoff.mjs logic)
// ---------------------------------------------------------------------------

export function readProjectsConfig() {
  if (!fileExists(PROJECTS_PATH)) {
    throw new Error(
      `No projects config found at ${PROJECTS_PATH}.\n${projectConfigExample()}`,
    );
  }

  let parsed;
  try {
    parsed = readJsonFile(PROJECTS_PATH, null);
  } catch (error) {
    throw new Error(`Failed to parse ${PROJECTS_PATH}: ${error.message}`);
  }

  if (!parsed || !Array.isArray(parsed.projects)) {
    throw new Error(
      `Invalid ${PROJECTS_PATH}: expected {"projects":[...] }.\n${projectConfigExample()}`,
    );
  }

  const seenIds = new Set();
  return parsed.projects.map((project, index) => {
    if (!project || typeof project !== 'object') {
      throw new Error(`Project entry #${index + 1} must be an object.`);
    }

    const id = typeof project.id === 'string' ? project.id.trim() : '';
    const name = typeof project.name === 'string' ? project.name.trim() : '';

    if (!id) {
      throw new Error(`Project entry #${index + 1} is missing a valid id.`);
    }
    if (!name) {
      throw new Error(`Project "${id}" is missing a valid name.`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate project id "${id}" in ${PROJECTS_PATH}.`);
    }
    seenIds.add(id);

    return {
      id,
      name,
      cwd: normalizeProjectCwd(project.cwd, id),
    };
  });
}

export function listProjects() {
  return readProjectsConfig();
}

// ---------------------------------------------------------------------------
// Claude session discovery
// ---------------------------------------------------------------------------

/**
 * Read the session-meta JSON files from ~/.claude/usage-data/session-meta/.
 * Returns a Map<sessionId, {sessionId, projectPath, startTime, firstPrompt}>.
 */
function readClaudeSessionMeta() {
  const metaById = new Map();
  if (!fileExists(CLAUDE_META_DIR)) {
    return metaById;
  }
  for (const entry of fs.readdirSync(CLAUDE_META_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(CLAUDE_META_DIR, entry.name);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw);
      const id = typeof data?.session_id === 'string' ? data.session_id : '';
      if (!id) continue;
      metaById.set(id, {
        sessionId: id,
        projectPath: typeof data.project_path === 'string' ? data.project_path : '',
        startTime: safeTimestamp(data.start_time || ''),
        firstPrompt: typeof data.first_prompt === 'string' ? data.first_prompt : '',
      });
    } catch {
      // skip malformed file
    }
  }
  return metaById;
}

/**
 * Walk ~/.claude/projects/ to discover sessions with their cwd and last
 * message timestamp.
 *
 * Directory structure:
 *   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
 *
 * Each .jsonl record that has a sessionId and cwd field (user messages)
 * tells us the project path.  We take the cwd from the first user message.
 * The last message timestamp gives us the latest activity time.
 *
 * Returns a Map<sessionId, {sessionId, cwd, updatedAt, summary}>.
 */
function readClaudeProjectSessions() {
  const sessionById = new Map();
  if (!fileExists(CLAUDE_PROJECTS_DIR)) {
    return sessionById;
  }

  for (const projectEntry of fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectEntry.name);

    for (const fileEntry of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;
      // session UUID is the filename without .jsonl
      const sessionId = fileEntry.name.slice(0, -('.jsonl'.length));
      if (!sessionId) continue;

      const filePath = path.join(projectDir, fileEntry.name);
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        let cwd = '';
        let updatedAt = '';
        let summary = '';

        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }

          // Pick up cwd from any record that has it (user messages, etc.)
          if (!cwd && typeof record.cwd === 'string' && record.cwd) {
            cwd = normalizePathValue(record.cwd);
          }

          // Track the latest timestamp
          if (record.timestamp) {
            const ts = safeTimestamp(record.timestamp);
            if (ts && (!updatedAt || ts > updatedAt)) {
              updatedAt = ts;
            }
          }

          // Try to extract a first-message summary from a user record
          if (!summary && record.type === 'user' && record.message?.content) {
            const content = record.message.content;
            if (typeof content === 'string') {
              summary = content.slice(0, 120);
            } else if (Array.isArray(content)) {
              const textBlock = content.find((b) => b?.type === 'text');
              if (textBlock?.text) {
                summary = String(textBlock.text).slice(0, 120);
              }
            }
          }
        }

        if (!cwd && !updatedAt) continue;

        const existing = sessionById.get(sessionId);
        if (!existing || (updatedAt && (!existing.updatedAt || updatedAt > existing.updatedAt))) {
          sessionById.set(sessionId, { sessionId, cwd, updatedAt, summary });
        }
      } catch {
        // skip unreadable file
      }
    }
  }
  return sessionById;
}

function readLiveClaudeSessionCandidates() {
  const candidates = [];
  if (!fileExists(CLAUDE_SESSIONS_DIR)) {
    return candidates;
  }

  for (const entry of fs.readdirSync(CLAUDE_SESSIONS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

    const filePath = path.join(CLAUDE_SESSIONS_DIR, entry.name);
    try {
      const data = readJsonFile(filePath, null);
      const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';
      if (!sessionId) continue;

      const cwd = typeof data?.cwd === 'string' && data.cwd
        ? normalizePathValue(data.cwd)
        : '';
      const pid = Number(entry.name.slice(0, -('.json'.length)));
      const liveStartedAt = typeof data?.startedAt === 'number'
        ? new Date(data.startedAt).toISOString()
        : '';

      candidates.push({
        sessionId,
        cwd,
        pid: Number.isInteger(pid) && pid > 0 ? pid : null,
        liveStartedAt,
      });
    } catch {
      // skip unreadable file
    }
  }

  return candidates;
}

function readLiveClaudeSessions() {
  const sessionById = new Map();

  for (const candidate of readLiveClaudeSessionCandidates()) {
    sessionById.set(candidate.sessionId, {
      sessionId: candidate.sessionId,
      cwd: candidate.cwd,
      updatedAt: candidate.liveStartedAt,
      startTime: candidate.liveStartedAt,
      summary: '',
    });
  }

  return sessionById;
}

function readProcessSnapshot() {
  const fixture = process.env.CTI_CLAUDE_HANDOFF_PS_SNAPSHOT;
  if (fixture) {
    try {
      const parsed = JSON.parse(fixture);
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => ({
            pid: Number(entry?.pid),
            ppid: Number(entry?.ppid),
            tty: normalizeTtyValue(entry?.tty),
            command: typeof entry?.command === 'string' ? entry.command : '',
          }))
          .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
      }
    } catch {
      // Ignore malformed fixture and fall back to ps.
    }
  }

  try {
    const raw = execSync('ps -axo pid=,ppid=,tty=,comm=', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return raw
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
        if (!match) return null;
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          tty: normalizeTtyValue(match[3]),
          command: match[4],
        };
      })
      .filter((entry) => entry && Number.isInteger(entry.pid) && entry.pid > 0);
  } catch {
    return [];
  }
}

function collectAncestorPids(processByPid, startPid) {
  const ancestors = new Set();
  const visited = new Set();
  let currentPid = startPid;

  while (Number.isInteger(currentPid) && currentPid > 0 && !visited.has(currentPid)) {
    visited.add(currentPid);
    const current = processByPid.get(currentPid);
    if (!current || !Number.isInteger(current.ppid) || current.ppid <= 0) {
      break;
    }
    ancestors.add(current.ppid);
    currentPid = current.ppid;
  }

  return ancestors;
}

function compareCurrentSessionCandidates(left, right) {
  if (left.ancestorMatch !== right.ancestorMatch) {
    return left.ancestorMatch ? -1 : 1;
  }
  if (left.ttyMatch !== right.ttyMatch) {
    return left.ttyMatch ? -1 : 1;
  }

  const activity = compareDescByTimestamp(left.updatedAt, right.updatedAt);
  if (activity !== 0) return activity;

  const start = compareDescByTimestamp(left.startTime, right.startTime);
  if (start !== 0) return start;

  const liveStart = compareDescByTimestamp(left.liveStartedAt, right.liveStartedAt);
  if (liveStart !== 0) return liveStart;

  return left.sessionId.localeCompare(right.sessionId);
}

function hasMeaningfulLead(best, runnerUp) {
  if (!runnerUp) return true;
  if (best.ancestorMatch !== runnerUp.ancestorMatch) return true;
  if (best.ttyMatch !== runnerUp.ttyMatch) return true;
  if (compareDescByTimestamp(best.updatedAt, runnerUp.updatedAt) !== 0) return true;
  if (compareDescByTimestamp(best.startTime, runnerUp.startTime) !== 0) return true;
  if (compareDescByTimestamp(best.liveStartedAt, runnerUp.liveStartedAt) !== 0) return true;
  return false;
}

/**
 * Build a merged index of all known Claude sessions.
 * Merges session-meta (startTime, firstPrompt) with project sessions (cwd, updatedAt).
 */
function buildClaudeSessionIndex() {
  const metaById = readClaudeSessionMeta();
  const projectById = readClaudeProjectSessions();
  const liveById = readLiveClaudeSessions();

  // Union of all known session IDs
  const ids = new Set([...metaById.keys(), ...projectById.keys(), ...liveById.keys()]);

  const sessions = [];
  for (const id of ids) {
    const meta = metaById.get(id);
    const project = projectById.get(id);
    const live = liveById.get(id);

    // Use project.cwd first (more direct), fallback to meta.projectPath
    const cwd = project?.cwd || live?.cwd || (meta?.projectPath ? normalizePathValue(meta.projectPath) : '');
    const updatedAt = project?.updatedAt || live?.updatedAt || meta?.startTime || '';
    const summary = project?.summary || meta?.firstPrompt || '';
    const startTime = meta?.startTime || live?.startTime || '';

    sessions.push({ sessionId: id, cwd, updatedAt, startTime, summary });
  }

  sessions.sort((a, b) => {
    const primary = compareDescByTimestamp(a.updatedAt, b.updatedAt);
    if (primary !== 0) return primary;
    return compareDescByTimestamp(a.startTime, b.startTime);
  });

  return sessions;
}

function findKnownSession(sessionId) {
  return buildClaudeSessionIndex().find((session) => session.sessionId === sessionId) || null;
}

export function listSessionsForProject(projectId, limit = 20) {
  const projects = readProjectsConfig();
  const project = projects.find((entry) => entry.id === projectId);
  if (!project) {
    throw new Error(`Unknown project id "${projectId}". Run "handoff claude projects" first.`);
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Limit must be a positive integer. Received: ${limit}`);
  }

  const allSessions = buildClaudeSessionIndex();
  const sessions = allSessions
    .filter((s) => s.cwd === project.cwd)
    .slice(0, limit);

  return { project, sessions };
}

// ---------------------------------------------------------------------------
// Current session detection
// ---------------------------------------------------------------------------

/**
 * Try to find the Claude session ID for the currently-running interactive
 * Claude Code process.
 *
 * Strategy (in order of reliability):
 *  1. CLAUDE_SESSION_ID env var — if the user or a wrapper sets this explicitly
 *  2. CMUX_CLAUDE_PID env var — cmux wrapper sets the parent claude PID; we
 *     look it up in ~/.claude/sessions/<PID>.json
 *  3. Restrict to ~/.claude/sessions/<PID>.json entries whose cwd matches
 *     process.cwd(), then prefer the current process ancestry / tty match and
 *     finally the most recently active same-cwd session
 *
 * Returns { sessionId, cwd, pid } or null if not found.
 *
 * IMPORTANT: Strategy 3 is still heuristic, but it never falls back across
 * project directories. If the current cwd has no live Claude session, we fail
 * rather than accidentally rebinding to another project.
 */
export function resolveCurrentSession() {
  // Strategy 1: explicit env var
  const envSessionId = process.env.CLAUDE_SESSION_ID;
  if (envSessionId) {
    return { sessionId: envSessionId, cwd: process.cwd(), pid: null, source: 'env' };
  }

  // Strategy 2: cmux-injected PID → look up sessions/<PID>.json
  const cmuxPid = process.env.CMUX_CLAUDE_PID;
  if (cmuxPid) {
    const pidFilePath = path.join(CLAUDE_SESSIONS_DIR, `${cmuxPid}.json`);
    if (fileExists(pidFilePath)) {
      try {
        const data = readJsonFile(pidFilePath, null);
        if (data?.sessionId) {
          return { sessionId: data.sessionId, cwd: data.cwd || '', pid: Number(cmuxPid), source: 'cmux_pid' };
        }
      } catch {
        // fall through
      }
    }
  }

  const currentCwd = normalizePathValue(process.cwd());
  const liveCandidates = readLiveClaudeSessionCandidates()
    .filter((candidate) => candidate.cwd === currentCwd);
  if (liveCandidates.length === 0) {
    return null;
  }

  const knownSessions = new Map(
    buildClaudeSessionIndex().map((session) => [session.sessionId, session]),
  );
  const processSnapshot = readProcessSnapshot();
  const processByPid = new Map(processSnapshot.map((entry) => [entry.pid, entry]));
  const ancestorPids = collectAncestorPids(processByPid, process.pid);
  const currentTty = normalizeTtyValue(processByPid.get(process.pid)?.tty || '');

  const rankedCandidates = liveCandidates.map((candidate) => {
    const known = knownSessions.get(candidate.sessionId);
    const candidateTty = normalizeTtyValue(
      candidate.pid ? processByPid.get(candidate.pid)?.tty || '' : '',
    );

    return {
      sessionId: candidate.sessionId,
      cwd: candidate.cwd,
      pid: candidate.pid,
      liveStartedAt: candidate.liveStartedAt,
      updatedAt: known?.updatedAt || candidate.liveStartedAt || '',
      startTime: known?.startTime || candidate.liveStartedAt || '',
      ancestorMatch: Boolean(candidate.pid && ancestorPids.has(candidate.pid)),
      ttyMatch: Boolean(currentTty && candidateTty && currentTty === candidateTty),
    };
  });

  rankedCandidates.sort(compareCurrentSessionCandidates);
  const best = rankedCandidates[0];
  const runnerUp = rankedCandidates[1];
  const ambiguous = !hasMeaningfulLead(best, runnerUp);

  return {
    sessionId: best.sessionId,
    cwd: best.cwd,
    pid: best.pid,
    source: best.ancestorMatch
      ? 'process_ancestry'
      : (best.ttyMatch ? 'tty' : 'same_cwd_recent_activity'),
    ambiguous,
  };
}

export function getCurrentSessionOrThrow() {
  const current = resolveCurrentSession();
  if (!current) {
    throw new Error(
      'Cannot detect the current Claude Code session.\n' +
      'Run "handoff weixin" or "handoff dingtalk" from an active Claude Code conversation.',
    );
  }

  if (current.ambiguous) {
    throw new Error(
      `Multiple Claude Code sessions were found in ${current.cwd || process.cwd()}.\n` +
      'Close the extra Claude Code windows in the same directory, then run the handoff command again from the target conversation.',
    );
  }

  return current;
}

// ---------------------------------------------------------------------------
// Bindings helpers (mirror of codex-handoff.mjs)
// ---------------------------------------------------------------------------

function readBindingsMap() {
  return readJsonFile(BINDINGS_PATH, {});
}

function readSessionsMap() {
  return readJsonFile(SESSIONS_PATH, {});
}

function readDingtalkChatMap() {
  return readJsonFile(DINGTALK_WEBHOOKS_PATH, {});
}

function describeBinding(binding, metadata) {
  const conversationType = String(metadata?.conversationType || '');
  const conversationTitle = typeof metadata?.conversationTitle === 'string'
    ? metadata.conversationTitle.trim()
    : '';
  const senderNick = typeof metadata?.senderNick === 'string'
    ? metadata.senderNick.trim()
    : '';
  const updatedAt = safeTimestamp(metadata?.updatedAt || binding?.updatedAt || '');
  const typeLabel = conversationType === '2'
    ? 'group'
    : (conversationType === '1' ? 'private' : 'unknown');
  const displayName = conversationTitle
    || (typeLabel === 'private' && senderNick ? senderNick : '')
    || binding.chatId;

  return {
    bindingId: binding.id,
    chatId: binding.chatId,
    displayName,
    typeLabel,
    conversationTitle,
    senderNick,
    updatedAt,
  };
}

export function listBindingsForChannel(channelType) {
  const bindingsMap = readBindingsMap();
  const dingtalkChatMap = channelType === 'dingtalk' ? readDingtalkChatMap() : {};
  return Object.entries(bindingsMap)
    .map(([key, value]) => ({ key, value }))
    .filter(({ value }) => value?.channelType === channelType)
    .map(({ key, value }) => ({
      key,
      value,
      summary: describeBinding(value, dingtalkChatMap[value.chatId]),
    }))
    .sort((left, right) => {
      const primary = compareDescByTimestamp(left.summary.updatedAt, right.summary.updatedAt);
      if (primary !== 0) return primary;
      return left.summary.bindingId.localeCompare(right.summary.bindingId);
    });
}

function formatBindingDetails(matches) {
  return matches
    .map(({ summary }, index) => {
      const updatedAt = summary.updatedAt || 'unknown';
      return `- [${index + 1}] ${summary.bindingId} | ${summary.typeLabel} | ${summary.displayName} | ${summary.chatId} | ${updatedAt}`;
    })
    .join('\n');
}

function selectBinding(channelType, bindingPrefix) {
  const matches = listBindingsForChannel(channelType);

  if (matches.length === 0) {
    throw new Error(
      `No ${channelType} bindings found in ${BINDINGS_PATH}. ` +
      'Ask the target chat to send at least one message first so the bridge can create a binding.',
    );
  }

  if (matches.length === 1 && !bindingPrefix) {
    return matches[0];
  }

  if (!bindingPrefix) {
    const details = formatBindingDetails(matches);
    throw new Error(
      `Multiple ${channelType} bindings found. Re-run with --binding <binding-id-prefix>.\n${details}`,
    );
  }

  const prefixMatches = matches.filter(({ value }) => value?.id?.startsWith(bindingPrefix));
  if (prefixMatches.length === 0) {
    throw new Error(`No ${channelType} binding matches prefix "${bindingPrefix}".`);
  }
  if (prefixMatches.length > 1) {
    const details = formatBindingDetails(prefixMatches);
    throw new Error(
      `Binding prefix "${bindingPrefix}" is ambiguous. Please use a longer prefix.\n${details}`,
    );
  }
  return prefixMatches[0];
}

function resolveWorkingDirectory(sessionId, overrideCwd) {
  if (overrideCwd) {
    return normalizePathValue(overrideCwd);
  }

  // Look up cwd from the session index
  const allSessions = buildClaudeSessionIndex();
  const found = allSessions.find((s) => s.sessionId === sessionId);
  if (found?.cwd) {
    return found.cwd;
  }

  return normalizePathValue(process.cwd());
}

/**
 * Bind a Claude session to a supported IM binding.
 *
 * Behaviour:
 * - Creates a new bridge session UUID (does NOT reuse or delete the old one).
 * - Updates bindings.json to point the selected binding at the new
 *   bridge session + Claude session ID.
 * - Clears the model pin by default (clearModel = true when not explicitly set)
 *   to avoid resume failures caused by model mismatch.
 *
 * Limitations (v1):
 * - The resumed session will NOT inherit: --settings, --permission-mode,
 *   sandbox flags, or extra allowed directories from the original session.
 *   The bridge uses its own daemon environment (config.env).
 */
export function bindSessionToChannel(options = {}) {
  const channel = options.channel || 'weixin';
  if (!['weixin', 'dingtalk'].includes(channel)) {
    throw new Error(`Unsupported channel "${channel}". v1 handoff only supports weixin or dingtalk.`);
  }

  let sessionId = options.sessionId || '';
  let detectedSession = null;
  const { key, value: binding } = selectBinding(channel, options.bindingPrefix);

  // Auto-detect current session if none provided
  if (!sessionId) {
    const current = getCurrentSessionOrThrow();
    sessionId = current.sessionId;
    detectedSession = current;
  } else if (!findKnownSession(sessionId)) {
    throw new Error(
      `Unknown Claude session ID "${sessionId}".\n` +
      'Run "handoff claude sessions <project-id>" to list known sessions, then retry with one of those session ids.',
    );
  }

  const sessionsMap = readSessionsMap();
  const bindingsMap = readBindingsMap();
  const workingDirectory = options.cwd
    ? normalizePathValue(options.cwd)
    : (detectedSession?.cwd ? normalizePathValue(detectedSession.cwd) : resolveWorkingDirectory(sessionId, options.cwd));
  const model = options.clearModel ? '' : (options.model ?? '');
  const newBridgeSessionId = crypto.randomUUID();

  sessionsMap[newBridgeSessionId] = {
    id: newBridgeSessionId,
    working_directory: workingDirectory,
    model,
    sdk_session_id: sessionId,
  };

  bindingsMap[key] = {
    ...binding,
    codepilotSessionId: newBridgeSessionId,
    sdkSessionId: sessionId,
    workingDirectory,
    model,
    updatedAt: nowIso(),
  };

  atomicWriteJson(SESSIONS_PATH, sessionsMap);
  atomicWriteJson(BINDINGS_PATH, bindingsMap);

  return {
    channelType: channel,
    chatId: binding.chatId,
    bindingId: binding.id,
    oldCodepilotSessionId: binding.codepilotSessionId,
    newCodepilotSessionId: newBridgeSessionId,
    sdkSessionId: sessionId,
    workingDirectory,
    model,
  };
}

// ---------------------------------------------------------------------------
// CLI rendering helpers
// ---------------------------------------------------------------------------

function renderProjects(projects) {
  if (projects.length === 0) {
    return `No projects configured in ${PROJECTS_PATH}.`;
  }
  return [
    `Projects from ${PROJECTS_PATH}:`,
    ...projects.map((project) => `- ${project.id} | ${project.name} | ${project.cwd}`),
  ].join('\n');
}

function renderSessions(result) {
  if (result.sessions.length === 0) {
    return `No Claude sessions found for project "${result.project.id}" (${result.project.cwd}).`;
  }
  return [
    `Claude sessions for ${result.project.id} (${result.project.cwd}):`,
    ...result.sessions.map((session) => {
      const ts = session.updatedAt || session.startTime || 'unknown';
      const summary = session.summary ? ` | ${session.summary.slice(0, 60).replace(/\n/g, ' ')}` : '';
      return `- ${session.sessionId} | ${ts}${summary}`;
    }),
  ].join('\n');
}

function renderBinding(result) {
  return [
    'Handoff updated successfully:',
    `- channelType: ${result.channelType}`,
    `- chatId: ${result.chatId}`,
    `- bindingId: ${result.bindingId}`,
    `- oldCodepilotSessionId: ${result.oldCodepilotSessionId}`,
    `- newCodepilotSessionId: ${result.newCodepilotSessionId}`,
    `- sdkSessionId: ${result.sdkSessionId}`,
    `- workingDirectory: ${result.workingDirectory}`,
    `- model: ${result.model === '' ? '(cleared)' : result.model}`,
    '',
    'NOTE: The resumed Claude session inherits only what the bridge daemon',
    'environment provides (config.env).  Settings, sandbox flags, and',
    'allowed-dirs from the original Claude Code window are NOT propagated.',
  ].join('\n');
}

function renderBindings(channelType, bindings) {
  if (bindings.length === 0) {
    return `No ${channelType} bindings found in ${BINDINGS_PATH}.`;
  }

  return [
    `${channelType} bindings from ${BINDINGS_PATH}:`,
    ...bindings.map(({ summary }, index) => {
      const updatedAt = summary.updatedAt || 'unknown';
      return `- [${index + 1}] ${summary.bindingId} | ${summary.typeLabel} | ${summary.displayName} | ${summary.chatId} | ${updatedAt}`;
    }),
  ].join('\n');
}

function parseBindingsOptions(args) {
  const options = {
    channel: '',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--channel':
        options.channel = args[index + 1] || '';
        index += 1;
        break;
      default:
        throw new Error(`Unknown bindings option: ${arg}`);
    }
  }

  if (!options.channel) {
    throw new Error('bindings requires --channel <weixin|dingtalk>.');
  }

  return options;
}

function renderCurrentSession(current) {
  return [
    'Current Claude session:',
    `- sessionId: ${current.sessionId}`,
    `- cwd: ${current.cwd || '(unknown)'}`,
    `- source: ${current.source || 'unknown'}`,
  ].join('\n');
}

function usage() {
  return [
    'Usage:',
    '  node scripts/claude-handoff.mjs projects [--json]',
    '  node scripts/claude-handoff.mjs sessions <project-id> [limit] [--json]',
    '  node scripts/claude-handoff.mjs current [--json]',
    '  node scripts/claude-handoff.mjs bindings --channel <weixin|dingtalk> [--json]',
    '  node scripts/claude-handoff.mjs bind --channel <weixin|dingtalk> [--session-id <id>] [--binding <prefix>] [--cwd <path>] [--model <name>] [--clear-model] [--json]',
  ].join('\n');
}

function parseBindOptions(args) {
  const options = {
    channel: 'weixin',
    sessionId: '',
    bindingPrefix: '',
    cwd: '',
    model: undefined,
    clearModel: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--channel':
        options.channel = args[index + 1] || '';
        index += 1;
        break;
      case '--session-id':
        options.sessionId = args[index + 1] || '';
        index += 1;
        break;
      case '--binding':
        options.bindingPrefix = args[index + 1] || '';
        index += 1;
        break;
      case '--cwd':
        options.cwd = args[index + 1] || '';
        index += 1;
        break;
      case '--model':
        options.model = args[index + 1] || '';
        index += 1;
        break;
      case '--clear-model':
        options.clearModel = true;
        break;
      default:
        throw new Error(`Unknown bind option: ${arg}`);
    }
  }

  return options;
}

function parseCliArgs(argv) {
  const args = [...argv];
  const json = args.includes('--json');
  const filtered = args.filter((arg) => arg !== '--json');
  return {
    json,
    command: filtered[0] || 'help',
    args: filtered.slice(1),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);

  switch (parsed.command) {
    case 'projects': {
      const projects = listProjects();
      if (parsed.json) {
        console.log(JSON.stringify({ projects }, null, 2));
      } else {
        console.log(renderProjects(projects));
      }
      return;
    }

    case 'sessions': {
      const projectId = parsed.args[0];
      const limitRaw = parsed.args[1] || '20';
      const limit = Number.parseInt(limitRaw, 10);

      if (!projectId) {
        throw new Error('sessions requires <project-id>.');
      }

      const result = listSessionsForProject(projectId, limit);
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(renderSessions(result));
      }
      return;
    }

    case 'current': {
      const current = getCurrentSessionOrThrow();
      if (parsed.json) {
        console.log(JSON.stringify(current, null, 2));
      } else {
        console.log(renderCurrentSession(current));
      }
      return;
    }

    case 'bindings': {
      const options = parseBindingsOptions(parsed.args);
      const bindings = listBindingsForChannel(options.channel);
      if (parsed.json) {
        console.log(JSON.stringify({ channelType: options.channel, bindings }, null, 2));
      } else {
        console.log(renderBindings(options.channel, bindings));
      }
      return;
    }

    case 'bind': {
      const result = bindSessionToChannel(parseBindOptions(parsed.args));
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(renderBinding(result));
      }
      return;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(usage());
      return;

    default:
      throw new Error(`Unknown command "${parsed.command}".\n${usage()}`);
  }
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
