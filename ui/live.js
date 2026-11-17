const api = window.buddyLive;
const $ = id => document.getElementById(id);
const labels = { system: '系统声音', microphone: '麦克风' };
const active = new Map();
let latest = '';
let context;
let phase = 'idle';
let generating = false;

function message(text, error = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
}
function errorText(error) {
  return String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
function update() {
  const idle = phase === 'idle';
  const listening = phase === 'listening';
  $('capture').disabled = listening ? false : !idle || generating || !Object.keys(labels).some(source => $(source).checked);
  $('capture').textContent = listening ? '停止监听' : '开始监听';
  $('capture-status').textContent = listening ? '监听中' :
    ({ idle: '待开始', starting: '正在启动…', stopping: '正在保存…' })[phase];
  for (const source of Object.keys(labels)) $(source).disabled = !idle;
  $('generate').disabled = generating || phase === 'starting' || phase === 'stopping';
  $('cancel').hidden = !generating;
}
function release(stream) {
  for (const track of stream.getTracks()) track.stop();
}
async function disconnect() {
  for (const { stream, input, worklet } of active.values()) {
    release(stream);
    input.disconnect();
    worklet.port.close();
    worklet.disconnect();
  }
  active.clear();
  if (context) {
    const audio = context;
    context = undefined;
    await audio.close().catch(() => {});
  }
}
async function stop() {
  if (phase !== 'listening') return;
  phase = 'stopping';
  update();
  try {
    await disconnect();
    await api.finish();
    if (!$('notice').classList.contains('error')) message('已停止监听。转写可在面试记录中查看。');
  } catch (error) { message(errorText(error), true); }
  finally { phase = 'idle'; update(); }
}

async function start() {
  phase = 'starting';
  update();
  message('正在连接音频并加载 Whisper small…');
  const requests = [];
  if ($('system').checked) {
    requests.push(['system', navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })]);
  }
  if ($('microphone').checked) {
    requests.push(['microphone', navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }, video: false,
    })]);
  }
  const results = await Promise.allSettled(requests.map(([, pending]) => pending));
  const streams = new Map();
  const warnings = [];
  let speechStarted = false;
  try {
    results.forEach((result, index) => {
      const source = requests[index][0];
      if (result.status === 'fulfilled' && result.value.getAudioTracks().some(track => track.readyState === 'live')) {
        for (const track of result.value.getVideoTracks()) track.stop();
        streams.set(source, result.value);
      } else {
        if (result.status === 'fulfilled') release(result.value);
        warnings.push(labels[source] + '采集失败' + (result.status === 'rejected' ? '（' + errorText(result.reason) + '）' : ''));
      }
    });
    if (!streams.size) throw new Error(warnings.join('；'));
    context = new AudioContext({ sampleRate: 16000 });
    await context.audioWorklet.addModule(new URL('pcm-worklet.js', import.meta.url).href);
    await context.resume();
    for (const [source, stream] of streams) {
      const input = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, 'buddy-pcm');
      const audio = stream.getAudioTracks()[0];
      active.set(source, { stream, input, worklet, audio });
      worklet.port.onmessage = ({ data }) => {
        if (phase === 'listening' && audio.readyState === 'live') api.send(source, new Uint8Array(data));
      };
      input.connect(worklet).connect(context.destination);
      audio.addEventListener('ended', () => {
        if (phase !== 'listening') return;
        message(labels[source] + '已断开。', true);
        if ([...active.values()].every(item => item.audio.readyState === 'ended')) void stop();
      });
    }
    await api.start();
    speechStarted = true;
    if ([...active.values()].every(item => item.audio.readyState === 'ended')) throw new Error('音频设备已断开。');
    latest = '';
    $('transcript').replaceChildren($('empty') ?? emptyTranscript());
    $('latest').disabled = true;
    $('result').hidden = true;
    $('answer-empty').hidden = false;
    $('result').textContent = '';
    phase = 'listening';
    message(warnings.length ? warnings.join('；') : '正在本机转写。点击一条转写即可引用。', warnings.length > 0);
  } catch (error) {
    for (const stream of streams.values()) release(stream);
    await disconnect();
    if (speechStarted) await api.finish().catch(() => {});
    phase = 'idle';
    message(errorText(error), true);
  }
  update();
}

function emptyTranscript() {
  const item = document.createElement('p');
  item.id = 'empty';
  item.className = 'muted';
  item.textContent = '识别到的话会出现在这里。';
  return item;
}
function quote(text) {
  if (!text) return;
  $('question').value = text.slice(0, 1200);
  $('question').focus();
}
api.onTranscript(({ source, text, offsetMs }) => {
  latest = text;
  $('latest').disabled = false;
  $('empty')?.remove();
  const panel = $('transcript');
  const follow = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 24;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'transcript-line';
  const tag = document.createElement('span');
  const seconds = Math.floor(offsetMs / 1000);
  tag.textContent = labels[source] + ' · ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  button.append(tag, document.createTextNode(text));
  button.addEventListener('click', () => quote(text));
  panel.append(button);
  if (panel.children.length > 200) panel.firstElementChild.remove();
  if (follow) panel.scrollTop = panel.scrollHeight;
});
api.onWarning(warning => message(warning, true));
api.onDelta(chunk => {
  if (!generating) return;
  if ($('result').textContent === '正在生成…') $('result').textContent = '';
  $('result').append(document.createTextNode(chunk));
});
$('capture').addEventListener('click', () => {
  if (phase === 'idle') void start();
  else if (phase === 'listening') void stop();
});
$('close-window').addEventListener('click', () => void api.close().catch(error => message(errorText(error), true)));
for (const source of Object.keys(labels)) $(source).addEventListener('change', update);
$('pin').addEventListener('click', async () => {
  try {
    const pinned = await api.pin($('pin').getAttribute('aria-pressed') !== 'true');
    $('pin').setAttribute('aria-pressed', pinned);
    $('pin').textContent = pinned ? '已置顶' : '置顶';
  } catch (error) { message(errorText(error), true); }
});
const shareVisibility = $('share-visibility');
shareVisibility.addEventListener('click', async () => {
  shareVisibility.disabled = true;
  try {
    const hidden = await api.hideInShare(shareVisibility.getAttribute('aria-pressed') !== 'true');
    shareVisibility.setAttribute('aria-pressed', hidden);
    shareVisibility.textContent = hidden ? '共享时隐藏' : '共享时可见';
  } catch (error) { message(errorText(error), true); }
  finally { shareVisibility.disabled = false; }
});

const grip = $('resize-grip');
let drag;
let size;
let resizeFrame;
function resizeTo(width, height) {
  size = [width, height];
  resizeFrame ??= requestAnimationFrame(() => {
    resizeFrame = undefined;
    void api.resize(size).catch(error => message(errorText(error), true));
  });
}
grip.addEventListener('pointerdown', event => {
  if (event.button !== 0 || drag) return;
  drag = { pointer: event.pointerId, x: event.screenX, y: event.screenY, width: innerWidth, height: innerHeight };
  grip.setPointerCapture(event.pointerId);
});
grip.addEventListener('pointermove', event => {
  if (event.pointerId !== drag?.pointer) return;
  resizeTo(drag.width + event.screenX - drag.x, drag.height + event.screenY - drag.y);
});
grip.addEventListener('lostpointercapture', () => { drag = undefined; });
grip.addEventListener('keydown', event => {
  const step = event.shiftKey ? 80 : 24;
  const offset = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
  if (!offset) return;
  event.preventDefault();
  resizeTo(innerWidth + offset[0], innerHeight + offset[1]);
});
$('latest').addEventListener('click', () => quote(latest));
$('cancel').addEventListener('click', () => void api.cancel().catch(error => message(errorText(error), true)));
$('question').addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.ctrlKey && !$('generate').disabled) {
    event.preventDefault();
    $('question-form').requestSubmit();
  }
});
$('question-form').addEventListener('submit', async event => {
  event.preventDefault();
  const question = $('question').value.trim();
  if (!question || $('generate').disabled) return;
  generating = true;
  update();
  $('result').hidden = false;
  $('answer-empty').hidden = true;
  $('result').textContent = '正在生成…';
  try {
    const reply = await api.answer(question);
    $('result').textContent = reply.answer + (reply.feedback ? '\n\n' + reply.feedback : '');
  } catch (error) {
    $('result').hidden = !$('result').textContent || $('result').textContent === '正在生成…';
    $('answer-empty').hidden = !$('result').hidden;
    message(errorText(error), true);
  } finally { generating = false; update(); }
});
