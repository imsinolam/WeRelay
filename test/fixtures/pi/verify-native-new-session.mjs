// Manual, isolated integration check. Pass the installed Pi SDK file URL:
// node --experimental-strip-types test/fixtures/pi/verify-native-new-session.mjs <sdk-url>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { PiOwnerAdapter } from '../../../src/bridge/bridge-adapters.pi.ts';

const sdk = await import(process.argv[2]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-real-new-'));
const agent = path.join(root, 'agent');
const project = path.join(root, 'project');
const owners = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-'));
fs.mkdirSync(path.join(agent, 'extensions'), { recursive: true });
fs.mkdirSync(project);
fs.chmodSync(owners, 0o700);
fs.copyFileSync(new URL('../../../bin/pi-owner-extension.mjs', import.meta.url), path.join(agent, 'extensions', 'werelay-owner.js'));
fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
  api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'not-a-real-key',
  models: ['before', 'after'].map(id => ({ id, reasoning: true, input: ['text'], contextWindow: 32000, maxTokens: 1000 })),
} } }));
fs.writeFileSync(path.join(agent, 'settings.json'), '{}');
fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
process.env.WERELAY_PI_OWNER_DIRECTORY = owners;
process.env.PI_CODING_AGENT_DIR = agent;
let calls = 0;
globalThis.fetch = async () => { calls++; throw new Error('network forbidden'); };
const adapter = new PiOwnerAdapter({ kind: 'pi', cwd: project, command: 'must-not-spawn', renderMode: 'headless' });
let host;
const wait = async (condition) => {
  const end = Date.now() + 8000;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
try {
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: path.join(agent, 'auth.json'), modelsPath: path.join(agent, 'models.json'), allowModelNetwork: false,
  });
  const factory = async options => {
    const services = await sdk.createAgentSessionServices({ ...options, modelRuntime,
      resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true } });
    const result = await sdk.createAgentSessionFromServices({ ...options, services,
      model: modelRuntime.getModel('fixture', 'before'), noTools: 'all' });
    return { ...result, services, diagnostics: [] };
  };
  host = await sdk.createAgentSessionRuntime(factory, {
    cwd: project, agentDir: agent, sessionManager: sdk.SessionManager.create(project, path.join(agent, 'sessions')),
  });
  const bind = async () => host.session.bindExtensions({
    mode: 'tui', uiContext: { getEditorText: () => '', setStatus: () => {}, notify: () => {} },
    commandContextActions: { waitForIdle: () => host.session.waitForIdle(), newSession: options => host.newSession(options) },
    abortHandler: () => host.session.abort(), onError: event => { throw new Error(event.error); },
  });
  host.setRebindSession(bind);
  await bind();
  const ads = () => fs.readdirSync(owners).filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(owners, name))));
  await wait(() => ads().length === 1 && (fs.statSync(ads()[0].socket).mode & 0o077) === 0);
  const oldId = host.session.sessionId;
  await adapter.start();
  const models = await adapter.getNewSessionModelState();
  assert.equal(models.canChange, true);
  assert.ok(models.options.some(option => option.id === 'fixture/after'));
  assert.equal(adapter.getState().sharedSessionId, undefined);
  await adapter.createSession();
  const newId = adapter.getState().sharedSessionId;
  assert.notEqual(newId, oldId);
  assert.equal(host.session.sessionId, newId);
  await wait(() => ads().length === 1 && ads()[0].sessionId === newId);
  // Settings reach the fresh extension, not the invalidated previous context.
  assert.equal((await adapter.setSessionModel(newId, 'fixture/after')).currentModel, 'fixture/after');
  assert.equal((await adapter.setSessionReasoningEffort(newId, 'low')).currentReasoningEffort, 'low');
  assert.equal(host.session.model.id, 'after');
  assert.equal(calls, 0);
  assert.equal(host.session.messages.length, 0);
  console.log(JSON.stringify({ realPiSdk: sdk.VERSION, newSessionConfirmed: true, sameRuntimeHost: true,
    freshExtensionSettingsApplied: true, staleOwnerCleaned: true, modelNetworkCalls: calls, userMessages: 0 }));
} finally {
  await adapter.dispose();
  await host?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(owners, { recursive: true, force: true });
}
