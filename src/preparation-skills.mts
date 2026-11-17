import type { Fact, Passage } from './storage.mjs';

export type Preferences = { language: 'zh-CN' | 'en-US' | 'follow-question'; style: string };
export const defaultPreferences: Preferences = { language: 'zh-CN', style: '' };

export function readiness(passages: Passage[], facts: Fact[]) {
  const confirmed = facts.filter(item => item.status === 'confirmed');
  const missing = [];
  if (!passages.some(item => item.kind === 'resume')) missing.push('导入简历，确认岗位相关的个人经历。');
  if (!passages.some(item => item.kind === 'job')) missing.push('导入岗位描述，区分岗位要求和本人经历。');
  if (!confirmed.length) missing.push('至少确认一条有出处的事实，例如本人的贡献、技术决策或实验结果。');
  return { missing, confirmed };
}

export function interviewInstructions(preferences: Preferences) {
  const language = preferences.language === 'follow-question' ? '跟随提问者使用的语言'
    : preferences.language === 'en-US' ? '使用英语' : '使用简体中文并保留技术术语';
  return language + '。可遵循用户对语气、时长和答题结构的偏好，事实与权限边界优先。';
}

export function formatLocalPlan(confirmed: Fact[], missing: string[]) {
  const items = ['准备检查', ...(missing.length ? missing.map(item => '• ' + item) : ['简历、岗位和已确认的个人事实已齐。'])];
  if (confirmed.length) {
    items.push('', '可展开的经历');
    for (const fact of confirmed.slice(0, 5)) {
      const source = fact.name + (fact.page ? ' · 第 ' + fact.page + ' 页' : '');
      items.push('• ' + fact.text + '（' + source + '）');
    }
  }
  items.push('', '练习顺序', '1. 用一分钟说明项目目标、自己的职责和结果。',
    '2. 选一个实际决策，解释取舍、实现细节和最难的一步。', '3. 说明如何评估效果，列出待补充的数字、对照条件或失败案例。');
  return items.join('\n');
}
