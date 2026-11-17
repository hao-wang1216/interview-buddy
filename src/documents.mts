import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const maxFileMB = 50;
const maxFile = maxFileMB * 1024 * 1024;
const fileSizeMessage = `请选择不大于 ${maxFileMB} MB 的资料文件。`;
const assets = new URL('./', import.meta.resolve('pdfjs-dist/package.json'));
const assetDirectory = (name: string) => fileURLToPath(new URL(name + '/', assets)).replaceAll('\\', '/');

export async function readDocument(path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.size > maxFile) throw new Error(fileSizeMessage);
  const bytes = await readFile(path);
  if (bytes.length > maxFile) throw new Error(fileSizeMessage);
  switch (extname(path).toLowerCase()) {
    case '.txt':
    case '.md': {
      const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
        : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
      let text: string;
      try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
      catch { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
      if (text.length > 240000) throw new Error('单份资料最多支持 24 万字符，请分成几份导入。');
      return { bytes, pages: [{ page: 0, text }] };
    }
    case '.pdf': {
      const job = getDocument({
        data: new Uint8Array(bytes), useSystemFonts: false, cMapPacked: true,
        cMapUrl: assetDirectory('cmaps'), standardFontDataUrl: assetDirectory('standard_fonts'),
        wasmUrl: assetDirectory('wasm'),
      });
      try {
        const pdf = await job.promise;
        if (pdf.numPages > 120) throw new Error('单份 PDF 最多支持 120 页，请先拆分。');
        const pages = [];
        let length = 0;
        for (let page = 1; page <= pdf.numPages; page++) {
          const handle = await pdf.getPage(page);
          const content = await handle.getTextContent();
          const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
          length += text.length;
          if (length > 240000) throw new Error('单份资料最多支持 24 万字符，请分成几份导入。');
          pages.push({ page, text });
          handle.cleanup();
        }
        return { bytes, pages };
      } finally {
        await job.destroy();
      }
    }
    default: throw new Error('支持 TXT、Markdown 和含文字的 PDF。');
  }
}
