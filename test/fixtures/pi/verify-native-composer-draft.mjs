// Isolated real Pi SDK + the real owner extension. No network, tools or user data.
// node test/fixtures/pi/verify-native-composer-draft.mjs <installed-Pi-SDK-file-URL>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { PiOwnerAdapter } from '../../../src/bridge/bridge-adapters.pi.ts';
import { discoverPiOwners } from '../../../src/bridge/pi-owner-discovery.ts';
import ownerExtension from '../../../bin/pi-owner-extension.mjs';
const sdkUrl = new URL(process.argv[2]);
const sdk = await import(sdkUrl.href);
const { AssistantMessageEventStream } = await import(new URL('../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js', sdkUrl));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-real-draft-'));
const owners = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-'));
const agent = path.join(root, 'agent');
const project = path.join(root, 'project');
fs.mkdirSync(agent); fs.mkdirSync(project); fs.chmodSync(owners, 0o700);
fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
  api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'not-a-real-key',
  models: [{ id: 'fake', input: ['text'], contextWindow: 32000, maxTokens: 1000 }],
} } }));
process.env.PI_CODING_AGENT_DIR = agent;
process.env.WERELAY_PI_OWNER_DIRECTORY = owners;
delete process.env.WERELAY_PI_OWNER_SOCKET;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('network forbidden'); };
let editor = '  Native unsent text\n\nKeep whitespace  ';
let session;
const adapter = new PiOwnerAdapter({ kind: 'pi', cwd: project, command: 'must-not-spawn', renderMode: 'headless' });
const until = async (condition) => {
  const deadline = Date.now() + 5000;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error('fixture condition timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
try {
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(agent, 'auth.json'), modelsPath: path.join(agent, 'models.json'), allowModelNetwork: false });
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd: project, agentDir: agent, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [ownerExtension],
  });
  await resourceLoader.reload();
  ({ session } = await sdk.createAgentSession({ cwd: project, agentDir: agent, settingsManager, modelRuntime,
    model: modelRuntime.getModel('fixture', 'fake'), resourceLoader, noTools: 'all',
    sessionManager: sdk.SessionManager.create(project, path.join(agent, 'sessions')),
  }));
  await session.bindExtensions({ mode: 'tui', uiContext: {
    getEditorText: () => editor, setEditorText: text => { editor = text; },
    setStatus: () => {}, notify: () => {},
  } });
  await until(() => discoverPiOwners().length === 1);
  const id = session.sessionId;
  await adapter.start();
  const read = await adapter.getSessionComposerDraft(id);
  assert.equal(adapter.getState().sharedSessionId, undefined); // no selection to read
  assert.equal(read.draft.text, editor);
  session.agent.streamFunction = () => {
    const stream = new AssistantMessageEventStream();
    const reply = { role: 'assistant', content: [{ type: 'text', text: 'fixture success' }], api: 'openai-completions', provider: 'fixture', model: 'fake', stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    globalThis.queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(reply); });
    return stream;
  };
  const result = await adapter.sendInputToSession(id, 'Edited from web\n\nStill complete', { composerDraftRevision: read.draft.revision, clientId: 'fixture-once' });
  assert.equal(result.queued, false);
  await until(() => session.messages.some(message => message.role === 'assistant'));
  assert.equal(editor, '');
  assert.equal((await adapter.getSessionComposerDraft(id)).draft, null);
  assert.equal(session.messages.filter(message => message.role === 'user').length, 1);
  assert.equal((await adapter.sendInputToSession(id, 'Edited from web\n\nStill complete', { composerDraftRevision: read.draft.revision, clientId: 'fixture-once' })).duplicate, true);
  assert.equal(session.messages.filter(message => message.role === 'user').length, 1);
  editor = 'A newer local draft';
  await assert.rejects(adapter.sendInputToSession(id, 'stale', { composerDraftRevision: read.draft.revision, clientId: 'fixture-stale' }), /草稿/);
  assert.equal(editor, 'A newer local draft');
  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ sdk: sdk.VERSION, readWithoutSelection: true, sameOwner: session.sessionId === id,
    editedMessageCount: 1, sentDraftCleared: true, duplicatePrevented: true, conflictPreserved: true, networkCalls }));
} finally {
  await adapter.dispose(); await session?.dispose();
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(owners, { recursive: true, force: true });
}
