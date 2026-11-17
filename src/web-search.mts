export interface WebSource {
  number: number;
  title: string;
  url: string;
  date?: string;
}

export function publicWebUrl(input: unknown) {
  if (typeof input !== 'string' || input.length > 3000) return;
  try {
    const url = new URL(input);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
      return url.href;
    }
  } catch { /* Ignore malformed links. */ }
}

export async function searchWeb(key: string, query: string, signal: AbortSignal) {
  const response = await fetch('https://api.deepseek.com/v1/tools/search', {
    method: 'POST', redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, count: 5, need_content: true }),
  });
  if (!response.ok) {
    throw new Error(response.status === 402 ? 'DeepSeek 搜索账户余额不足。' : 'DeepSeek 搜索返回 HTTP ' + response.status + '。');
  }
  const data = await response.json() as { results?: unknown } | null;
  if (!Array.isArray(data?.results)) throw new Error('搜索服务未返回有效结果。');
  const seen = new Set<string>();
  return data.results.slice(0, 5).flatMap((item: Record<string, unknown> | null) => {
    const url = publicWebUrl(item?.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    const content = typeof item?.content === 'string' ? item.content.trim().slice(0, 1500) : '';
    const snippet = [item?.summary, item?.snippet].find(value => typeof value === 'string' && value.trim());
    return [{
      title: typeof item?.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 220) : new URL(url).hostname,
      url, date: typeof item?.date === 'string' ? (/^\d{4}-\d{2}-\d{2}/.exec(item.date)?.[0]) : undefined,
      summary: typeof snippet === 'string' ? snippet.trim().slice(0, 800) : '',
      content,
    }];
  });
}
