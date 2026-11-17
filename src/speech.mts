import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export type AudioSource = 'microphone' | 'system';
export type SpeechLanguage = 'zh' | 'en' | null;
export type Segment = { source: AudioSource; pcm: Buffer; offsetMs: number };
export const frameBytes = 1280;
const quietLimit = 15;
const maxFrames = 195;

export class Segmenter {
  private leading: Buffer[] = [];
  private frames: Buffer[] = [];
  private voiced = 0;
  private quiet = 0;
  private start = 0;

  constructor(private threshold: number, private onSegment: (bytes: Buffer, start: number) => void) {}

  push(frame: Buffer, offsetMs: number) {
    let power = 0;
    for (let index = 0; index < frame.length; index += 2) power += frame.readInt16LE(index) ** 2;
    const speech = Math.sqrt(power / (frame.length / 2)) > this.threshold;
    if (!this.frames.length) {
      if (!speech) {
        this.leading.push(frame);
        if (this.leading.length > 5) this.leading.shift();
        return;
      }
      this.start = Math.max(0, offsetMs - this.leading.length * 40);
      this.frames = this.leading;
      this.leading = [];
    }
    this.frames.push(frame);
    if (speech) { this.voiced++; this.quiet = 0; }
    else this.quiet++;
    if (this.quiet >= quietLimit || this.frames.length >= maxFrames) this.flush();
  }

  flush() {
    if (this.voiced >= 4) this.onSegment(Buffer.concat(this.frames), this.start);
    this.frames = [];
    this.leading = [];
    this.voiced = 0;
    this.quiet = 0;
  }
}

class WhisperWorker {
  readonly ready: Promise<void>;
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending?: { id: number; resolve: (text: string) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout };
  private closed = false;
  private failure?: Error;
  private cancelStartup?: () => void;

  constructor(runtime: string, worker: string) {
    const portable = join(runtime, 'python', 'python.exe');
    const executable = existsSync(portable) ? portable : join(runtime, 'python', 'Scripts', 'python.exe');
    const model = join(runtime, 'whisper-small');
    if (!existsSync(executable) || !existsSync(join(model, 'model.bin'))) {
      throw new Error('缺少本地语音运行时。请先运行 tools/provision-speech.py。');
    }
    const { PYTHONHOME, PYTHONPATH, DEEPSEEK_API_KEY, ...env } = process.env;
    this.child = spawn(executable, ['-u', worker, model], { windowsHide: true, env, stdio: 'pipe' });
    this.child.stdin.on('error', () => {});
    const reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.ready = new Promise((resolve, reject) => {
      let stderr = '';
      const startupTimeout = setTimeout(() => fail(new Error('加载 Whisper 超时。')), 22000);
      const fail = (error: Error) => {
        clearTimeout(startupTimeout);
        this.cancelStartup = undefined;
        this.failure = error;
        reject(error);
        this.close();
      };
      this.cancelStartup = () => {
        clearTimeout(startupTimeout);
        reject(new Error('语音进程已关闭。'));
      };
      this.child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-350); });
      this.child.once('error', () => fail(new Error('无法启动本地 Whisper。')));
      this.child.once('exit', code => {
        if (!this.closed) fail(new Error('本地 Whisper 已退出（' + code + '）。' + stderr.trim()));
      });
      reader.on('line', line => {
        let payload;
        try { payload = JSON.parse(line); } catch { return; }
        if (payload.ready === true) {
          clearTimeout(startupTimeout);
          this.cancelStartup = undefined;
          resolve();
          return;
        }
        const task = this.pending;
        if (!task || payload.id !== task.id) return;
        this.pending = undefined;
        clearTimeout(task.timeout);
        if (payload.error) task.reject(new Error(String(payload.error).slice(0, 250)));
        else task.resolve(typeof payload.text === 'string' ? payload.text.trim() : '');
      });
    });
  }

  async transcribe(audio: Buffer, language: SpeechLanguage) {
    await this.ready;
    if (this.closed) throw this.failure ?? new Error('语音进程已关闭。');
    if (this.pending) throw new Error('语音进程正忙。');
    const id = ++this.sequence;
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.failure = new Error('转写超时，请重新开始实时语音。');
        this.close();
      }, 25000);
      this.pending = { id, resolve, reject, timeout };
      this.child.stdin.write(JSON.stringify({ id, pcm: audio.toString('base64'), language }) + '\n', error => {
        if (!error || this.pending?.id !== id) return;
        clearTimeout(timeout);
        this.pending = undefined;
        reject(error);
      });
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.cancelStartup?.();
    this.cancelStartup = undefined;
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.reject(this.failure ?? new Error('语音进程已关闭。'));
      this.pending = undefined;
    }
    this.child.kill();
  }
}

export class LiveSpeech {
  private worker: WhisperWorker;
  private pending: Segment[] = [];
  private processing?: Promise<void>;
  private channels: Record<AudioSource, Segmenter>;
  private closed = false;
  private started?: number;

  constructor(runtime: string, worker: string, private language: SpeechLanguage,
              private onText: (source: AudioSource, text: string, offsetMs: number) => void,
              private onError: (message: string) => void) {
    this.worker = new WhisperWorker(runtime, worker);
    this.channels = {
      microphone: new Segmenter(125, (pcm, offsetMs) => this.queue({ source: 'microphone', pcm, offsetMs })),
      system: new Segmenter(80, (pcm, offsetMs) => this.queue({ source: 'system', pcm, offsetMs })),
    };
  }

  get ready() { return this.worker.ready; }

  send(source: AudioSource, frame: Uint8Array) {
    if (this.closed || frame.byteLength !== frameBytes) return;
    const received = performance.now();
    this.started ??= received;
    this.channels[source].push(Buffer.from(frame), Math.round(received - this.started));
  }

  private queue(segment: Segment) {
    if (this.pending.length >= 12) {
      this.pending.shift();
      this.onError('音频积压，已跳过最早的一段。');
    }
    this.pending.push(segment);
    this.processing ??= this.drain().finally(() => { this.processing = undefined; });
  }

  private async drain() {
    while (!this.closed && this.pending.length) {
      const segment = this.pending.shift()!;
      try {
        const result = await this.worker.transcribe(segment.pcm, this.language);
        if (result && !this.closed) this.onText(segment.source, result, segment.offsetMs);
      } catch (error) {
        if (!this.closed) this.onError((error as Error).message);
      }
    }
  }

  async finish() {
    if (this.closed) return;
    for (const segmenter of Object.values(this.channels)) segmenter.flush();
    await this.processing;
    this.close();
  }

  close() {
    this.closed = true;
    this.pending.length = 0;
    this.worker.close();
  }
}
