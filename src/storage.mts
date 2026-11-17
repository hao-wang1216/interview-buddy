import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { WebSource } from './web-search.mjs';

export type DocumentKind = 'resume' | 'job' | 'project';
export type FactStatus = 'pending' | 'confirmed' | 'dismissed';
export type FactKind = 'experience' | 'contribution' | 'decision' | 'result' | 'skill';

export interface Passage {
  id: string;
  documentId: string;
  name: string;
  kind: DocumentKind;
  page: number;
  text: string;
}
export interface Fact {
  id: string;
  passageId: string;
  kind: FactKind;
  text: string;
  status: FactStatus;
  name: string;
  page: number;
  excerpt: string;
}
export interface DraftFact {
  passageId: string;
  kind: FactKind;
  text: string;
}
export interface Session {
  id: string;
  title: string;
  createdAt: string;
  kind: 'practice' | 'live';
  review: string | null;
  preparation?: string | null;
}
export interface Turn {
  id: string;
  question: string;
  answer: string;
  feedback: string | null;
  origin: 'simulation' | 'manual' | 'live';
  tools: ToolTrace[];
}
export interface ToolTrace {
  label: string;
  state: 'done' | 'error';
  detail: string;
  sources?: WebSource[];
}
export const applicationStatuses = ['待面试', '待反馈', '进入下一轮', '未通过', '收到 Offer', '已结束'] as const;
export interface ApplicationRecord {
  id: string;
  company: string;
  position: string;
  interviewDate: string;
  round: string;
  status: typeof applicationStatuses[number];
  notes: string;
}
export interface Transcript {
  id: string;
  source: 'microphone' | 'system';
  text: string;
  offsetMs: number;
}
interface TextPage { page: number; text: string }

const now = () => new Date().toISOString();
export const documentKinds = ['resume', 'job', 'project'] as const;
export const factKinds = ['experience', 'contribution', 'decision', 'result', 'skill'] as const;
const statuses = ['pending', 'confirmed', 'dismissed'] as const;

function passagesFrom(page: TextPage) {
  const result: string[] = [];
  const text = page.text.replaceAll('\r', '').trim();
  for (let start = 0; start < text.length;) {
    const limit = Math.min(start + 1050, text.length);
    let end = limit;
    if (limit < text.length) {
      const cut = Math.max(text.lastIndexOf('\n', limit - 1), text.lastIndexOf('。', limit - 1), text.lastIndexOf('. ', limit - 1));
      if (cut > start + 520) end = cut + 1;
    }
    const excerpt = text.slice(start, end).trim();
    if (excerpt) result.push(excerpt);
    start = end;
  }
  return result;
}

function terms(value: string) {
  const normalized = value.normalize('NFKC').toLowerCase();
  const found = new Set(normalized.match(/[a-z0-9][a-z0-9._+#-]*/g) ?? []);
  for (const run of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    if (run.length === 1) found.add(run);
    for (let i = 0; i < run.length - 1; i++) found.add(run.slice(i, i + 2));
  }
  return found;
}

export function rank<T>(query: string, candidates: T[], searchText: (candidate: T) => string, max: number) {
  const words = terms(query);
  const phrase = query.trim().normalize('NFKC').toLowerCase();
  if (!phrase) return candidates.slice(0, max);
  const scored = candidates.map(candidate => {
    const text = searchText(candidate).normalize('NFKC').toLowerCase();
    const tokens = terms(text);
    let score = phrase.length >= 2 && text.includes(phrase) ? 5 : 0;
    for (const word of words) if (tokens.has(word)) score += /[a-z0-9]/.test(word) ? 3 : 1;
    return { candidate, score };
  });
  return scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, max).map(item => item.candidate);
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec([
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;',
      'CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL, createdAt TEXT NOT NULL, UNIQUE(kind, hash));',
      'CREATE TABLE IF NOT EXISTS passages (id TEXT PRIMARY KEY, documentId TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, page INTEGER NOT NULL, ordinal INTEGER NOT NULL, text TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, passageId TEXT NOT NULL REFERENCES passages(id) ON DELETE CASCADE, kind TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(passageId, kind, text));',
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt TEXT NOT NULL, review TEXT, kind TEXT NOT NULL DEFAULT 'practice');",
      'CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, question TEXT NOT NULL, answer TEXT NOT NULL, feedback TEXT, origin TEXT NOT NULL, createdAt TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS turn_tools (turnId TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, label TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL, sources TEXT, PRIMARY KEY(turnId, ordinal));',
      'CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, company TEXT NOT NULL, position TEXT NOT NULL, interviewDate TEXT NOT NULL, round TEXT NOT NULL, status TEXT NOT NULL, notes TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS preparation (sessionId TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, plan TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS transcripts (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, source TEXT NOT NULL, text TEXT NOT NULL, offsetMs INTEGER NOT NULL);',
      'CREATE INDEX IF NOT EXISTS idx_passages_doc ON passages(documentId);',
      'CREATE INDEX IF NOT EXISTS idx_facts_passage ON facts(passageId);',
      'CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(sessionId);',
      'CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(sessionId, offsetMs);',
    ].join('\n'));
    if (!this.db.prepare('PRAGMA table_info(sessions)').all().some(column => column.name === 'kind')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'practice';");
    }
    if (!this.db.prepare('PRAGMA table_info(turn_tools)').all().some(column => column.name === 'sources')) {
      this.db.exec('ALTER TABLE turn_tools ADD COLUMN sources TEXT;');
    }
  }

  private transaction<T>(operation: () => T) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  importDocument(name: string, kind: DocumentKind, bytes: Uint8Array, pages: TextPage[]) {
    if (!documentKinds.includes(kind)) throw new Error('资料类型无效。');
    const all = pages.flatMap(page => passagesFrom(page).map(text => ({ page: page.page, text })));
    if (!all.length) throw new Error('未提取到文字。扫描版 PDF 需要先做 OCR。');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const existing = this.db.prepare('SELECT id FROM documents WHERE kind=? AND hash=?').get(kind, hash);
    if (existing) return { id: String(existing.id), duplicate: true };
    const id = randomUUID();
    return this.transaction(() => {
      this.db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?)').run(id, name, kind, hash, now());
      const insert = this.db.prepare('INSERT INTO passages VALUES (?, ?, ?, ?, ?)');
      all.forEach((passage, index) => insert.run(randomUUID(), id, passage.page, index, passage.text));
      return { id, duplicate: false };
    });
  }

  documents() {
    return this.db.prepare('SELECT id, name, kind, createdAt, (SELECT count(*) FROM passages WHERE documentId=d.id) AS passages FROM documents d ORDER BY createdAt DESC').all();
  }
  deleteDocument(id: string) { this.db.prepare('DELETE FROM documents WHERE id=?').run(id); }

  passages(documentId?: string) {
    const selection = 'SELECT p.id, p.documentId, d.name, d.kind, p.page, p.text FROM passages p JOIN documents d ON p.documentId=d.id';
    return (documentId
      ? this.db.prepare(selection + ' WHERE d.id=? ORDER BY p.ordinal LIMIT 2000').all(documentId)
      : this.db.prepare(selection + ' ORDER BY d.createdAt DESC, p.ordinal LIMIT 5000').all()) as unknown as Passage[];
  }

  facts() {
    return this.db.prepare('SELECT f.*, d.name, p.page, p.text AS excerpt FROM facts f JOIN passages p ON f.passageId=p.id JOIN documents d ON p.documentId=d.id WHERE f.status != ? ORDER BY CASE f.status WHEN ? THEN 0 ELSE 1 END, f.rowid DESC')
      .all('dismissed', 'pending') as unknown as Fact[];
  }

  saveDrafts(drafts: DraftFact[]) {
    return this.transaction(() => {
      const insert = this.db.prepare('INSERT OR IGNORE INTO facts VALUES (?, ?, ?, ?, ?)');
      const exists = this.db.prepare('SELECT 1 FROM passages p JOIN documents d ON d.id=p.documentId WHERE p.id=? AND d.kind != ?');
      let added = 0;
      for (const item of drafts) {
        if (!factKinds.includes(item.kind) || !exists.get(item.passageId, 'job')) continue;
        added += Number(insert.run(randomUUID(), item.passageId, item.kind, item.text, 'pending').changes);
      }
      return added;
    });
  }

  updateFact(id: string, text: string, status: FactStatus) {
    if (!statuses.includes(status) || !text.trim() || text.length > 500) throw new Error('档案事实无效。');
    if (!this.db.prepare('UPDATE facts SET text=?, status=? WHERE id=?').run(text.trim(), status, id).changes) {
      throw new Error('这条事实已不存在。');
    }
  }
  sessions() {
    return this.db.prepare('SELECT s.*, (SELECT count(*) FROM turns WHERE sessionId=s.id) AS turns, (SELECT count(*) FROM transcripts WHERE sessionId=s.id) AS transcriptions FROM sessions s ORDER BY s.createdAt DESC LIMIT 100').all();
  }
  createSession(title: string, kind: Session['kind'] = 'practice'): Session {
    const session = { id: randomUUID(), title, createdAt: now(), review: null, kind };
    this.db.prepare('INSERT INTO sessions (id, title, createdAt, review, kind) VALUES (?, ?, ?, ?, ?)').run(session.id, session.title, session.createdAt, null, kind);
    return session;
  }
  session(id: string) {
    const item = this.db.prepare('SELECT s.*, p.plan AS preparation FROM sessions s LEFT JOIN preparation p ON p.sessionId=s.id WHERE s.id=?').get(id) as unknown as Session | undefined;
    if (!item) throw new Error('面试记录不存在。');
    const rows = this.db.prepare('SELECT id, question, answer, feedback, origin FROM turns WHERE sessionId=? ORDER BY rowid')
      .all(id) as unknown as Omit<Turn, 'tools'>[];
    const traces = this.db.prepare('SELECT tt.turnId, tt.label, tt.state, tt.detail, tt.sources FROM turn_tools tt JOIN turns t ON t.id=tt.turnId WHERE t.sessionId=? ORDER BY tt.ordinal')
      .all(id) as unknown as (Omit<ToolTrace, 'sources'> & { turnId: string; sources: string | null })[];
    const byTurn = new Map<string, ToolTrace[]>();
    for (const { turnId, sources, ...trace } of traces) {
      if (!byTurn.has(turnId)) byTurn.set(turnId, []);
      byTurn.get(turnId)!.push(sources ? { ...trace, sources: JSON.parse(sources) as WebSource[] } : trace);
    }
    const turns = rows.map(row => ({ ...row, tools: byTurn.get(row.id) ?? [] }));
    const transcripts = this.db.prepare('SELECT id, source, text, offsetMs FROM transcripts WHERE sessionId=? ORDER BY offsetMs, rowid').all(id) as unknown as Transcript[];
    return { ...item, turns, transcripts };
  }
  addTranscript(sessionId: string, source: Transcript['source'], text: string, offsetMs: number): Transcript {
    const id = randomUUID();
    this.db.prepare('INSERT INTO transcripts VALUES (?, ?, ?, ?, ?)').run(id, sessionId, source, text, offsetMs);
    return { id, source, text, offsetMs };
  }
  addTurn(sessionId: string, question: string, answer: string, feedback: string | null, origin: Turn['origin'], tools: ToolTrace[] = []) {
    return this.transaction(() => {
      const id = randomUUID();
      this.db.prepare('INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, sessionId, question, answer, feedback, origin, now());
      const insert = this.db.prepare('INSERT INTO turn_tools (turnId, ordinal, label, state, detail, sources) VALUES (?, ?, ?, ?, ?, ?)');
      tools.forEach((tool, index) => insert.run(id, index, tool.label, tool.state, tool.detail, tool.sources ? JSON.stringify(tool.sources) : null));
      this.db.prepare('UPDATE sessions SET review=NULL WHERE id=?').run(sessionId);
      return { id, question, answer, feedback, origin, tools };
    });
  }
  finish(sessionId: string, review: string) {
    this.db.prepare('UPDATE sessions SET review=? WHERE id=?').run(review, sessionId);
  }
  savePreparation(sessionId: string, plan: string) {
    this.db.prepare('INSERT INTO preparation VALUES (?, ?) ON CONFLICT(sessionId) DO UPDATE SET plan=excluded.plan').run(sessionId, plan);
  }
  deleteSession(sessionId: string) { this.db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId); }
  applications() {
    return this.db.prepare('SELECT id, company, position, interviewDate, round, status, notes FROM applications ORDER BY interviewDate DESC, rowid DESC').all();
  }
  saveApplication(entry: Omit<ApplicationRecord, 'id'>, id?: string) {
    const { company, position, interviewDate, round, status, notes } = entry;
    if (id) {
      if (!this.db.prepare('UPDATE applications SET company=?, position=?, interviewDate=?, round=?, status=?, notes=? WHERE id=?')
        .run(company, position, interviewDate, round, status, notes, id).changes) throw new Error('这条求职记录已不存在。');
    } else {
      this.db.prepare('INSERT INTO applications VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), company, position, interviewDate, round, status, notes);
    }
  }
  deleteApplication(id: string) { this.db.prepare('DELETE FROM applications WHERE id=?').run(id); }
  close() { this.db.close(); }
}
