import { config } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

/**
 * 系统内部标签列表
 */
const SYSTEM_TAGS = [
  'toolcall_running_status',
  'toolcall_status',
  'toolcall_result',
  'toolcall_id',
  'toolcall_name',
  'toolcall_arguments',
  'toolcall_error_message',
  'terminal_id',
  'terminal_cwd',
  'command_id',
  'command_status',
  'command_exit_code',
  'command_run_logs'
];

/**
 * 检测消息历史是否被系统标签污染
 */
export function isHistoryContaminated(messages: ChatMessage[]): boolean {
  // 检查 assistant 消息中是否包含系统标签（说明 MiMo 在模仿这些标签）
  const assistantMessages = messages.filter(m => m.role === 'assistant');

  for (const msg of assistantMessages) {
    if (!msg.content) continue;
    for (const tag of SYSTEM_TAGS) {
      if (msg.content.includes(`<${tag}>`)) {
        console.log('[SERIALIZE] ⚠️ Contamination detected in assistant message:', {
          tag,
          preview: msg.content.slice(0, 200)
        });
        return true;
      }
    }
  }

  return false;
}

/**
 * 清理消息内容中的系统内部标签，防止 MiMo 学习和模仿这些标签
 */
function sanitizeContent(content: string | null, role: string): string {
  if (content === null || content === undefined) return '';
  // 只清理 tool 角色的消息，因为这些消息包含系统内部标签
  if (role !== 'tool') return content;

  let cleaned = content;

  // 移除完整的标签对（包括内容）
  for (const tag of SYSTEM_TAGS) {
    const regex = new RegExp(`<${tag}>.*?</${tag}>`, 'gs');
    cleaned = cleaned.replace(regex, '');
  }

  // 移除自闭合标签
  for (const tag of SYSTEM_TAGS) {
    const regex = new RegExp(`<${tag}\\s*/>`, 'g');
    cleaned = cleaned.replace(regex, '');
  }

  // 移除单独的开闭标签
  for (const tag of SYSTEM_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}>`, 'g'), '');
    cleaned = cleaned.replace(new RegExp(`</${tag}>`, 'g'), '');
  }

  // 清理多余的空行
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return cleaned;
}

/**
 * 格式化单条消息用于对话历史，保留工具调用上下文
 */
function formatMessageForHistory(m: ChatMessage): string {
  // assistant 消息带 tool_calls：显示工具调用信息
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    const callsStr = m.tool_calls.map(tc => {
      const args = tc.function.arguments;
      return `${tc.function.name}(${args})`;
    }).join('\n');
    const contentPart = m.content ? `\n${m.content}` : '';
    return `assistant: [Tool Calls]\n${callsStr}${contentPart}`;
  }

  // tool 消息：显示工具结果（附带 tool_call_id 以关联调用）
  if (m.role === 'tool') {
    const name = m.name || 'unknown';
    const ref = m.tool_call_id ? ` (${m.tool_call_id})` : '';
    return `[Tool Result] ${name}${ref}:\n${m.content}`;
  }

  // 普通消息
  return `${m.role}: ${m.content}`;
}

/**
 * 为被丢弃的历史消息生成结构化摘要（同步、零额外调用）
 * 提取关键信息：工具调用、工具结果、对话主题
 */
function buildHistorySummary(dropped: ChatMessage[]): string {
  const toolCalls: string[] = [];
  const toolResults: string[] = [];
  const userTopics: string[] = [];

  for (const m of dropped) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        toolCalls.push(tc.function.name);
      }
    }
    if (m.role === 'tool') {
      const name = m.name || 'unknown';
      const preview = (m.content ?? '').slice(0, 80).replace(/\n/g, ' ');
      toolResults.push(`${name}: ${preview}${(m.content?.length ?? 0) > 80 ? '...' : ''}`);
    }
    if (m.role === 'user' && m.content) {
      // 取每条用户消息的前 60 字符作为主题
      userTopics.push(m.content.slice(0, 60).replace(/\n/g, ' '));
    }
  }

  const parts: string[] = [];
  parts.push(`${dropped.length} messages dropped (oldest)`);

  if (userTopics.length > 0) {
    // 只保留最后 3 个用户主题
    const recent = userTopics.slice(-3);
    parts.push(`Topics discussed: ${recent.join(' → ')}`);
  }
  if (toolCalls.length > 0) {
    // 去重并计数
    const counts: Record<string, number> = {};
    for (const t of toolCalls) counts[t] = (counts[t] || 0) + 1;
    const summary = Object.entries(counts).map(([k, v]) => v > 1 ? `${k}×${v}` : k).join(', ');
    parts.push(`Tools used: ${summary}`);
  }
  if (toolResults.length > 0) {
    const recent = toolResults.slice(-3);
    parts.push(`Recent results: ${recent.join('; ')}`);
  }

  return parts.join('\n');
}

/**
 * 智能截断对话历史：保留最近消息完整，旧消息压缩为摘要
 * 当历史过长时，从最旧的消息开始丢弃，生成结构化摘要替代
 */
function truncateHistoryWithSummary(
  dialogHistory: ChatMessage[],
  currentQuery: string,
  maxRest: number
): string {
  const header = '[Conversation History]\n';
  const summaryHeader = '[Earlier Context Summary]\n';
  const queryPart = `\n\n[Current Query]\n${currentQuery}`;

  // 先尝试直接拼接（不截断）
  const fullHistStr = dialogHistory.map(m => formatMessageForHistory(m)).join('\n');
  const fullRest = header + fullHistStr + queryPart;
  if (fullRest.length <= maxRest) {
    return fullRest;
  }

  // 需要截断：从最旧的消息开始丢弃，保留最新的
  // 二分查找：保留最近 N 条消息
  let lo = 0;
  let hi = dialogHistory.length;
  let bestKeep = 0; // 保留最近 N 条
  let bestSummary = '';

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const keepMessages = dialogHistory.slice(-mid);
    const droppedMessages = dialogHistory.slice(0, -mid);

    let histStr: string;
    if (droppedMessages.length > 0) {
      const summary = buildHistorySummary(droppedMessages);
      const keepStr = keepMessages.map(m => formatMessageForHistory(m)).join('\n');
      histStr = summaryHeader + summary + '\n\n' + keepStr;
    } else {
      histStr = keepMessages.map(m => formatMessageForHistory(m)).join('\n');
    }

    const totalLen = header.length + histStr.length + queryPart.length;
    if (totalLen <= maxRest) {
      bestKeep = mid;
      bestSummary = histStr;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // 如果连 0 条都放不下（只有当前查询就超了），直接返回当前查询
  if (bestKeep === 0 && dialogHistory.length > 0) {
    const summary = buildHistorySummary(dialogHistory);
    const histStr = summaryHeader + summary;
    const totalLen = header.length + histStr.length + queryPart.length;
    if (totalLen <= maxRest) {
      return header + histStr + queryPart;
    }
    // 摘要也放不下，只返回当前查询
    return queryPart.trim();
  }

  return header + bestSummary + queryPart;
}

export function serializeMessages(messages: ChatMessage[]): string {
  // 先清理所有消息内容
  const sanitizedMessages = messages.map(m => ({
    ...m,
    content: sanitizeContent(m.content, m.role)
  }));

  const system = sanitizedMessages.filter(m => m.role === 'system');
  const rest = sanitizedMessages.filter(m => m.role !== 'system');
  const truncated = rest.slice(-config.maxReplayMessages);
  const msgs = [...system, ...truncated];

  // Build system instruction ONCE
  const sysContent = system.map(m => m.content).join('\n');
  const sysStr = sysContent ? `[System Instruction]\n${sysContent}` : '';

  // Build non-system parts (WITHOUT duplicating system)
  const nonSystem = msgs.filter(m => m.role !== 'system');
  const dialogHistory = nonSystem.slice(0, -1);
  const lastMsg = nonSystem[nonSystem.length - 1];

  // Truncate system prompt if too long (max 60%)
  let finalSysStr = sysStr;
  let maxRest = config.maxQueryChars - (sysStr ? sysStr.length + 2 : 0);
  if (sysStr.length > config.maxQueryChars * 0.6) {
    const maxSys = Math.floor(config.maxQueryChars * 0.6);
    finalSysStr = sysStr.slice(0, maxSys) + '\n...(tool definitions truncated)';
    maxRest = config.maxQueryChars - finalSysStr.length - 2;
    console.log('[SERIALIZE] ⚠️ System prompt truncated:', {
      original: sysStr.length,
      truncated: finalSysStr.length,
      maxAllowed: maxSys
    });
  }

  // Build current query
  const currentQuery = lastMsg ? formatMessageForHistory(lastMsg) : '';

  // Build rest with smart history truncation
  let restStr: string;
  if (dialogHistory.length > 0 && maxRest > 0) {
    restStr = truncateHistoryWithSummary(dialogHistory, currentQuery, maxRest);
  } else if (lastMsg) {
    restStr = `[Current Query]\n${currentQuery}`;
  } else {
    restStr = '';
  }

  // Final truncation safety net (should rarely trigger)
  const truncatedRest = maxRest > 0 && restStr.length > maxRest
    ? restStr.slice(-maxRest)
    : restStr;

  const result = finalSysStr ? `${finalSysStr}\n\n${truncatedRest}` : truncatedRest;

  const hasSummary = restStr.includes('[Earlier Context Summary]');
  console.log('[SERIALIZE] Message sizes:', {
    systemPrompt: finalSysStr.length,
    historyMessages: dialogHistory.length,
    restStr: restStr.length,
    total: result.length,
    maxAllowed: config.maxQueryChars,
    usedSummary: hasSummary
  });

  return result;
}

export function extractLastUserMessage(messages: ChatMessage[]): string {
  // 先清理所有消息内容
  const sanitizedMessages = messages.map(m => ({
    ...m,
    content: sanitizeContent(m.content, m.role)
  }));

  const system = sanitizedMessages.filter(m => m.role === 'system');
  const userMsgs = sanitizedMessages.filter(m => m.role === 'user');
  const lastUser = userMsgs[userMsgs.length - 1]?.content ?? '';
  if (system.length === 0) return lastUser;
  const sysContent = system.map(m => m.content).join('\n');
  return `[System Instruction]\n${sysContent}\n\n[Current Query]\n${lastUser}`;
}