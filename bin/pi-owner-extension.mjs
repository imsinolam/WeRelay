import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

// This code runs inside the *visible* Pi TUI. It never opens a second Pi writer.
export default function (pi) {
  const managedEndpoint = process.env.WERELAY_PI_OWNER_SOCKET;
  const standalone = !managedEndpoint;
  if (standalone && process.platform === 'win32') return; // No safe native owner discovery on Windows yet.
  const token = standalone ? randomBytes(32).toString('hex') : process.env.WERELAY_PI_OWNER_TOKEN;
  if (!token) return;
  const directory = process.env.WERELAY_PI_OWNER_DIRECTORY || path.join(os.homedir(), '.werelay', 'runtime', 'pi-owners');
  const advertisement = path.join(directory, `${process.pid}.json`);
  const endpoint = standalone ? path.join(directory, `${process.pid}.sock`) : managedEndpoint;
  let server;
  let socket;
  let buffer = '';
  let context;
  let outcome = 'completed';
  let authenticated = !standalone;
  let closing = false;
  let switchingModel = false;
  let run = null;
  const sessionId = () => context?.sessionManager.getSessionId();
  const send = (value) => {
    if (socket && !socket.destroyed && authenticated) socket.write(`${JSON.stringify({ ...value, token })}\n`);
  };
  const advertise = () => {
    if (!standalone || !server?.listening || !sessionId() || closing) return;
    const record = JSON.stringify({ pid: process.pid, cwd: process.cwd(), sessionId: sessionId(), socket: endpoint, token });
    const temporary = `${advertisement}.tmp`;
    fs.writeFileSync(temporary, record, { mode: 0o600 });
    fs.renameSync(temporary, advertisement);
  };
  const cleanup = () => {
    if (closing) return;
    closing = true;
    socket?.destroy();
    server?.close();
    if (standalone) {
      try {
        if (JSON.parse(fs.readFileSync(advertisement, 'utf8')).token === token) fs.unlinkSync(advertisement);
      } catch { /* Already removed or replaced. */ }
      try { fs.unlinkSync(endpoint); } catch { /* Already removed. */ }
    }
  };
  const thinkingLabels = { off: '关闭推理', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };
  const thinkingOptions = (model) => model?.reasoning
    ? Object.keys(thinkingLabels).filter((level) => {
        const mapped = model.thinkingLevelMap?.[level];
        return mapped !== null && (!['xhigh', 'max'].includes(level) || mapped !== undefined);
      }).map((id) => ({ id, label: thinkingLabels[id] })) : [];
  const modelState = () => {
    const current = context?.model;
    const scoped = context?.scopedModels;
    const available = Array.isArray(scoped) && scoped.length
      ? scoped.map((entry) => entry.model)
      : context?.modelRegistry?.getAvailable?.() || [];
    const seen = new Set();
    const options = available.slice(0, 500).flatMap((model) => {
      if (!model?.provider || !model?.id) return [];
      const id = `${model.provider}/${model.id}`;
      if (id.length > 240 || seen.has(id)) return [];
      seen.add(id);
      return [{ id, label: String(model.name || model.id).slice(0, 160), group: model.provider.slice(0, 80), reasoningEffortOptions: thinkingOptions(model) }];
    });
    const idle = Boolean(context?.isIdle?.()) && !context?.hasPendingMessages?.() && !switchingModel;
    return {
      ...(current?.provider && current?.id ? { currentModel: `${current.provider}/${current.id}` } : {}),
      options, canChange: idle && options.length > 0,
      currentReasoningEffort: pi.getThinkingLevel?.() ?? context?.thinkingLevel,
      reasoningEffortOptions: thinkingOptions(current),
      canChangeReasoningEffort: idle && Boolean(current?.reasoning) && typeof pi.setThinkingLevel === 'function',
      reasoningEffortUnavailableReason: !idle ? 'Pi 正在运行，请完成后再调整推理强度。'
        : !current?.reasoning ? '当前模型不支持推理强度设置。' : undefined,
      ...(!idle ? { unavailableReason: 'Pi 正在运行，请完成后再切换模型。' }
        : options.length === 0 ? { unavailableReason: 'Pi 当前没有可用的模型，请先在电脑端配置。' } : {}),
    };
  };
  const handleRequest = async (request, peer) => {
    if (request?.token !== token || typeof request.id !== 'string') { peer.destroy(); return; }
    if (request.sessionId !== sessionId()) {
      send({ type: 'response', id: request.id, ok: false, error: 'Pi 当前任务已切换，请刷新任务状态。' });
      return;
    }
    try {
      if (request.type === 'can_switch') {
        const safe = context.isIdle() && !context.ui.getEditorText().trim();
        send({ type: 'response', id: request.id, ok: safe,
          ...(!safe ? { error: context.isIdle() ? 'Pi 编辑区有尚未发送的内容。' : 'Pi 正在运行。' } : {}) });
      } else if (request.type === 'prompt' && typeof request.text === 'string' && request.text.trim()) {
        if (switchingModel) throw new Error('Pi 正在切换模型，请稍后发送消息。');
        const queued = !context.isIdle();
        pi.sendUserMessage(request.text, queued ? { deliverAs: 'followUp' } : undefined);
        send({ type: 'response', id: request.id, ok: true, queued });
      } else if (request.type === 'model_state') {
        send({ type: 'response', id: request.id, ok: true, modelState: modelState() });
      } else if (request.type === 'set_model' && typeof request.model === 'string') {
        const state = modelState();
        if (!state.canChange) throw new Error(state.unavailableReason || 'Pi 当前无法切换模型。');
        const selected = (context.scopedModels?.length
          ? context.scopedModels.map((entry) => entry.model)
          : context.modelRegistry.getAvailable()
        ).find((model) => `${model.provider}/${model.id}` === request.model);
        if (!selected) throw new Error('Pi 当前没有提供所选模型，请刷新列表。');
        switchingModel = true;
        try {
          if (!await pi.setModel(selected)) throw new Error('Pi 尚未配置该模型的认证，请在电脑端完成配置。');
        } finally { switchingModel = false; }
        send({ type: 'response', id: request.id, ok: true, modelState: modelState() });
      } else if (request.type === 'set_reasoning' && typeof request.model === 'string') {
        const state = modelState();
        if (!state.canChangeReasoningEffort) throw new Error(state.reasoningEffortUnavailableReason || '请在 Pi 原窗口执行 /reload 更新扩展。');
        if (!state.reasoningEffortOptions.some((entry) => entry.id === request.model)) throw new Error('当前模型不支持该推理强度，请刷新列表。');
        pi.setThinkingLevel(request.model);
        if (pi.getThinkingLevel() !== request.model) throw new Error('Pi 未接受该推理强度，请刷新列表。');
        send({ type: 'response', id: request.id, ok: true, modelState: modelState() });
      } else if (request.type === 'abort') {
        context.abort();
        send({ type: 'response', id: request.id, ok: true });
      } else {
        send({ type: 'response', id: request.id, ok: false, error: 'Unsupported Pi owner request.' });
      }
    } catch (error) {
      send({ type: 'response', id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const accept = (peer) => {
    if (socket && !socket.destroyed) { peer.destroy(); return; }
    socket = peer;
    buffer = '';
    authenticated = !standalone;
    peer.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 128 * 1024) { peer.destroy(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let request;
        try { request = JSON.parse(line); } catch { peer.destroy(); return; }
        if (!authenticated) {
          if (request?.type !== 'hello' || request.token !== token) { peer.destroy(); return; }
          authenticated = true;
          send({ type: 'ready', sessionId: sessionId(), run });
          continue;
        }
        void handleRequest(request, peer);
      }
    });
    peer.on('error', () => {});
    peer.on('close', () => { if (socket === peer) socket = undefined; });
    if (!standalone) send({ type: 'ready', sessionId: sessionId(), run });
  };
  const connect = () => {
    if (socket && !socket.destroyed) return;
    const next = net.createConnection(endpoint);
    next.on('connect', () => accept(next));
    next.on('error', () => {});
  };
  const listen = () => {
    if (server) return;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) return;
    if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
    // A socket with this PID may still belong to a live extension during a
    // concurrent reload. Never unlink it and create two owners by accident.
    if (fs.existsSync(endpoint)) return;
    server = net.createServer(accept);
    server.on('error', cleanup);
    server.listen(endpoint, () => {
      if (process.platform !== 'win32') fs.chmodSync(endpoint, 0o600);
      advertise();
    });
  };
  pi.on('session_start', (_event, ctx) => {
    context = ctx;
    run = ctx.isIdle() ? null : { status: 'running', startedAtMs: Date.now() };
    if (standalone) { listen(); advertise(); }
    else { connect(); send({ type: 'session', sessionId: sessionId() }); }
  });
  pi.on('agent_start', () => {
    outcome = 'completed';
    run = { status: 'running', startedAtMs: Date.now() };
    send({ type: 'agent_start', sessionId: sessionId(), run });
  });
  pi.on('agent_before_settle', (event) => { outcome = event.outcome || 'completed'; });
  pi.on('message_end', (event) => {
    const message = event.message;
    if (message?.role !== 'assistant') return;
    if (message.stopReason === 'error') {
      send({ type: 'assistant_error', sessionId: sessionId(),
        error: typeof message.errorMessage === 'string' ? message.errorMessage.slice(0, 300) : '' });
      return;
    }
    const text = Array.isArray(message.content)
      ? message.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n') : '';
    if (text) send({ type: 'assistant', sessionId: sessionId(), text });
  });
  pi.on('agent_settled', () => {
    run = { status: outcome === 'aborted' ? 'interrupted' : outcome === 'error' ? 'failed' : 'completed',
      startedAtMs: run?.startedAtMs || Date.now(), completedAtMs: Date.now() };
    send({ type: 'settled', sessionId: sessionId(), outcome, run });
  });
  pi.on('session_shutdown', (event) => {
    if (event.reason === 'quit' || event.reason === 'reload') cleanup();
  });
}
