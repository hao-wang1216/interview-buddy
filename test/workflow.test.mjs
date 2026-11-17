import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InterviewAgent, parseDrafts } from '../dist/agent.mjs';
import { readDocument } from '../dist/documents.mjs';
import { rank, Store } from '../dist/storage.mjs';

function addMaterials(store) {
  const resume = "我负责用 SAM2 做水下目标分割，整理了人工标注，并比较了推理速度。";
  const job = "计算机视觉算法工程师，要求有 YOLO 和目标检测经验，能主导 10 人团队。";
  return {
    resume: store.importDocument('resume.md', 'resume', Buffer.from(resume), [{ page: 2, text: resume }]),
    job: store.importDocument('job.txt', 'job', Buffer.from(job), [{ page: 0, text: job }]),
  };
}

test('documents retain origins, deduplicate and cannot convert a job requirement into a candidate fact', () => {
  const store = new Store(':memory:');
  try {
    const files = addMaterials(store);
    const [resume] = store.passages(files.resume.id);
    const [job] = store.passages(files.job.id);
    const duplicate = store.importDocument('renamed.md', 'resume', Buffer.from(resume.text), [{ page: 2, text: resume.text }]);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.id, resume.documentId);
    assert.equal(rank('SAM2分割', store.passages(), item => item.text, 4)[0].id, resume.id);
    const approved = parseDrafts({ facts: [
      { passageId: resume.id, kind: 'contribution', text: '我负责 SAM2 水下分割。', quote: '用 SAM2 做水下目标分割' },
      { passageId: job.id, kind: 'experience', text: '我主导过 10 人团队', quote: '能主导 10 人团队' },
      { passageId: resume.id, kind: 'result', text: '提升 15%', quote: '提升 15%' },
    ] }, [resume, job]);
    assert.equal(approved.length, 1);
    assert.equal(store.saveDrafts(approved), 1);
    assert.equal(store.saveDrafts(approved), 0);
    assert.equal(store.saveDrafts([{ passageId: job.id, kind: 'experience', text: '岗位要求' }]), 0);
    assert.deepEqual(store.facts().map(item => [item.status, item.name, item.page]), [['pending', 'resume.md', 2]]);
    store.updateFact(store.facts()[0].id, '本人负责 SAM2 分割与标注。', 'confirmed');
    assert.equal(store.facts()[0].status, 'confirmed');
    store.deleteDocument(files.resume.id);
    assert.equal(store.facts().length, 0);
  } finally { store.close(); }
});

test('a local interview and review survive closing and reopening SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'interview-buddy-'));
  const path = join(dir, 'practice.sqlite');
  const store = new Store(path);
  let session;
  try {
    const agent = new InterviewAgent(store, () => ({ key: '', model: 'deepseek-flash' }));
    const signal = AbortSignal.timeout(5000);
    session = store.createSession('计算机视觉岗');
    const question = '你在项目中负责什么？';
    store.addTurn(session.id, question, '我负责数据标注和模型评估。', '补充验证过程。', 'simulation');
    assert.ok((await agent.review(session.id, signal)).review.includes(question));
  } finally { store.close(); }
  const reopened = new Store(path);
  try {
    const restored = reopened.session(session.id);
    assert.equal(restored.title, '计算机视觉岗');
    assert.equal(restored.turns[0].answer, '我负责数据标注和模型评估。');
    assert.ok(restored.review);
  } finally {
    reopened.close();
    await rm(path, { force: true });
    await rm(path + '-wal', { force: true });
    await rm(path + '-shm', { force: true });
    const { rmdir } = await import('node:fs/promises');
    await rmdir(dir);
  }
});

test('the preparation skill writes confirmed project cards with verifiable reference IDs', async t => {
  const store = new Store(':memory:');
  try {
    const files = addMaterials(store);
    const passage = store.passages(files.resume.id)[0];
    store.saveDrafts([{ passageId: passage.id, kind: 'contribution', text: '我负责 SAM2 分割。' }]);
    const fact = store.facts()[0];
    store.updateFact(fact.id, fact.text, 'confirmed');
    const session = store.createSession('档案准备');
    t.mock.method(globalThis, 'fetch', async (_url, args) => {
      const request = JSON.parse(args.body);
      const evidence = JSON.parse(request.messages[1].content);
      assert.equal(evidence.facts[0].fact, '我负责 SAM2 分割。');
      assert.ok(evidence.jobs[0].text.includes('主导 10 人团队'));
      return Response.json({ choices: [{ message: { content: JSON.stringify({ cards: [
        { title: 'SAM2 项目', outline: '说明本人负责的模型和标注部分。', questions: ['如何评估？'], references: [1] },
        { title: '无有效出处的卡片', outline: '错误内容', questions: [], references: [12] },
      ] }) } }] });
    });
    const agent = new InterviewAgent(store, () => ({ key: 'mock-key', model: 'deepseek-flash' }));
    const result = await agent.prepare(session.id, AbortSignal.timeout(5000));
    assert.match(result.preparation, /项目答辩卡\n\nSAM2 项目/);
    assert.match(result.preparation, /出处：resume\.md（第 2 页）/);
    assert.doesNotMatch(result.preparation, /无有效出处/);
  } finally { store.close(); }
});

test('DeepSeek requests carry only relevant confirmed facts and stream safely across byte boundaries', async t => {
  const store = new Store(':memory:');
  try {
    const files = addMaterials(store);
    const passage = store.passages(files.resume.id)[0];
    store.saveDrafts([
      { passageId: passage.id, kind: 'contribution', text: '我负责 SAM2 分割。' },
      { passageId: passage.id, kind: 'result', text: '未确认：SAM2 准确率提升 99%。' },
    ]);
    const confirmed = store.facts().find(item => item.kind === 'contribution');
    store.updateFact(confirmed.id, confirmed.text, 'confirmed');
    const agent = new InterviewAgent(store, () => ({ key: 'mock-key', model: 'deepseek-flash' }));
    const signal = AbortSignal.timeout(5000);
    const intro = await agent.answer(undefined, '你是？', 'manual', signal, () => {});
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (url, args) => {
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      assert.equal(args.redirect, 'error');
      const request = JSON.parse(args.body);
      assert.equal(request.stream, true);
      assert.match(request.messages[0].content, /面试咨询助手/);
      assert.equal(request.tool_choice, 'auto');
      if (++requests === 1) {
        assert.ok(request.tools.some(item => item.function.name === 'search_knowledge'));
        const data = JSON.parse(request.messages[1].content);
        assert.equal(data.priorContext[0].question, '你是？');
        assert.ok(!JSON.stringify(data).includes('SAM2 分割。'));
        return sse(
          { tool_calls: [{ index: 0, id: 'kb-1', type: 'function', function: { name: 'search_knowledge', arguments: '{"query":' } }] },
          { tool_calls: [{ index: 1, id: 'prep-1', type: 'function', function: { name: 'prepare_project_followups', arguments: '{}' } }] },
          { tool_calls: [{ index: 2, id: 'profile-1', type: 'function', function: { name: 'get_profile', arguments: '{}' } }] },
          { tool_calls: [{ index: 0, function: { arguments: '"SAM2 分割"}' } }] },
        );
      }
      const [, , assistant, knowledge, prep, profile] = request.messages;
      assert.equal(assistant.role, 'assistant');
      assert.equal(knowledge.tool_call_id, 'kb-1');
      assert.equal(prep.tool_call_id, 'prep-1');
      assert.match(JSON.parse(prep.content).guide, /技术追问/);
      assert.deepEqual(JSON.parse(profile.content).documents, { resume: 1, job: 1, project: 0 });
      const data = JSON.parse(knowledge.content);
      assert.deepEqual(data.confirmed.map(item => item.fact), ['我负责 SAM2 分割。']);
      assert.ok(!JSON.stringify(data).includes('99%'));
      const encoded = new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: '我负责分割。[1][88]' } }] }) + '\r\n\r\ndata: [DONE]');
      const split = encoded.findIndex(byte => byte > 127) + 1;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoded.subarray(0, split));
        controller.enqueue(encoded.subarray(split));
        controller.close();
      } }));
    });
    let streamed = '';
    const toolsUsed = [];
    const answer = await agent.answer(intro.sessionId, '面试官会怎么细问我做的 SAM2？', 'manual', signal,
      chunk => { streamed += chunk; }, undefined, (index, step) => toolsUsed.push([index, step.label, step.state]));
    assert.deepEqual(toolsUsed, [
      [0, '检索个人知识库', 'running'], [0, '检索个人知识库', 'done'],
      [1, '技术追问', 'running'], [1, '技术追问', 'done'],
      [2, '读取面试档案', 'running'], [2, '读取面试档案', 'done'],
    ]);
    assert.equal(requests, 2);
    assert.match(streamed, /我负责分割/);
    assert.equal(answer.answer, '我负责分割。[1]');
    assert.match(answer.feedback, /resume\.md · 第 2 页/);
    assert.equal(answer.sessionId, intro.sessionId);
    assert.equal(store.session(intro.sessionId).turns.length, 2);
    assert.deepEqual(store.session(intro.sessionId).turns[1].tools, answer.tools);
    assert.match(answer.tools[0].detail, /1 条已确认经历/);
  } finally { store.close(); }
});

function sse(...updates) {
  return new Response(updates.map(delta => 'data: ' + JSON.stringify({ choices: [{ delta }] })).join('\n\n') + '\n\ndata: [DONE]');
}

test('the job-fit tool retrieves local JD evidence and excludes unconfirmed personal claims', async t => {
  const store = new Store(':memory:');
  try {
    const files = addMaterials(store);
    const passage = store.passages(files.resume.id)[0];
    store.saveDrafts([
      { passageId: passage.id, kind: 'contribution', text: '我负责 SAM2 目标分割。' },
      { passageId: passage.id, kind: 'result', text: '未核实的准确率 99%。' },
    ]);
    const confirmed = store.facts().find(item => item.kind === 'contribution');
    store.updateFact(confirmed.id, confirmed.text, 'confirmed');
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (_url, args) => {
      const request = JSON.parse(args.body);
      if (++requests === 1) {
        assert.equal(request.tool_choice.function.name, 'compare_job_fit');
        return sse({ tool_calls: [{ index: 0, id: 'job-1', type: 'function',
          function: { name: 'compare_job_fit', arguments: '{"query":"计算机视觉"}' } }] });
      }
      const result = request.messages.at(-1);
      assert.equal(result.tool_call_id, 'job-1');
      const data = JSON.parse(result.content);
      assert.match(data.guide, /可迁移经验/);
      assert.equal(data.jobDescriptions[0].file, 'job.txt');
      assert.match(data.jobDescriptions[0].text, /YOLO/);
      assert.deepEqual(data.confirmed.map(item => item.fact), ['我负责 SAM2 目标分割。']);
      return new Response('data: {"choices":[{"delta":{"content":"可以说明目标分割经历。[1]"}}]}\n\ndata: [DONE]');
    });
    const agent = new InterviewAgent(store, () => ({ key: 'mock-key', model: 'deepseek-flash' }));
    const answer = await agent.answer(undefined, '帮我做一下分析', 'manual', AbortSignal.timeout(5000), () => {}, 'job-fit');
    assert.match(answer.feedback, /resume\.md · 第 2 页/);
    assert.equal(requests, 2);
  } finally { store.close(); }
});

test('general consultation streams a reply in one request when the model chooses no tools', async t => {
  const store = new Store(':memory:');
  try {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (_url, args) => {
      assert.equal(JSON.parse(args.body).tool_choice, 'auto');
      requests++;
      return sse({ content: '可以分批处理。' });
    });
    const agent = new InterviewAgent(store, () => ({ key: 'mock-key', model: 'deepseek-flash' }));
    const result = await agent.answer(undefined, '什么是梯度累积？', 'manual', AbortSignal.timeout(5000), chunk => {
      assert.equal(chunk, '可以分批处理。');
    }, undefined, () => assert.fail('No tool should execute'));
    assert.equal(result.answer, '可以分批处理。');
    assert.equal(requests, 1);
  } finally { store.close(); }
});

test('an explicit web query searches first and saves only provider-backed source references', async t => {
  const store = new Store(':memory:');
  try {
    const sequence = [];
    const source = { url: 'https://example.com/careers', title: '招聘官网', date: '2026-11-16T04:00:00Z',
      summary: '计算机视觉算法工程师的公开岗位说明。' };
    t.mock.method(globalThis, 'fetch', async (url, args) => {
      const request = JSON.parse(args.body);
      sequence.push(url);
      if (url.endsWith('/tools/search')) {
        assert.deepEqual(request, { query: '示例公司 计算机视觉 招聘', count: 5, need_content: true });
        assert.equal(args.headers.Authorization, 'Bearer mock-key');
        return Response.json({ results: [source, { url: 'javascript:alert(1)', title: '无效' }] });
      }
      if (sequence.length === 1) {
        assert.equal(request.tool_choice.function.name, 'web_search');
        return sse({ tool_calls: [{ index: 0, id: 'web-1', type: 'function',
          function: { name: 'web_search', arguments: '{"query":"示例公司 计算机视觉 招聘"}' } }] });
      }
      const result = request.messages.at(-1);
      assert.equal(result.tool_call_id, 'web-1');
      assert.equal(JSON.parse(result.content).results.length, 1);
      assert.equal(JSON.parse(result.content).results[0].number, 1);
      return sse({ content: '招聘官网有岗位说明。[网页1][网页99]' });
    });
    const agent = new InterviewAgent(store, () => ({ key: 'mock-key', model: 'deepseek-flash' }));
    const trace = [];
    const result = await agent.answer(undefined, '请网上查一下示例公司的视觉岗位。', 'manual',
      AbortSignal.timeout(5000), () => {}, undefined, (_index, step) => trace.push(step));
    assert.equal(sequence.length, 3);
    assert.equal(result.answer, '招聘官网有岗位说明。[网页1]');
    assert.equal(trace[0].state, 'running');
    assert.equal(trace[1].state, 'done');
    assert.deepEqual(store.session(result.sessionId).turns[0].tools[0].sources,
      [{ number: 1, title: source.title, url: source.url, date: '2026-11-16' }]);
  } finally { store.close(); }
});

test('a failed web search returns a visible error and never creates web references', async t => {
  const store = new Store(':memory:');
  try {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (url, args) => {
      if (url.endsWith('/tools/search')) return new Response('', { status: 402 });
      if (!requests++) return sse({ tool_calls: [{ index: 0, id: 'failed-search', type: 'function',
        function: { name: 'web_search', arguments: '{"query":"示例公司 最新招聘"}' } }] });
      assert.match(JSON.parse(JSON.parse(args.body).messages.at(-1).content).error, /余额不足/);
      return sse({ content: '暂时无法核实最新招聘信息。[网页1]' });
    });
    const agent = new InterviewAgent(store, () => ({ key: 'mock-key', model: 'deepseek-flash' }));
    const result = await agent.answer(undefined, '有哪些最新招聘信息？', 'manual',
      AbortSignal.timeout(5000), () => {});
    assert.equal(result.answer, '暂时无法核实最新招聘信息。');
    assert.equal(result.tools[0].state, 'error');
    assert.match(result.tools[0].detail, /余额不足/);
  } finally { store.close(); }
});

function samplePdf() {
  const content = 'BT /F1 12 Tf 40 150 Td (SAM2 PDF interview notes) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream',
  ];
  let text = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, item] of objects.entries()) {
    offsets.push(text.length);
    text += (index + 1) + ' 0 obj\n' + item + '\nendobj\n';
  }
  const address = text.length;
  text += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return text + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + address + '\n%%EOF\n';
}

test('the standalone parser extracts PDF text and page number', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'interview-buddy-pdf-'));
  const path = join(dir, 'test.pdf');
  try {
    await writeFile(path, samplePdf());
    const document = await readDocument(path);
    assert.deepEqual(document.pages, [{ page: 1, text: 'SAM2 PDF interview notes' }]);
  } finally {
    await rm(path, { force: true });
    const { rmdir } = await import('node:fs/promises');
    await rmdir(dir);
  }
});
