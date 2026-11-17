import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../dist/storage.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, '.test-output');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(output, 'desktop-'));
const executable = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const store = new Store(join(profile, 'interview-buddy.sqlite'));
const sample = '我负责用 SAM2 实现水下目标分割，并对比不同模型的推理耗时。';
store.importDocument('验收简历.md', 'resume', Buffer.from(sample), [{ page: 2, text: sample }]);
const old = store.createSession('旧模拟记录');
store.addTurn(old.id, '你负责什么？', '我主要负责水下目标分割。', '补充验证过程。', 'simulation');
const traceSession = store.createSession('工具调用验收');
store.addTurn(traceSession.id, '这个项目会被怎样追问？', '先说明方案的边界。', null, 'manual', [
  { label: '检索个人知识库', state: 'done', detail: '找到 1 条已确认经历。' },
  { label: '技术追问', state: 'done', detail: '已加载技术追问的指导步骤。' },
]);
store.addTurn(traceSession.id, '请查一下岗位信息。', '请查看招聘官网。[网页1]', null, 'manual', [
  { label: '联网搜索', state: 'done', detail: '找到 1 条网页来源。',
    sources: [{ number: 1, title: '招聘官网', url: 'https://example.com/careers', date: '2026-11-16' }] },
]);
store.close();

let app;
let connection;
let stderr = '';
let exited;
let launchError;
let port;

async function until(predicate, label, timeout = 18000) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) {
    if (launchError) throw launchError;
    if (app.exitCode !== null) throw new Error('Electron exited: ' + app.exitCode);
    const result = await predicate();
    if (result) return result;
    await sleep(100);
  }
  throw new Error('Timed out: ' + label);
}

async function open() {
  launchError = undefined;
  stderr = '';
  app = spawn(executable, [root, '--remote-debugging-port=0', '--user-data-dir=' + profile], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  exited = new Promise(done => app.once('exit', done));
  app.on('error', error => { launchError = error; });
  app.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-3000); });
  port = await until(async () => {
    try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf-8')).trim().split(/\r?\n/)[0]; }
    catch { return undefined; }
  }, 'debugging port');
  await connectTarget(url => url.endsWith('/ui/index.html'));
  await until(() => evaluate("Boolean(window.buddy && document.querySelector('#chat-scroll'))"), 'document and preload');
}

async function connectTarget(match) {
  const page = await until(async () => {
    try {
      const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      return targets.find(item => item.type === 'page' && match(item.url));
    } catch { return undefined; }
  }, 'application page');
  connection?.close();
  connection = new WebSocket(page.webSocketDebuggerUrl);
  await Promise.race([once(connection, 'open'), sleep(5000).then(() => { if (connection.readyState !== WebSocket.OPEN) throw new Error('Debugging socket unavailable.'); })]);
}

let callId = 0;
function call(method, params = {}) {
  const id = ++callId;
  return new Promise((complete, fail) => {
    const timeout = setTimeout(() => {
      connection.removeEventListener('message', receive);
      fail(new Error('Timed out: ' + method));
    }, 18000);
    function receive(event) {
      const payload = JSON.parse(event.data);
      if (payload.id !== id) return;
      clearTimeout(timeout);
      connection.removeEventListener('message', receive);
      if (payload.error) fail(new Error(payload.error.message));
      else complete(payload.result);
    }
    connection.addEventListener('message', receive);
    connection.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    .catch(error => { throw new Error('Desktop evaluation failed: ' + expression.slice(0, 180), { cause: error }); });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
const click = selector => evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()');
const waitText = value => until(() => evaluate('document.body?.innerText.includes(' + JSON.stringify(value) + ')'), value);
const expectedSpeech = process.env.BUDDY_TEST_EXPECTED?.trim();
const speechPattern = expectedSpeech ? new RegExp(RegExp.escape(expectedSpeech)) : /水下目[标標]/;
const waitSpeech = () => until(() => evaluate(speechPattern + '.test(document.body.innerText)'), 'Mandarin sample');
const input = (selector, text) => evaluate('document.querySelector(' + JSON.stringify(selector) + ').value=' + JSON.stringify(text));
const submit = selector => evaluate('document.querySelector(' + JSON.stringify(selector) + ').requestSubmit()');

async function close() {
  connection?.close();
  if (app && app.exitCode === null && !launchError) app.kill();
  if (exited) await Promise.race([exited, sleep(2300)]);
  await rm(join(profile, 'DevToolsActivePort'), { force: true });
}

try {
  await open();
  await waitText('面试搭子');
  assert.equal(await evaluate('getComputedStyle(document.documentElement).colorScheme'), 'light');
  assert.equal(await evaluate("document.querySelector('#reference-question').placeholder"), '问问面试搭子…');
  await click('#new-session');
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, 'desktop-home.png'), Buffer.from(screenshot.data, 'base64'));
  await click('button[data-page=library]');
  await waitText('验收简历.md');
  await click('#document-list .item button');
  await waitText('第 2 页');
  await click('#passage-view details summary');
  await click('#passage-view details button');
  await waitText('已加入档案');
  await click('#fact-list article button');
  await waitText('已保存确认的事实');
  await click('button[data-page=applications]');
  await click('#application-add');
  await input('#application-company', '验收科技');
  await input('#application-position', '算法工程师');
  await input('#application-date', '2026-11-16');
  await input('#application-round', '技术一面');
  await input('#application-notes', '回顾模型评估');
  await submit('#application-form');
  await waitText('验收科技');
  await click('#application-list button');
  await input('#application-status', '进入下一轮');
  await submit('#application-form');
  await waitText('进入下一轮');
  await input('#application-filter', '未通过');
  await evaluate("document.querySelector('#application-filter').dispatchEvent(new Event('change'))");
  await waitText('没有这个状态的记录');
  await click('#new-session');
  await click('#consult-tool-label');
  await evaluate("[...document.querySelectorAll('#consult-tool-options button')].find(button => button.textContent === 'STAR 故事').click()");
  assert.match(await evaluate("document.querySelector('#reference-question').value"), /STAR/);
  await click('#new-session');
  await input('#reference-question', '你是？');
  await evaluate("document.querySelector('#reference-question').dispatchEvent(new Event('input'))");
  await submit('#consult-form');
  await until(() => evaluate("document.querySelector('#practice-transcript .reply ol')?.children.length === 3"), 'consultation reply');
  assert.equal(await evaluate("document.querySelector('#page-title').textContent"), '你是？');
  assert.ok(await evaluate(`(() => {
    const question = document.querySelector('.turn-question');
    const reply = document.querySelector('.reply');
    const composer = document.querySelector('.composer');
    return question.getBoundingClientRect().left > reply.getBoundingClientRect().left &&
      composer.getBoundingClientRect().top >= document.querySelector('#chat-scroll').getBoundingClientRect().bottom;
  })()`));
  await input('#reference-question', '怎么使用？');
  await evaluate("document.querySelector('#reference-question').dispatchEvent(new Event('input'))");
  await submit('#consult-form');
  await until(() => evaluate("document.querySelectorAll('#practice-transcript .turn').length === 2"), 'follow-up');
  assert.equal(await evaluate("document.querySelector('#practice-notes').open"), false);
  await click('#practice-notes summary');
  await click('#prepare-plan');
  await waitText('准备计划已保存');
  await waitText('导入岗位描述');
  await click('#generate-review');
  await waitText('复盘已保存到面试记录');
  await click('#practice-notes summary');
  assert.equal(await evaluate('document.body.innerText.includes("导入岗位描述")'), false);
  const practice = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, 'desktop-practice.png'), Buffer.from(practice.data, 'base64'));

  await click('#open-live');
  await connectTarget(url => url === 'buddy-live://overlay/live.html');
  await waitText('实时转写');
  assert.ok(await evaluate(`(() => {
    const [transcript, answer] = document.querySelectorAll('.live-panel');
    return transcript.getBoundingClientRect().right < answer.getBoundingClientRect().left;
  })()`));
  assert.equal(await evaluate("document.querySelector('#pin').getAttribute('aria-pressed')"), 'true');
  await click('#pin');
  await waitText('置顶');
  await until(() => evaluate("document.querySelector('#pin').getAttribute('aria-pressed') === 'false'"), 'unpin');
  await click('#pin');
  const originalSize = await evaluate('[innerWidth, innerHeight]');
  const grip = await evaluate(`(() => {
    const target = document.querySelector('#resize-grip');
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...grip });
  const smaller = { x: grip.x - (originalSize[0] - 350), y: grip.y - (originalSize[1] - 380) };
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, ...smaller });
  try {
    await until(() => evaluate('innerWidth <= 360 && innerHeight <= 390'), 'resize by dragging', 3000);
  } catch (error) {
    const dragged = await evaluate('[innerWidth, innerHeight]');
    await evaluate('window.buddyLive.resize([350, 380])');
    await sleep(250);
    throw new Error('Initial size ' + originalSize + ', dragged ' + dragged + ', direct resize ' + await evaluate('[innerWidth, innerHeight]'), { cause: error });
  }
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...smaller });
  assert.ok(await evaluate(`(() => {
    const [transcript, answer] = document.querySelectorAll('.live-panel');
    const composer = document.querySelector('#question-form');
    const bar = document.querySelector('.live-bar');
    return transcript.getBoundingClientRect().bottom < answer.getBoundingClientRect().top &&
      composer.getBoundingClientRect().bottom <= answer.getBoundingClientRect().bottom &&
      bar.scrollWidth <= bar.clientWidth + 1;
  })()`));
  const compactOverlay = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, 'desktop-live-compact.png'), Buffer.from(compactOverlay.data, 'base64'));
  await evaluate('window.buddyLive.resize(' + JSON.stringify(originalSize) + ')');
  await until(() => evaluate('innerWidth >= ' + (originalSize[0] - 5)), 'resize back to wide');
  const hiddenInShare = () => evaluate("document.querySelector('#share-visibility').getAttribute('aria-pressed') === 'true'");
  assert.equal(await hiddenInShare(), true);
  const initialOverlay = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, 'desktop-live.png'), Buffer.from(initialOverlay.data, 'base64'));
  if (process.env.BUDDY_TEST_WAV) {
    const visibleInCapture = () => evaluate(`(async () => {
      const originalColor = document.body.style.backgroundColor;
      document.body.style.backgroundColor = 'rgb(255, 0, 255)';
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const video = document.createElement('video');
        video.muted = true;
        video.srcObject = stream;
        await video.play();
        await new Promise(resolve => setTimeout(resolve, 250));
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0);
        const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let markedPixels = 0;
        for (let offset = 0; offset < bytes.length; offset += 4) {
          if (bytes[offset] > 238 && bytes[offset + 1] < 24 && bytes[offset + 2] > 238) markedPixels++;
        }
        return markedPixels > 3000;
      } finally {
        stream?.getTracks().forEach(track => track.stop());
        document.body.style.backgroundColor = originalColor;
      }
    })()`);
    assert.equal(await visibleInCapture(), false, 'The overlay should be excluded from whole-screen capture.');
    await click('#share-visibility');
    await until(async () => !(await hiddenInShare()), 'enable sharing visibility');
    assert.equal(await visibleInCapture(), true, 'The overlay should appear after disabling capture protection.');
    await click('#share-visibility');
    await until(hiddenInShare, 'restore sharing protection');
    assert.equal(await visibleInCapture(), false, 'The overlay should be excluded again.');
    await click('#microphone');
    await click('#capture');
    try {
      await until(() => evaluate("document.querySelector('#capture-status').textContent === '监听中'"), 'system capture', 27000);
    } catch (error) { throw new Error(await evaluate("document.querySelector('#notice').textContent"), { cause: error }); }
    const sound = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(New-Object System.Media.SoundPlayer $env:BUDDY_TEST_WAV).PlaySync()'], { windowsHide: true, stdio: 'inherit' });
    const [code] = await once(sound, 'exit');
    assert.equal(code, 0);
    try { await waitSpeech(); }
    catch (error) {
      throw new Error(await evaluate("document.querySelector('#notice').textContent + '\\n' + document.querySelector('#transcript').innerText"), { cause: error });
    }
    assert.equal(await evaluate("document.querySelector('#capture-status').textContent"), '监听中');
    await click('#capture');
    await until(() => evaluate("document.querySelector('#capture-status').textContent === '待开始'"), 'finish');
    await click('#latest');
    assert.match(await evaluate("document.querySelector('#question').value"), speechPattern);
    const live = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(output, 'desktop-live.png'), Buffer.from(live.data, 'base64'));
    await click('#system');
    await click('#microphone');
    await click('#capture');
    try {
      await until(() => evaluate("document.querySelector('#capture-status').textContent === '监听中'"), 'microphone capture', 27000);
    } catch (error) { throw new Error(await evaluate("document.querySelector('#notice').textContent"), { cause: error }); }
    await click('#capture');
    await until(() => evaluate("document.querySelector('#capture-status').textContent === '待开始'"), 'microphone finish');
  }
  await call('Page.close');
  await connectTarget(url => url.endsWith('/ui/index.html'));
  if (process.env.BUDDY_TEST_WAV) {
    await click('button[data-page=history]');
    const selected = await evaluate(`(() => {
      const button = [...document.querySelectorAll('#history-list button')].find(el => /[1-9][0-9]* 条转写/.test(el.textContent));
      button?.click();
      return Boolean(button);
    })()`);
    assert.ok(selected);
    await waitText('实时转写');
    await click('#history-detail summary');
    await waitSpeech();
  }
  await click('#settings-open');
  await waitText('保存设置');
  const sampleKey = 'test-only-credential-never-sent';
  await input('#key', sampleKey);
  await input('#answer-style', '用 STAR 结构');
  await submit('#settings-form');
  await waitText('设置已保存');
  const config = await readFile(join(profile, 'settings.json'), 'utf8');
  assert.ok(!config.includes(sampleKey));
  await close();

  await open();
  await waitText('DeepSeek · 已配置');
  await click('button[data-page=history]');
  await evaluate("[...document.querySelectorAll('#history-list button')].find(el => el.textContent.includes('你是？')).click()");
  await waitText('本场复盘');
  await waitText('怎么使用？');
  await waitText('面试准备计划');
  await evaluate("[...document.querySelectorAll('#history-list button')].find(el => el.textContent.includes('旧模拟记录')).click()");
  await waitText('我主要负责水下目标分割');
  await evaluate("[...document.querySelectorAll('#history-list button')].find(el => el.textContent.includes('工具调用验收')).click()");
  await waitText('工具调用 · 2 步');
  await click('#history-detail .tool-trace summary');
  await waitText('找到 1 条已确认经历。');
  await waitText('已加载技术追问的指导步骤。');
  await evaluate("[...document.querySelectorAll('#history-detail summary')].find(el => el.textContent.includes('网页来源')).click()");
  await waitText('[网页1] 招聘官网');
  await click('button[data-page=applications]');
  const applicationsRow = await evaluate("document.querySelector('#application-list tr').innerText");
  assert.match(applicationsRow, /验收科技/);
  assert.match(applicationsRow, /进入下一轮/);
  await evaluate("window.confirm = () => true; document.querySelector('#application-list button.danger').click()");
  await waitText('添加第一条面试记录');
  await click('#settings-open');
  await waitText('保存设置');
  assert.equal(await evaluate("document.querySelector('#answer-style').value"), '用 STAR 结构');
  console.log('Desktop verified: original document excerpt, confirmed fact, consultation and follow-up, preparation plan, legacy simulation history, review and encrypted settings.');
  if (process.env.BUDDY_TEST_WAV) console.log('Verified: whole-screen capture exclusion, Windows loopback playback, local Mandarin transcription, question quoting, history, microphone initialization and pin control.');
} catch (error) {
  if (stderr) console.error(stderr);
  throw error;
} finally {
  await close();
  if (dirname(resolve(profile)) === resolve(output) && /^desktop-/.test(profile.split(/[\\/]/).at(-1))) {
    await rm(profile, { recursive: true, force: true, maxRetries: 2 });
  }
}
