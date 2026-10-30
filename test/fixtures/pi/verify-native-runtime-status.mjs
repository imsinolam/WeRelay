// Isolated real SDK acceptance, with no model/network requests or user data.
// node test/fixtures/pi/verify-native-runtime-status.mjs <installed-Pi-SDK-file-URL>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { listPiSessions } from '../../../src/bridge/pi-session-catalog.ts';
import { discoverPiOwners } from '../../../src/bridge/pi-owner-discovery.ts';
import { PiOwnerAdapter } from '../../../src/bridge/bridge-adapters.pi.ts';
import ownerExtension from '../../../bin/pi-owner-extension.mjs';

const sdkUrl = new URL(process.argv[2]);
const sdk = await import(sdkUrl.href);
const { AssistantMessageEventStream } = await import(new URL('../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js', sdkUrl));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-pi-real-status-'));
const owners = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-'));
const agent = path.join(root, 'agent');
const project = path.join(root, 'project');
const sessions = path.join(agent, 'sessions');
fs.mkdirSync(project);
fs.mkdirSync(agent);
fs.chmodSync(owners, 0o700);
fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
  api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-not-a-real-key',
  models: [{ id: 'fake', input: ['text'], contextWindow: 32000, maxTokens: 1000 }],
} } }));
fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_CODING_AGENT_SESSION_DIR = sessions;
process.env.WERELAY_PI_OWNER_DIRECTORY = owners;
delete process.env.WERELAY_PI_OWNER_SOCKET;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('network forbidden'); };
let releasePreparation;
let preparing;
const preparation = new Promise((resolve) => { preparing = resolve; });
const preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
let received;
const replyReady = new Promise((resolve) => { received = resolve; });
let stream;
let session;
const adapter = new PiOwnerAdapter({ kind: 'pi', cwd: project, command: 'must-not-spawn', renderMode: 'headless' });
const until = async (condition) => {
  const deadline = Date.now() + 4000;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const bounded = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), 4000);
    })]);
  } finally { clearTimeout(timer); }
};
try {
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: path.join(agent, 'auth.json'), modelsPath: path.join(agent, 'models.json'), allowModelNetwork: false,
  });
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd: project, agentDir: agent, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [ownerExtension, (pi) => { pi.on('before_agent_start', async () => {
      preparing();
      await preparationGate;
    }); }],
  });
  await resourceLoader.reload();
  ({ session } = await sdk.createAgentSession({ cwd: project, agentDir: agent, settingsManager, modelRuntime,
    model: modelRuntime.getModel('fixture', 'fake'), resourceLoader, noTools: 'all',
    sessionManager: sdk.SessionManager.create(project, sessions),
  }));
  await session.bindExtensions({ mode: 'rpc' });
  const id = session.sessionId;
  await until(() => discoverPiOwners().length === 1);
  await adapter.start();
  await adapter.resumeSession(id);
  session.agent.streamFunction = () => {
    stream = new AssistantMessageEventStream();
    received();
    return stream;
  };
  const running = session.prompt('fixture request');
  await bounded(Promise.race([preparation, running.then(() => { throw new Error('prompt ended before preparation'); })]), 'preparation');
  assert.equal(session.isIdle, false);
  assert.equal((await listPiSessions())[0].runtimeStatus.type, 'active');
  await until(() => adapter.getState().status === 'busy');
  releasePreparation();
  await bounded(Promise.race([replyReady, running.then(() => { throw new Error('prompt ended before stream'); })]), 'fake stream');
  assert.equal((await listPiSessions())[0].runtimeStatus.type, 'active');
  const reply = { role: 'assistant', content: [{ type: 'text', text: 'fixture finished' }],
    api: 'openai-completions', provider: 'fixture', model: 'fake', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  stream.push({ type: 'done', reason: 'stop', message: reply });
  stream.end(reply);
  await bounded(running, 'completion');
  await until(() => adapter.getState().status === 'idle');
  assert.equal((await listPiSessions())[0].runtimeStatus.type, 'idle');
  assert.equal((await listPiSessions())[0].sessionId, id);
  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ realPiSdk: sdk.VERSION, sameOwner: true,
    preparationRunning: true, modelLoopRunning: true, completionIdle: true, networkCalls }));
} finally {
  releasePreparation();
  await adapter.dispose();
  await session?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(owners, { recursive: true, force: true });
}
