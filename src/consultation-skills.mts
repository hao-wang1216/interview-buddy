import { rank } from './storage.mjs';
import type { Fact, Passage } from './storage.mjs';

const skills = {
  'job-fit': {
    label: '岗位匹配',
    starter: '请对照目标岗位和个人知识库里的经历，指出已有匹配证据、待核实的差距，以及面试前最值得准备的三项。',
    instruction: '岗位匹配：提炼岗位的必备和加分要求。逐项区分已有证据、可迁移经验、缺少证据，以三项优先准备建议收尾。岗位描述的内容不能当作用户经历。资料不足时请用户给岗位名称或贴 JD，不猜测公司的实际要求。',
  },
  star: {
    label: 'STAR 故事',
    starter: '请把这段经历整理成一段可口述的 STAR 故事：\n',
    instruction: 'STAR 故事：用情境、任务、行动、结果组织一个真实事件。压缩背景，重点说明本人负责什么、如何决策和怎么验证结果。先给自然口述稿，再列最值得补齐的信息。用户没有提供的指标、结果或个人贡献应留空或标待确认。',
  },
  'project-drill': {
    label: '技术追问',
    starter: '请围绕这个项目给我三道逐步深入的技术追问：\n',
    instruction: '技术追问：从项目目标和本人职责，深入方案选型与备选方案，再到失败边界、实验对照或上线验证。给三道有递进关系的具体题，每题解释在考什么及回答时要准备的证据。技术细节不明时提出核对点，不替用户编项目实现。',
  },
  'answer-review': {
    label: '回答点评',
    starter: '请点评我的回答，指出最应该改的地方，并给一版更自然的口述稿。\n面试题：\n我的回答：\n',
    instruction: '回答点评：先说明回答是否切题，再按表达、个人行动或技术正确性、证据和结果逐项举例。技术题另外核对约束、复杂度、边界条件或测试。给优先修正项和可口述改写。没有回答正文时只请用户补上，不能打分或假设原文。',
  },
};

export type ConsultationSkill = keyof typeof skills;
export const consultationTools = Object.entries(skills).map(([id, { label, starter }]) => ({ id, label, starter }));

export function readConsultationSkill(input: unknown): ConsultationSkill | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'string' || !Object.hasOwn(skills, input)) throw new Error('面试工具无效。');
  return input as ConsultationSkill;
}

export function consultationInstruction(skill: ConsultationSkill | undefined) {
  return skill ? skills[skill].instruction : '';
}

export const modelTools = {
  web_search: { label: '联网搜索', description: '搜索公开网页，适用于用户要求上网查询、公司近况、公开招聘信息、时效性问题或需要核实公开事实。只提交公司、岗位、产品等公开关键词，避免放入简历原文、联系方式或其他私人信息。', query: true },
  get_profile: { label: '读取面试档案', description: '查看面试语言、回答偏好、已导入资料和已确认事实的数量。适用于用户询问档案概况或准备材料还缺什么。', query: false },
  search_knowledge: { label: '检索个人知识库', description: '查询用户已确认的简历和项目事实。遇到我的经历、我的项目、资料里写了什么等依赖个人资料的问题时调用。', query: true },
  compare_job_fit: { label: skills['job-fit'].label, description: '检索目标岗位描述和与岗位要求相关的已确认经历，用于分析资格匹配和准备缺口。', query: true },
  structure_star_story: { label: skills.star.label, description: '取用行为面试的 STAR 提纲，把用户的真实案例整理成适合口述的故事。', query: false },
  prepare_project_followups: { label: skills['project-drill'].label, description: '取用项目技术追问框架，围绕本人职责、方案、取舍和验证生成有递进关系的问题。', query: false },
  review_interview_answer: { label: skills['answer-review'].label, description: '取用面试回答点评清单，核对用户提供的回答并给出可验证的改写建议。', query: false },
} as const;

export type ModelTool = keyof typeof modelTools;
export const requestedTool: Record<ConsultationSkill, ModelTool> = {
  'job-fit': 'compare_job_fit', star: 'structure_star_story',
  'project-drill': 'prepare_project_followups', 'answer-review': 'review_interview_answer',
};

export const toolDefinitions = Object.entries(modelTools).map(([name, tool]) => ({
  type: 'function',
  function: {
    name, description: tool.description,
    parameters: {
      type: 'object',
      properties: tool.query ? { query: { type: 'string', description: '根据当前提问填写的岗位名称、项目名称或检索词' } } : {},
      required: tool.query ? ['query'] : [],
      additionalProperties: false,
    },
  },
}));

export function roleEvidence(query: string, passages: Passage[], facts: Fact[], includeSingleJob: boolean) {
  const jobs = passages.filter(passage => passage.kind === 'job');
  const matched = rank(query, jobs, job => job.name + ' ' + job.text, 3);
  const selected = !matched.length && includeSingleJob && new Set(jobs.map(job => job.documentId)).size === 1
    ? jobs.slice(0, 3) : matched;
  const leads = selected.flatMap(job => rank(job.text, facts, fact => fact.text + ' ' + fact.excerpt, 2));
  return { jobs: selected, leads };
}
