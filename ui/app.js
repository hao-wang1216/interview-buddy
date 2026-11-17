const api = window.buddy;
const $ = id => document.getElementById(id);
const labels = {
  resume: '简历', job: '岗位描述', project: '项目资料', experience: '经历',
  contribution: '本人贡献', decision: '技术决策', result: '可验证结果', skill: '技能',
};
const pages = {
  practice: ['面试咨询', '咨询面试准备、简历和项目经历。'],
  library: ['个人知识库', '导入资料、检索原文并确认面试档案。'],
  history: ['面试记录', '回看问题、回答与复盘。'],
  applications: ['求职进度', '记录面试过的公司、岗位和后续进展。'],
};
const buttons = [...document.querySelectorAll('[data-page]')];
const state = {
  page: 'practice', docs: [], facts: [], list: [], active: null, viewing: null,
  busy: false, requestId: null, configured: false, streamed: '', skill: undefined, toolTrace: [],
  applications: [], editingApplication: undefined,
};
const time = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });

function block(tag, text = '', className = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function action(label, handler, className = 'quiet') {
  const button = block('button', label, className);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

function source(item) {
  return item.name + (item.page ? ' · 第 ' + item.page + ' 页' : '');
}
function errorText(error) {
  return String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
function status(node, content, isError = false) {
  node.hidden = !content;
  node.textContent = content;
  node.classList.toggle('error', isError);
}
function notice(content = '', isError = false) { status($('notice'), content, isError); }

function run(handler, { generating = false, message = '' } = {}) {
  return async event => {
    event?.preventDefault();
    if (state.busy) return;
    state.busy = true;
    syncPractice();
    $('cancel').hidden = !generating;
    notice(message);
    try { await handler(); }
    catch (error) { notice(errorText(error), true); }
    finally {
      state.busy = false;
      $('cancel').hidden = true;
      syncPractice();
    }
  };
}

function showPage(page) {
  state.page = page;
  document.body.dataset.page = page;
  $('open-live').hidden = page !== 'practice';
  for (const button of buttons) {
    const selected = button.dataset.page === page;
    $(button.dataset.page).hidden = !selected;
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  [$('page-title').textContent, $('page-description').textContent] = pages[page];
  syncPractice();
  if (page === 'history') renderHistory();
  if (page === 'applications') renderApplications();
}

function syncPractice() {
  const ready = Boolean(state.active) && !state.busy;
  $('page-title').title = state.page === 'practice' ? state.active?.title ?? '' : '';
  $('new-session').disabled = state.busy;
  $('generate-answer').disabled = state.busy || !$('reference-question').value.trim();
  $('reference-question').readOnly = Boolean(state.requestId);
  $('prepare-plan').disabled = state.busy;
  $('generate-review').disabled = !ready || !state.active.turns.length;
  $('welcome').hidden = Boolean(state.active?.turns.length || state.requestId);
  if (state.page === 'practice') {
    $('page-title').textContent = state.active?.title ?? pages.practice[0];
  }
}

async function setSession(id) {
  state.active = id ? await api.session(id) : null;
  $('reference-question').value = '';
  $('pending-turn').hidden = true;
  selectConsultationTool();
  $('practice-notes').open = false;
  renderSessionOptions();
  scrollChat();
}
function renderRecent() {
  $('recent').hidden = !state.list.length;
  $('recent-list').replaceChildren(...state.list.slice(0, 12).map(row => {
    const link = action(row.title, run(async () => {
      if (row.kind === 'live') { state.viewing = await api.session(row.id); showPage('history'); }
      else { await setSession(row.id); showPage('practice'); }
    }));
    link.setAttribute('aria-pressed', row.id === state.active?.id);
    return link;
  }));
}
function renderSessionOptions() {
  renderRecent();
  const transcript = $('practice-transcript');
  transcript.hidden = !state.active?.turns.length;
  transcript.replaceChildren(...(state.active?.turns.map(renderTurn) ?? []));
  renderNotes();
  syncPractice();
}
function scrollChat() {
  const panel = $('chat-scroll');
  panel.scrollTop = panel.scrollHeight;
}
function nearEnd() {
  const panel = $('chat-scroll');
  return panel.scrollHeight - panel.scrollTop - panel.clientHeight < 100;
}
function appendInline(parent, text) {
  const markers = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
  let position = 0;
  for (const match of text.matchAll(markers)) {
    parent.append(text.slice(position, match.index), block(match[1] ? 'strong' : 'code', match[1] ?? match[2]));
    position = match.index + match[0].length;
  }
  parent.append(text.slice(position));
}
function renderReply(container, text) {
  container.replaceChildren();
  let list;
  let paragraph;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^\s*(?:([-*•])|(\d+)\.)\s+(.+)$/);
    if (marker) {
      const tag = marker[2] ? 'OL' : 'UL';
      if (list?.tagName !== tag) {
        list = block(tag.toLowerCase());
        if (tag === 'OL') list.start = Number(marker[2]);
        container.append(list);
      }
      const item = block('li');
      appendInline(item, marker[3]);
      list.append(item);
      paragraph = undefined;
      continue;
    }
    list = undefined;
    if (!line.trim()) { paragraph = undefined; continue; }
    const heading = line.match(/^#{1,6}\s+(.+)/);
    if (heading) {
      const title = block('h3');
      appendInline(title, heading[1]);
      container.append(title);
      paragraph = undefined;
      continue;
    }
    if (!paragraph) {
      paragraph = block('p');
      container.append(paragraph);
    } else {
      paragraph.append(document.createElement('br'));
    }
    appendInline(paragraph, line);
  }
}
function renderTurn(turn) {
  const practice = turn.origin === 'simulation';
  const row = block('article', '', 'turn');
  const question = block('p', turn.question, 'turn-question');
  question.setAttribute('aria-label', practice ? '面试官' : '你');
  const answer = block('div', '', 'reply');
  answer.setAttribute('aria-label', practice ? '你的模拟回答' : '面试搭子');
  row.append(question);
  if (turn.tools.length) row.append(toolTrace(turn.tools));
  row.append(answer);
  renderReply(answer, turn.answer);
  const references = webReferences(turn);
  if (references) row.append(references);
  if (turn.feedback) {
    const details = block('details', '', 'turn-detail');
    details.append(block('summary', practice ? '回答反馈' : '资料出处'), block('p', turn.feedback));
    row.append(details);
  }
  return row;
}
function toolTrace(steps, open = false) {
  const details = block('details', '', 'tool-trace');
  details.open = open;
  details.append(block('summary', '工具调用 · ' + steps.length + ' 步'));
  const list = block('ol');
  for (const step of steps) {
    const row = block('li');
    const label = block('strong', step.label);
    const statusLabel = { running: '执行中', done: '已完成', error: '未成功' }[step.state];
    const badge = block('span', statusLabel, 'tool-status');
    badge.dataset.state = step.state;
    row.append(label, badge);
    if (step.detail) row.append(block('p', step.detail));
    if (step.sources?.length) row.append(webSourceList(step.sources));
    list.append(row);
  }
  details.append(list);
  return details;
}
function webSourceList(sources) {
  const list = block('ul', '', 'web-sources');
  for (const source of sources) {
    const row = block('li');
    const label = '[网页' + source.number + '] ' + source.title;
    const button = action(label, () => void api.openSource(source.url).catch(error => notice(errorText(error), true)), 'web-source');
    button.title = source.url;
    row.append(button);
    if (source.date) row.append(block('span', source.date, 'source-date'));
    list.append(row);
  }
  return list;
}
function webReferences(turn) {
  const all = new Map(turn.tools.flatMap(step => step.sources ?? []).map(source => [source.number, source]));
  if (!all.size) return;
  const cited = [...new Set([...turn.answer.matchAll(/\[网页(\d+)\]/g)].map(match => Number(match[1])))];
  const sources = cited.map(number => all.get(number)).filter(Boolean);
  const details = block('details', '', 'tool-trace');
  details.append(block('summary', '网页来源 · ' + (sources.length || all.size) + ' 条'),
    webSourceList(sources.length ? sources : all.values()));
  return details;
}
function renderNotes() {
  for (const [id, text] of [['plan-content', state.active?.preparation], ['review-content', state.active?.review]]) {
    $(id).hidden = !text;
    $(id).querySelector('p').textContent = text ?? '';
  }
}
async function syncSessions() {
  state.list = await api.sessions();
  if (state.active) state.active = await api.session(state.active.id);
  renderSessionOptions();
}
async function initialize() {
  const [settings, docs, facts, history, tools, applications, statuses] = await Promise.all([
    api.info(), api.documents(), api.facts(), api.sessions(), api.consultationTools(), api.applications(), api.applicationStatuses(),
  ]);
  showConfig(settings);
  $('consult-tool-options').replaceChildren(
    action('自由咨询', () => selectConsultationTool()),
    ...tools.map(tool => action(tool.label, () => selectConsultationTool(tool))),
  );
  state.docs = docs;
  state.facts = facts;
  state.list = history;
  state.applications = applications;
  for (const label of statuses) {
    $('application-filter').append(new Option(label, label));
    $('application-status').append(new Option(label, label));
  }
  renderApplications();
  await setSession(history.find(item => item.kind === 'practice')?.id);
  renderDocuments();
  renderFacts();
}
function selectConsultationTool(tool) {
  if (state.requestId) return;
  state.skill = tool?.id;
  $('consult-tool-label').textContent = tool?.label ?? '面试工具';
  $('consult-tools').open = false;
  const draft = $('reference-question');
  if (tool && !draft.value.trim()) draft.value = tool.starter;
  if (tool) {
    draft.focus();
    draft.setSelectionRange(draft.value.length, draft.value.length);
  }
  syncPractice();
}
function renderPreview() {
  const confirmed = state.facts.filter(item => item.status === 'confirmed');
  $('doc-count').textContent = state.docs.length;
  $('fact-count').textContent = confirmed.length;
}

for (const button of buttons) button.addEventListener('click', () => showPage(button.dataset.page));
for (const button of document.querySelectorAll('[data-jump]')) button.addEventListener('click', () => showPage(button.dataset.jump));
$('new-session').addEventListener('click', run(async () => {
  await setSession(null);
  showPage('practice');
  $('reference-question').focus();
}));
async function ensureSession(title) {
  if (state.active) return;
  const row = await api.create(title);
  state.list = await api.sessions();
  await setSession(row.id);
}

$('open-live').addEventListener('click', () => void api.openLive().catch(error => notice(errorText(error), true)));
api.onLiveChanged(async () => {
  try {
    state.list = await api.sessions();
    if (state.page === 'history') {
      const viewing = state.viewing?.id;
      if (viewing) {
        const record = await api.session(viewing);
        if (state.viewing?.id === viewing) state.viewing = record;
      }
      if (state.page === 'history') renderHistory();
    }
    renderRecent();
  } catch (error) { notice(errorText(error), true); }
});

$('reference-question').addEventListener('input', syncPractice);
$('reference-question').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!$('generate-answer').disabled) $('consult-form').requestSubmit();
});
$('consult-form').addEventListener('submit', run(async () => {
  const question = $('reference-question').value.trim();
  if (!question) return;
  const requestId = crypto.randomUUID();
  state.requestId = requestId;
  state.streamed = '';
  state.toolTrace = [];
  $('pending-tools').replaceChildren();
  $('pending-tools').hidden = true;
  $('pending-question').textContent = question;
  $('practice-result').textContent = '正在回复…';
  $('pending-turn').hidden = false;
  syncPractice();
  scrollChat();
  try {
    const result = await api.answer({ id: state.active?.id, question, requestId, skill: state.skill });
    const follow = nearEnd();
    [state.active, state.list] = await Promise.all([api.session(result.sessionId), api.sessions()]);
    $('reference-question').value = '';
    $('pending-turn').hidden = true;
    state.requestId = null;
    selectConsultationTool();
    renderSessionOptions();
    if (follow) scrollChat();
  } catch (error) {
    if (state.toolTrace.length) $('practice-result').textContent = '本次未生成完整回答。';
    else $('pending-turn').hidden = true;
    throw error;
  } finally {
    state.requestId = null;
  }
}, { generating: true }));

api.onDelta(({ requestId, chunk }) => {
  if (requestId !== state.requestId) return;
  const follow = nearEnd();
  state.streamed += chunk;
  renderReply($('practice-result'), state.streamed);
  if (follow) scrollChat();
});
api.onTool(({ requestId, index, trace }) => {
  if (requestId !== state.requestId) return;
  const follow = nearEnd();
  state.toolTrace[index] = trace;
  const panel = $('pending-tools');
  panel.replaceChildren(toolTrace(state.toolTrace, panel.firstElementChild?.open ?? true));
  panel.hidden = false;
  state.streamed = '';
  $('practice-result').textContent = trace.state === 'running' ? '正在使用「' + trace.label + '」…' : '正在继续回答…';
  if (follow) scrollChat();
});

$('generate-review').addEventListener('click', run(async () => {
  state.active = await api.review(state.active.id);
  renderNotes();
  notice('复盘已保存到面试记录。');
}, { generating: true, message: '正在整理复盘…' }));
$('prepare-plan').addEventListener('click', run(async () => {
  await ensureSession('面试准备');
  state.active = await api.prepare(state.active.id);
  renderNotes();
  notice('准备计划已保存到面试记录。');
}, { generating: true, message: '正在整理面试档案…' }));
$('cancel').addEventListener('click', () => void api.cancel().catch(error => notice(errorText(error), true)));

async function loadLibrary() {
  [state.docs, state.facts] = await Promise.all([api.documents(), api.facts()]);
  renderDocuments();
  renderFacts();
}
function renderDocuments() {
  const list = $('document-list');
  list.replaceChildren();
  if (!state.docs.length) list.append(block('p', '还没有本地资料。', 'muted'));
  for (const doc of state.docs) {
    const item = block('div', '', 'item');
    const row = block('div', '', 'row');
    item.append(block('h3', doc.name), block('p', labels[doc.kind] + ' · ' + doc.passages + ' 个片段', 'muted'), row);
    row.append(action('查看原文', run(async () => showPassages(doc.name, await api.passages(doc.id)))));
    if (doc.kind !== 'job') row.append(action('AI 提取事实', run(async () => {
      if (!state.configured) { showSettings(); return; }
      try {
        const result = await api.draft(doc.id);
        notice('已生成 ' + result.count + ' 条待确认事实。' + (result.truncated ? ' 本次处理了前 18 个片段。' : ''));
      } finally { await loadLibrary(); }
    }, { generating: true, message: '正在提取带出处的事实…' })));
    row.append(action('移除', run(async () => {
      if (!window.confirm('移除「' + doc.name + '」及它关联的档案事实？')) return;
      await api.deleteDocument(doc.id);
      $('passage-view').hidden = true;
      await loadLibrary();
      notice('已移除本地资料。');
    }), 'quiet danger'));
    list.append(item);
  }
  renderPreview();
}

function showPassages(title, passages) {
  const area = $('passage-view');
  area.hidden = false;
  area.replaceChildren(block('h3', title));
  if (!passages.length) area.append(block('p', '没有匹配的本地文字。', 'muted'));
  for (const passage of passages) {
    const item = block('article', '', 'item');
    item.append(block('strong', source(passage)), block('p', passage.text, 'muted'));
    if (passage.kind !== 'job') {
      const details = block('details');
      const raw = block('textarea');
      raw.rows = 3;
      raw.maxLength = 500;
      raw.value = passage.text.slice(0, 300);
      raw.setAttribute('aria-label', '待加入档案的事实');
      const kind = block('select');
      kind.setAttribute('aria-label', '事实分类');
      for (const type of ['experience', 'contribution', 'decision', 'result', 'skill']) kind.append(new Option(labels[type], type));
      const row = block('div', '', 'row gap-top');
      row.append(kind, action('加入待确认', run(async () => {
        const count = await api.addFact({ passageId: passage.id, text: raw.value, kind: kind.value });
        await loadLibrary();
        details.open = false;
        notice(count ? '已加入档案，确认后可用于参考回答。' : '这条事实已经存在。');
      })));
      details.append(block('summary', '手动加入档案'), raw, row);
      item.append(details);
    }
    area.append(item);
  }
}

function renderFacts() {
  const list = $('fact-list');
  list.replaceChildren();
  if (!state.facts.length) list.append(block('p', '可从一段原文手动添加，或配置 DeepSeek 后提取事实。', 'muted'));
  for (const item of state.facts) {
    const card = block('article', '', 'item');
    const input = block('textarea');
    input.rows = 2;
    input.maxLength = 500;
    input.value = item.text;
    input.setAttribute('aria-label', '档案事实');
    const details = block('details');
    details.append(block('summary', '原文 · ' + source(item)), block('p', item.excerpt, 'muted'));
    const row = block('div', '', 'row');
    const confirm = target => run(async () => {
      await api.updateFact({ id: item.id, text: input.value, status: target });
      await loadLibrary();
      notice(target === 'confirmed' ? '已保存确认的事实。' : target === 'dismissed' ? '已从档案中移除。' : '已改为待确认。');
    });
    row.append(action(item.status === 'confirmed' ? '保存编辑' : '确认事实', confirm('confirmed')));
    if (item.status === 'confirmed') row.append(action('改为待确认', confirm('pending')));
    row.append(action('移除', confirm('dismissed'), 'quiet danger'));
    card.append(block('span', labels[item.kind] + ' · ' + (item.status === 'confirmed' ? '已确认' : '待确认'), 'badge'), input, details, row);
    list.append(card);
  }
  renderPreview();
}
$('import').addEventListener('click', run(async () => {
  const result = await api.importDocuments($('document-kind').value);
  await loadLibrary();
  if (!result.added && !result.duplicates && !result.failed.length) return;
  notice('已导入 ' + result.added + ' 份，重复 ' + result.duplicates + ' 份。' +
    (result.failed.length ? ' ' + result.failed.join('；') : ''), Boolean(result.failed.length));
}));
$('search-form').addEventListener('submit', run(async () => showPassages('搜索结果', await api.search($('search').value))));

function renderHistory() {
  const list = $('history-list');
  list.replaceChildren();
  if (!state.list.length) list.append(block('p', '还没有保存的练习。', 'muted'));
  for (const item of state.list) {
    const count = item.kind === 'live' ? item.transcriptions + ' 条转写 · ' + item.turns + ' 个回答' : item.turns + ' 道题';
    const button = action(item.title + '\n' + time.format(new Date(item.createdAt)) + ' · ' + count,
      run(async () => { state.viewing = await api.session(item.id); renderHistory(); }), 'record-button quiet');
    button.setAttribute('aria-pressed', item.id === state.viewing?.id);
    list.append(button);
  }
  const detail = $('history-detail');
  const record = state.viewing;
  $('continue').hidden = !record || record.kind === 'live';
  $('history-title').textContent = record?.title ?? '记录详情';
  detail.replaceChildren();
  if (!record) { detail.append(block('p', '选择一条记录查看问题和回答。', 'muted')); return; }
  if (record.preparation) {
    const plan = block('details', '', 'item');
    plan.append(block('summary', '面试准备计划'), block('p', record.preparation));
    detail.append(plan);
  }
  if (record.review) {
    const review = block('article', '', 'item');
    review.append(block('h3', '本场复盘'), block('p', record.review));
    detail.append(review);
  }
  if (record.transcripts.length) {
    const transcript = block('details', '', 'item');
    transcript.append(block('summary', '实时转写 · ' + record.transcripts.length + ' 条'));
    for (const entry of record.transcripts) {
      transcript.append(block('p', (entry.source === 'system' ? '系统声音' : '麦克风') + ' · ' +
        Math.floor(entry.offsetMs / 1000) + ' 秒\n' + entry.text));
    }
    detail.append(transcript);
  }
  if (!record.turns.length && !record.transcripts.length) detail.append(block('p', '本场尚未回答问题。', 'muted'));
  for (const item of record.turns) {
    const card = block('article', '', 'item');
    card.append(block('span', item.origin === 'simulation' ? '模拟问答' : item.origin === 'live' ? '实时参考回答' : '面试咨询', 'badge'),
      block('h3', item.question));
    if (item.tools.length) card.append(toolTrace(item.tools));
    card.append(block('p', item.answer));
    const references = webReferences(item);
    if (references) card.append(references);
    if (item.feedback) card.append(block('p', item.feedback, 'muted'));
    detail.append(card);
  }
  detail.append(action('删除这场练习', run(async () => {
    if (!window.confirm('删除「' + record.title + '」及其内容？')) return;
    await api.deleteSession(record.id);
    state.viewing = null;
    if (state.active?.id === record.id) state.active = null;
    await syncSessions();
    if (!state.active) await setSession(state.list.find(item => item.kind === 'practice')?.id);
    renderHistory();
    notice('已删除本地练习。');
  }), 'quiet danger'));
}
$('continue').addEventListener('click', run(async () => {
  await setSession(state.viewing.id);
  showPage('practice');
}));

const applicationFields = {
  company: 'application-company', position: 'application-position', interviewDate: 'application-date',
  round: 'application-round', status: 'application-status', notes: 'application-notes',
};
function renderApplications() {
  const filter = $('application-filter').value;
  const entries = state.applications.filter(entry => !filter || entry.status === filter);
  $('application-list').replaceChildren(...entries.map(entry => {
    const row = block('tr');
    for (const value of [entry.company, entry.position, entry.interviewDate, entry.round]) row.append(block('td', value));
    const stage = block('td');
    stage.append(block('span', entry.status, 'badge'));
    row.append(stage, block('td', entry.notes || '—', 'application-notes'));
    const controls = block('td');
    controls.append(action('编辑', () => editApplication(entry)), action('删除', run(async () => {
      if (!window.confirm('删除「' + entry.company + ' · ' + entry.position + '」的面试记录？')) return;
      state.applications = await api.deleteApplication(entry.id);
      renderApplications();
    }), 'quiet danger'));
    row.append(controls);
    return row;
  }));
  status($('applications-empty'), entries.length ? '' : filter ? '没有这个状态的记录。' : '添加第一条面试记录后，就能在这里跟踪进展。');
}
function editApplication(entry) {
  const today = new Date();
  const localDate = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const values = entry ?? { interviewDate: localDate, status: '待反馈' };
  state.editingApplication = entry?.id;
  for (const [key, field] of Object.entries(applicationFields)) $(field).value = values[key] ?? '';
  $('application-title').textContent = entry ? '编辑面试记录' : '添加面试记录';
  status($('application-error'), '');
  $('application-editor').showModal();
  $('application-company').focus();
}
$('application-add').addEventListener('click', () => editApplication());
$('application-close').addEventListener('click', () => $('application-editor').close());
$('application-filter').addEventListener('change', renderApplications);
$('application-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter ?? $('application-form').querySelector('[type=submit]');
  if (button.disabled) return;
  button.disabled = true;
  status($('application-error'), '');
  try {
    state.applications = await api.saveApplication({
      id: state.editingApplication,
      ...Object.fromEntries(Object.entries(applicationFields).map(([key, field]) => [key, $(field).value])),
    });
    $('application-filter').value = '';
    renderApplications();
    $('application-editor').close();
  } catch (error) {
    status($('application-error'), errorText(error), true);
  } finally {
    button.disabled = false;
  }
});

function showConfig(config) {
  state.configured = config.configured;
  $('settings-open').classList.toggle('connected', state.configured);
  $('model-status').textContent = state.configured ? 'DeepSeek · 已配置' : '配置 DeepSeek';
  $('composer-model').textContent = state.configured ? 'DeepSeek · ' + config.model : '配置 DeepSeek';
  $('model').value = config.model;
  $('language').value = config.preferences.language;
  $('answer-style').value = config.preferences.style;
  $('key').placeholder = state.configured ? '已保存，留空沿用' : '输入你的 DeepSeek API Key';
  $('clear-key').hidden = !state.configured;
  $('data-path').textContent = '本机数据目录 · ' + config.dataPath;
}
async function showSettings() {
  const dialog = $('settings');
  if (dialog.open) return;
  showConfig(await api.info());
  $('key').value = '';
  status($('settings-result'), '');
  dialog.showModal();
}
function settingsAction(handler) {
  return async event => {
    event?.preventDefault();
    const form = $('settings-form');
    const controls = [...form.querySelectorAll('button,input,select,textarea')];
    if (controls[0].disabled) return;
    for (const control of controls) control.disabled = true;
    try { await handler(); }
    catch (error) { status($('settings-result'), errorText(error), true); }
    finally { for (const control of controls) control.disabled = false; }
  };
}
function currentSettings() {
  return { key: $('key').value, model: $('model').value, preferences: { language: $('language').value, style: $('answer-style').value } };
}
$('settings-open').addEventListener('click', () => void showSettings().catch(error => notice(errorText(error), true)));
$('composer-model').addEventListener('click', () => void showSettings().catch(error => notice(errorText(error), true)));
$('settings-close').addEventListener('click', () => $('settings').close());
$('settings').addEventListener('close', () => { $('key').value = ''; });
$('settings-form').addEventListener('submit', settingsAction(async () => {
  showConfig(await api.saveSettings(currentSettings()));
  $('key').value = '';
  status($('settings-result'), '设置已保存。');
}));
$('test-api').addEventListener('click', settingsAction(async () => {
  status($('settings-result'), '正在测试连接…');
  const result = await api.testApi(currentSettings());
  $('model-list').replaceChildren(...result.models.map(model => new Option(model, model)));
  status($('settings-result'), result.modelAvailable ? '连接成功，当前模型可用。' : '连接成功，请选择服务返回的模型。');
}));
$('clear-key').addEventListener('click', settingsAction(async () => {
  showConfig(await api.saveSettings({ key: '', model: $('model').value, clear: true }));
  $('key').value = '';
  status($('settings-result'), '已移除已保存的 Key。');
}));
void initialize().catch(error => notice(errorText(error), true));
showPage('practice');
