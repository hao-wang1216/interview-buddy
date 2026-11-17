import { BrowserWindow, desktopCapturer, ipcMain, net, screen, session } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { fileURLToPath } from 'node:url';
import type { InterviewAgent } from './agent.mjs';
import type { Preferences } from './preparation-skills.mjs';
import { frameBytes, LiveSpeech } from './speech.mjs';
import type { AudioSource } from './speech.mjs';
import type { Store } from './storage.mjs';

const minWidth = 320;
const minHeight = 360;

export function installLiveWindow(ui: URL, store: Store, agent: InterviewAgent,
                                  preferences: () => Preferences, changed: () => void, onClosed: () => void) {
  const partition = session.fromPartition('buddy-live-overlay');
  const files = new Set(['/live.html', '/live.js', '/live.css', '/pcm-worklet.js']);
  partition.protocol.handle('buddy-live', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'overlay' || !files.has(url.pathname)) return new Response(null, { status: 404 });
    return net.fetch(new URL(url.pathname.slice(1), ui).href);
  });

  let window: BrowserWindow | undefined;
  let speech: LiveSpeech | undefined;
  let recording = false;
  let finishing: Promise<void> | undefined;
  let finishingId: string | undefined;
  let sessionId: string | undefined;
  let answer: AbortController | undefined;
  const newSession = () => store.createSession('实时面试 · ' +
    new Date().toLocaleString('zh-CN', { hour12: false }), 'live').id;
  const notify = (channel: string, payload: unknown) => {
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };

  partition.setPermissionRequestHandler((contents, permission, respond, details) => {
    respond(contents === window?.webContents && details.isMainFrame &&
      (permission === 'display-capture' || (permission === 'media' &&
        'mediaTypes' in details && details.mediaTypes?.every(type => type === 'audio') === true)));
  });
  partition.setPermissionCheckHandler((contents, permission, origin, details) =>
    contents === window?.webContents && /^buddy-live:\/\/overlay\/?$/.test(origin) &&
    (permission === 'display-capture' || (permission === 'media' && details.mediaType !== 'video')));
  partition.setDisplayMediaRequestHandler((request, respond) => {
    const overlay = window;
    if (!overlay || request.frame !== overlay.webContents.mainFrame || !request.audioRequested || !request.userGesture) {
      respond(null);
      return;
    }
    void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then(sources => {
      if (window !== overlay || overlay.isDestroyed()) { respond(null); return; }
      const display = screen.getDisplayMatching(overlay.getBounds());
      const source = sources.find(item => item.display_id === String(display.id)) ?? sources[0];
      respond(source ? { video: source, audio: 'loopback' } : null);
    }, () => respond(null));
  });

  function handle(channel: string, handler: (input: unknown) => unknown) {
    ipcMain.handle(channel, (event, input: unknown) => {
      if (!allowed(event)) throw new Error('当前页面无权执行此操作。');
      return handler(input);
    });
  }
  function allowed(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>) {
    return window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === event.sender.mainFrame;
  }

  function finish() {
    recording = false;
    if (finishing) return finishing;
    const worker = speech;
    if (!worker) return;
    finishingId = sessionId;
    const timer = setTimeout(() => {
      notify('live:warning', '已保存完成的转写。剩余音频处理超时。');
      worker.close();
    }, 10000);
    finishing = worker.finish().finally(() => {
      clearTimeout(timer);
      if (speech === worker) speech = undefined;
      finishing = undefined;
      finishingId = undefined;
      changed();
    });
    return finishing;
  }

  handle('live:start', async () => {
    if (speech || finishing || answer) throw new Error('请等待当前操作完成。');
    const language = preferences().language;
    const overlay = window;
    let id: string | undefined;
    const worker = new LiveSpeech(fileURLToPath(new URL('../.runtime/speech/', ui)),
      fileURLToPath(new URL('../workers/transcribe.py', ui)), language === 'zh-CN' ? 'zh' : language === 'en-US' ? 'en' : null,
      (source, text, offsetMs) => {
        if (speech === worker && id) notify('live:transcript', store.addTranscript(id, source, text, offsetMs));
      },
      message => { if (speech === worker) notify('live:warning', message); });
    speech = worker;
    try {
      await worker.ready;
      if (speech !== worker || overlay !== window || !overlay || overlay.isDestroyed()) throw new Error('实时语音已取消。');
      id = newSession();
      sessionId = id;
      recording = true;
      changed();
    } catch (error) {
      worker.close();
      if (speech === worker) speech = undefined;
      throw error;
    }
  });
  ipcMain.on('live:pcm', (event, source: AudioSource, frame: unknown) => {
    if (recording && allowed(event) && (source === 'microphone' || source === 'system') &&
      frame instanceof Uint8Array && frame.byteLength === frameBytes) speech?.send(source, frame);
  });
  handle('live:finish', finish);
  handle('live:pin', input => {
    window?.setAlwaysOnTop(input === true);
    return window?.isAlwaysOnTop() ?? false;
  });
  handle('live:hide-in-share', input => {
    const overlay = window!;
    if (typeof input !== 'boolean') throw new Error('共享可见性设置无效。');
    overlay.setContentProtection(input);
    return overlay.isContentProtected();
  });
  handle('live:resize', input => {
    const overlay = window!;
    if (!Array.isArray(input) || input.length !== 2 || !input.every(Number.isFinite)) {
      throw new Error('悬浮窗尺寸无效。');
    }
    const bounds = overlay.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const width = Math.max(minWidth, Math.min(Math.round(input[0]), area.x + area.width - bounds.x));
    const height = Math.max(minHeight, Math.min(Math.round(input[1]), area.y + area.height - bounds.y));
    if (bounds.width !== width || bounds.height !== height) overlay.setSize(width, height);
  });
  handle('live:answer', async input => {
    if (answer) throw new Error('正在生成回答。');
    if (typeof input !== 'string' || !input.trim() || input.length > 1200) throw new Error('请输入要回答的问题。');
    sessionId ??= newSession();
    const controller = new AbortController();
    answer = controller;
    try {
      return await agent.answer(sessionId, input.trim(), 'live',
        AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
        chunk => { if (!controller.signal.aborted) notify('live:delta', chunk); });
    } catch (error) {
      if (controller.signal.aborted) throw new Error('已取消生成。');
      throw error;
    } finally {
      if (answer === controller) answer = undefined;
      changed();
    }
  });
  handle('live:cancel', () => { answer?.abort(); });
  handle('live:close', () => { window?.close(); });

  return {
    show() {
      if (window) {
        if (window.isMinimized()) window.restore();
        window.focus();
        return false;
      }
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const width = Math.min(1160, Math.round(area.width * 0.94));
      const height = Math.min(740, Math.round(area.height * 0.9));
      const overlay = window = new BrowserWindow({
        title: '面试搭子 · 实时面试', width, height,
        x: area.x + Math.round((area.width - width) / 2), y: area.y + 16, minWidth, minHeight,
        frame: false, transparent: true, backgroundColor: '#00000000',
        resizable: true,
        alwaysOnTop: true, autoHideMenuBar: true, show: false,
        webPreferences: {
          session: partition, preload: fileURLToPath(new URL('live-preload.cjs', ui)),
          contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
        },
      });
      overlay.setContentProtection(true);
      overlay.setMenu(null);
      overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      overlay.webContents.on('will-navigate', event => event.preventDefault());
      overlay.once('ready-to-show', () => { if (!overlay.isDestroyed()) overlay.show(); });
      overlay.on('closed', () => {
        window = undefined;
        answer?.abort();
        if (recording) void finish();
        else if (!finishing) { speech?.close(); speech = undefined; }
        sessionId = undefined;
        onClosed();
      });
      void overlay.loadURL('buddy-live://overlay/live.html');
      return true;
    },
    close() {
      recording = false;
      answer?.abort();
      speech?.close();
      speech = undefined;
    },
    isActiveSession(id: string) { return id === sessionId || id === finishingId; },
    finish,
  };
}
