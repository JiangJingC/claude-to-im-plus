#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CTI_HOME = process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

const DATA_DIR = path.join(CTI_HOME, 'data');
const PROJECTS_PATH = path.join(CTI_HOME, 'projects.json');
const BINDINGS_PATH = path.join(DATA_DIR, 'bindings.json');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
const SESSION_INDEX_PATH = path.join(CODEX_HOME, 'session_index.jsonl');
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');

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

function readJsonlRecords(filePath) {
  if (!fileExists(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const records = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Failed to parse JSONL in ${filePath}:${index + 1}: ${error.message}`);
    }
  }
  return records;
}

function readFirstJsonlRecord(filePath) {
  if (!fileExists(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Failed to parse JSONL in ${filePath}: ${error.message}`);
    }
  }
  return null;
}

function walkJsonlFiles(dirPath) {
  if (!fileExists(dirPath)) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsonlFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
  return files;
}

function projectConfigExample() {
  return [
    'Example ~/.claude-to-im/projects.json:',
    '{',
    '  "projects": [',
    '    {',
    '      "id": "skill",',
    '      "name": "Claude-to-IM Skill",',
    '      "cwd": "/absolute/path/to/project"',
    '    }',
    '  ]',
    '}',
  ].join('\n');
}

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

function readThreadIndexRecords() {
  const indexById = new Map();

  for (const record of readJsonlRecords(SESSION_INDEX_PATH)) {
    const id = typeof record?.id === 'string' ? record.id : '';
    if (!id) continue;

    const candidate = {
      id,
      threadName:
        typeof record.thread_name === 'string'
          ? record.thread_name
          : (typeof record.name === 'string' ? record.name : ''),
      updatedAt: safeTimestamp(record.updated_at || record.timestamp || ''),
    };

    const existing = indexById.get(id);
    if (!existing || compareDescByTimestamp(candidate.updatedAt, existing.updatedAt) < 0) {
      indexById.set(id, candidate);
    }
  }

  return indexById;
}

function readSessionMetaRecords() {
  const metaById = new Map();

  for (const filePath of walkJsonlFiles(CODEX_SESSIONS_DIR)) {
    const firstRecord = readFirstJsonlRecord(filePath);
    if (!firstRecord || firstRecord.type !== 'session_meta' || !firstRecord.payload) {
      continue;
    }

    const payload = firstRecord.payload;
    const id = typeof payload.id === 'string' ? payload.id : '';
    const cwd = typeof payload.cwd === 'string' ? normalizePathValue(payload.cwd) : '';
    if (!id || !cwd) continue;

    metaById.set(id, {
      id,
      cwd,
      timestamp: safeTimestamp(firstRecord.timestamp || payload.timestamp || ''),
      filePath,
    });
  }

  return metaById;
}

export function buildThreadIndex() {
  const indexById = readThreadIndexRecords();
  const metaById = readSessionMetaRecords();
  const ids = new Set([...indexById.keys(), ...metaById.keys()]);

  const threads = [];
  for (const id of ids) {
    const index = indexById.get(id);
    const meta = metaById.get(id);
    threads.push({
      id,
      threadName: index?.threadName || '',
      updatedAt: index?.updatedAt || meta?.timestamp || '',
      cwd: meta?.cwd || '',
      metaTimestamp: meta?.timestamp || '',
    });
  }

  threads.sort((left, right) => {
    const primary = compareDescByTimestamp(left.updatedAt, right.updatedAt);
    if (primary !== 0) return primary;
    const secondary = compareDescByTimestamp(left.metaTimestamp, right.metaTimestamp);
    if (secondary !== 0) return secondary;
    return left.id.localeCompare(right.id);
  });

  return threads;
}

export function listProjects() {
  return readProjectsConfig();
}

export function listThreadsForProject(projectId, limit = 20) {
  const projects = readProjectsConfig();
  const project = projects.find((entry) => entry.id === projectId);
  if (!project) {
    throw new Error(`Unknown project id "${projectId}". Run "handoff projects" first.`);
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Limit must be a positive integer. Received: ${limit}`);
  }

  const threads = buildThreadIndex()
    .filter((thread) => thread.cwd === project.cwd)
    .slice(0, limit);

  return {
    project,
    threads,
  };
}

function readBindingsMap() {
  return readJsonFile(BINDINGS_PATH, {});
}

function readSessionsMap() {
  return readJsonFile(SESSIONS_PATH, {});
}

function selectBinding(channelType, bindingPrefix) {
  const bindingsMap = readBindingsMap();
  const matches = Object.entries(bindingsMap)
    .map(([key, value]) => ({ key, value }))
    .filter(({ value }) => value?.channelType === channelType);

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
    const details = matches
      .map(({ value }) => `- ${value.id} | ${value.chatId}`)
      .join('\n');
    throw new Error(
      `Multiple ${channelType} bindings found. Re-run with a binding id prefix.\n${details}`,
    );
  }

  const prefixMatches = matches.filter(({ value }) => value?.id?.startsWith(bindingPrefix));
  if (prefixMatches.length === 0) {
    throw new Error(`No ${channelType} binding matches prefix "${bindingPrefix}".`);
  }
  if (prefixMatches.length > 1) {
    const details = prefixMatches
      .map(({ value }) => `- ${value.id} | ${value.chatId}`)
      .join('\n');
    throw new Error(
      `Binding prefix "${bindingPrefix}" is ambiguous. Please use a longer prefix.\n${details}`,
    );
  }
  return prefixMatches[0];
}

function resolveWorkingDirectory(threadId, overrideCwd) {
  if (overrideCwd) {
    return normalizePathValue(overrideCwd);
  }

  const thread = buildThreadIndex().find((entry) => entry.id === threadId);
  if (thread?.cwd) {
    return thread.cwd;
  }

  return normalizePathValue(process.cwd());
}

export function bindThreadToChannel(options = {}) {
  const channel = options.channel || 'weixin';
  if (channel !== 'weixin') {
    throw new Error(`Unsupported channel "${channel}". v1 handoff only supports weixin.`);
  }

  const threadId = options.threadId || process.env.CODEX_THREAD_ID;
  if (!threadId) {
    throw new Error('No thread id provided. Pass --thread-id or run the command from a Codex session that exposes CODEX_THREAD_ID.');
  }

  const { key, value: binding } = selectBinding(channel, options.bindingPrefix);
  const sessionsMap = readSessionsMap();
  const bindingsMap = readBindingsMap();
  const workingDirectory = resolveWorkingDirectory(threadId, options.cwd);
  const model = options.clearModel ? '' : (options.model ?? '');
  const sessionId = crypto.randomUUID();

  sessionsMap[sessionId] = {
    id: sessionId,
    working_directory: workingDirectory,
    model,
    sdk_session_id: threadId,
  };

  bindingsMap[key] = {
    ...binding,
    codepilotSessionId: sessionId,
    sdkSessionId: threadId,
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
    newCodepilotSessionId: sessionId,
    sdkSessionId: threadId,
    workingDirectory,
    model,
  };
}

function parseBindOptions(args) {
  const options = {
    channel: 'weixin',
    threadId: '',
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
      case '--thread-id':
        options.threadId = args[index + 1] || '';
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

function renderProjects(projects) {
  if (projects.length === 0) {
    return `No projects configured in ${PROJECTS_PATH}.`;
  }

  return [
    `Projects from ${PROJECTS_PATH}:`,
    ...projects.map((project) => `- ${project.id} | ${project.name} | ${project.cwd}`),
  ].join('\n');
}

function renderThreads(result) {
  if (result.threads.length === 0) {
    return `No threads found for project "${result.project.id}" (${result.project.cwd}).`;
  }

  return [
    `Threads for ${result.project.id} (${result.project.cwd}):`,
    ...result.threads.map((thread) => {
      const name = thread.threadName || '(untitled)';
      const updatedAt = thread.updatedAt || thread.metaTimestamp || 'unknown';
      return `- ${thread.id} | ${name} | ${updatedAt}`;
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
  ].join('\n');
}

function usage() {
  return [
    'Usage:',
    '  node scripts/codex-handoff.mjs projects [--json]',
    '  node scripts/codex-handoff.mjs threads <project-id> [limit] [--json]',
    '  node scripts/codex-handoff.mjs bind --channel weixin [--thread-id <id>] [--binding <binding-id-prefix>] [--cwd <path>] [--model <name>] [--clear-model] [--json]',
  ].join('\n');
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

    case 'threads': {
      const projectId = parsed.args[0];
      const limitRaw = parsed.args[1] || '20';
      const limit = Number.parseInt(limitRaw, 10);

      if (!projectId) {
        throw new Error('threads requires <project-id>.');
      }

      const result = listThreadsForProject(projectId, limit);
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(renderThreads(result));
      }
      return;
    }

    case 'bind': {
      const result = bindThreadToChannel(parseBindOptions(parsed.args));
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
