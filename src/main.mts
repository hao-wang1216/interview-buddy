import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, session, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { InterviewAgent, testConnection } from './agent.mjs';
import { readDocument } from './documents.mjs';
import { applicationStatuses, documentKinds, factKinds, rank, Store } from './storage.mjs';
import type { ApplicationRecord, DocumentKind, FactKind, FactStatus } from './storage.mjs';
import { defaultPreferences } from './preparation-skills.mjs';
import type { Preferences } from './preparation-skills.mjs';
import { installLiveWindow } from './live-window.mjs';
import { consultationTools, readConsultationSkill } from './consultation-skills.mjs';
import { publicWebUrl } from './web-search.mjs';

const ui = new URL('../ui/', import.meta.url);
const defaultModel = 'deepseek-flash';
protocol.registerSchemesAsPrivileged([{ scheme: 'buddy-live', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

function value(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数无效。');
  return input as Record<string, unknown>;
}
function text(input: unknown, limit: number, optional = false) {
  if (typeof input !== 'string' || (!input.trim() && !optional) || input.length > limit) throw new Error('输入为空或超出长度限制。');
  return input.trim();
}
function id(input: unknown) {
  const result = text(input, 36);
  if (!/^[\da-f-]{36}$/i.test(result)) throw new Error('记录标识无效。');
  return result;
}
function settingModel(input: unknown) {
  const result = text(input, 80);
  if (!/^[a-z\d][a-z\d._-]*$/i.test(result)) throw new Error('请输入有效的模型名称。');
  return result;
}

async function readSettings(path: string) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { model?: string; encrypted?: string; preferences?: Preferences };
    return { model: raw.model || defaultModel, encrypted: raw.encrypted || '', preferences: raw.preferences ?? defaultPreferences };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { model: defaultModel, encrypted: '', preferences: defaultPreferences };
  }
}

async function start() {
  const data = app.getPath('userData');
  await mkdir(data, { recursive: true });
  const configPath = join(data, 'settings.json');
  let config = await readSettings(configPath);
  const store = new Store(join(data, 'interview-buddy.sqlite'));
  let current: BrowserWindow | undefined;
  let operation: AbortController | undefined;
  const getKey = () => config.encrypted ? safeStorage.decryptString(Buffer.from(config.encrypted, 'base64')) : '';
  const info = () => ({ model: config.model, configured: Boolean(config.encrypted), dataPath: data, preferences: config.preferences });
  const agent = new InterviewAgent(store, () => ({ key: getKey(), model: config.model }), () => config.preferences);
  const live = installLiveWindow(ui, store, agent, () => config.preferences, () => {
    if (current && !current.isDestroyed()) current.webContents.send('live:changed');
  }, () => {
    if (current && !current.isDestroyed() && current.isMinimized()) current.restore();
  });

  function handle(channel: string, handler: (input: unknown, event: IpcMainInvokeEvent) => unknown) {
    ipcMain.handle(channel, (event, input: unknown) => {
      if (event.sender !== current?.webContents || event.senderFrame !== event.sender.mainFrame) {
        throw new Error('当前页面无权执行此操作。');
      }
      return handler(input, event);
    });
  }

  async function run<T>(task: (signal: AbortSignal) => Promise<T>) {
    if (operation) throw new Error('请先等待当前操作完成。');
    const controller = new AbortController();
    operation = controller;
    try { return await task(AbortSignal.any([controller.signal, AbortSignal.timeout(120000)])); }
    catch (error) {
      if (controller.signal.aborted) throw new Error('已取消。');
      throw error;
    } finally { operation = undefined; }
  }

  handle('settings:info', info);
  handle('settings:save', async input => {
    const request = value(input);
    const model = settingModel(request.model);
    const key = text(request.key, 512, true);
    const preference = request.preferences === undefined ? config.preferences : value(request.preferences);
    const language = text(preference.language, 20) as Preferences['language'];
    if (!['zh-CN', 'en-US', 'follow-question'].includes(language)) throw new Error('面试语言无效。');
    const preferences = { language, style: text(preference.style, 300, true) };
    if (key && !/^[!-~]+$/.test(key)) throw new Error('API Key 格式无效。');
    if (key && !safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法加密保存 API Key。');
    const encrypted = request.clear === true ? '' : key ? safeStorage.encryptString(key).toString('base64') : config.encrypted;
    const pending = configPath + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(pending, JSON.stringify({ model, encrypted, preferences }), { flag: 'wx' });
      await rename(pending, configPath);
    } finally { await rm(pending, { force: true }); }
    config = { model, encrypted, preferences };
    return info();
  });
  handle('settings:test', input => {
    const request = value(input);
    return testConnection(text(request.key, 512, true) || getKey(), settingModel(request.model), AbortSignal.timeout(12000));
  });
  handle('documents:list', () => store.documents());
  handle('documents:import', async input => {
    const kind = text(input, 10) as DocumentKind;
    if (!documentKinds.includes(kind)) throw new Error('资料类型无效。');
    const selected = await dialog.showOpenDialog(current!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '面试资料', extensions: ['txt', 'md', 'pdf'] }],
    });
    if (selected.canceled) return { added: 0, duplicates: 0, failed: [] };
    let added = 0;
    let duplicates = 0;
    const failed = [];
    for (const path of selected.filePaths) {
      try {
        const doc = await readDocument(path);
        const result = store.importDocument(basename(path), kind, doc.bytes, doc.pages);
        if (result.duplicate) duplicates++;
        else added++;
      } catch (error) { failed.push(basename(path) + '：' + (error as Error).message); }
    }
    return { added, duplicates, failed };
  });
  handle('documents:passages', input => store.passages(id(input)).slice(0, 40));
  handle('documents:search', input => rank(text(input, 400), store.passages(), item => item.name + ' ' + item.text, 10));
  handle('documents:delete', input => store.deleteDocument(id(input)));
  handle('facts:list', () => store.facts());
  handle('facts:draft', input => run(signal => agent.draft(id(input), signal)));
  handle('facts:add', input => {
    const request = value(input);
    const kind = text(request.kind, 16) as FactKind;
    if (!factKinds.includes(kind)) throw new Error('事实类别无效。');
    return store.saveDrafts([{ passageId: id(request.passageId), text: text(request.text, 500), kind }]);
  });
  handle('facts:update', input => {
    const request = value(input);
    store.updateFact(id(request.id), text(request.text, 500), text(request.status, 10) as FactStatus);
  });
  handle('sessions:list', () => store.sessions());
  handle('sessions:get', input => store.session(id(input)));
  handle('sessions:create', input => store.createSession(text(input, 100)));
  handle('sessions:delete', input => {
    const record = id(input);
    if (live.isActiveSession(record)) throw new Error('请先关闭实时面试悬浮窗，并等转写保存完成。');
    store.deleteSession(record);
  });
  handle('live:open', () => { if (live.show()) current?.minimize(); });
  handle('sessions:prepare', input => run(signal => agent.prepare(id(input), signal)));
  handle('sessions:consultation-tools', () => consultationTools);
  handle('sessions:open-source', input => {
    const url = publicWebUrl(input);
    if (!url) throw new Error('网页来源链接无效。');
    return shell.openExternal(url);
  });
  handle('sessions:answer', (input, event) => {
    const request = value(input);
    const requestId = id(request.requestId);
    const sessionId = request.id === undefined ? undefined : id(request.id);
    const skill = readConsultationSkill(request.skill);
    return run(signal => agent.answer(sessionId, text(request.question, 4000), 'manual', signal, chunk => {
      if (!event.sender.isDestroyed()) event.sender.send('sessions:delta', { requestId, chunk });
    }, skill, (index, trace) => {
      if (!event.sender.isDestroyed()) event.sender.send('sessions:tool', { requestId, index, trace });
    }));
  });
  handle('applications:list', () => store.applications());
  handle('applications:statuses', () => applicationStatuses);
  handle('applications:save', input => {
    const request = value(input);
    const interviewDate = text(request.interviewDate, 10);
    const parsed = new Date(interviewDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(interviewDate) || !Number.isFinite(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== interviewDate) throw new Error('面试日期无效。');
    const status = text(request.status, 20) as ApplicationRecord['status'];
    if (!applicationStatuses.includes(status)) throw new Error('求职状态无效。');
    store.saveApplication({
      company: text(request.company, 100), position: text(request.position, 120), interviewDate,
      round: text(request.round, 60), status, notes: text(request.notes, 2000, true),
    }, request.id === undefined ? undefined : id(request.id));
    return store.applications();
  });
  handle('applications:delete', input => {
    store.deleteApplication(id(input));
    return store.applications();
  });
  handle('sessions:review', input => run(signal => agent.review(id(input), signal)));
  handle('sessions:cancel', () => { operation?.abort(); });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  function createWindow() {
    current = new BrowserWindow({
      width: 1200, height: 820, minWidth: 700, minHeight: 540,
      backgroundColor: '#181818', show: false, autoHideMenuBar: true,
      webPreferences: {
        preload: fileURLToPath(new URL('preload.cjs', ui)), contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    current.setMenu(null);
    current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    current.webContents.on('will-navigate', event => event.preventDefault());
    current.once('ready-to-show', () => current?.show());
    current.on('closed', () => { operation?.abort(); current = undefined; });
    void current.loadFile(fileURLToPath(new URL('index.html', ui)));
  }
  createWindow();
  app.on('second-instance', () => {
    if (!current) { createWindow(); return; }
    if (current?.isMinimized()) current.restore();
    current?.focus();
  });
  app.on('activate', () => { if (!current) createWindow(); });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') void Promise.resolve(live.finish()).finally(() => {
      if (!BrowserWindow.getAllWindows().length) app.quit();
    });
  });
  app.once('will-quit', () => { live.close(); store.close(); });
}
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(start).catch(error => {
  dialog.showErrorBox('面试搭子启动失败', (error as Error).message);
  app.quit();
});
