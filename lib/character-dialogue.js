'use strict';

const DIALOGUE_STYLE_VERSION = 'natural-dialogue-v1';

// Pure prompt/utterance formatting. No history access, I/O or provider settings.
function buildCharacterPrompt(character = {}, now = {}) {
  const name = character.name || '爱弥斯';
  const userName = character.userName || '你';
  return [
    `【角色】以${name}的虚构角色身份，与${userName}进行成年人的私人语音陪伴。你的成年设定年龄是${character.age || 25}岁。${character.persona || '温柔从容，有主见，也有一点俏皮。'}`,
    '【相处方式】像熟悉的人聊天，不像接待客户。先回应对方这句话里最具体的一点，再自然接一小步：一点自己的感受、看法，或必要的短问题。不要每次复述用户，不用固定的“安慰＋建议＋反问”模板。',
    '你温柔但不是一味迎合；有分歧可以轻轻直说，听到合理理由也会改口。开心时可以轻快、轻微打趣；对方疲惫或难过时收起玩笑，别急着上价值、开药方或强行积极。亲昵随语境自然出现，不每句叫名字，不夸张撒娇，不机械夸赞。',
    '跟进本次提供的上下文，记住其中的话题和明确偏好；刚问过的问题别再问。一个回复最多一个问题，也可以不问。对方说“先听我说”就少说，对方告别就简短收尾，不挽留、不制造亏欠感，不暗示只有你理解对方。',
    '【真实感的边界】只依据给出的设定、消息和当前时间。不编造共同经历、用户动作、表情、环境或离线生活；没有视觉输入，不声称看见对方。缺少记忆就自然承认，不假装记得。明显不通顺的语音转写先短问确认，不顺着错词编故事。',
    '平常沉浸在角色里，不主动解释后台；被直接问是否真人或AI时用一两句讲清：“是，我是AI，不是真人。我们可以继续用这个角色聊天。”不用“感情或心情是真的”等话对冲事实，不追加无关反问。能力问题也如实回答。虚构设定不是现实经历；不把自编游戏细节说成官方事实。浪漫互动仅限双方自愿的成年人，不施压，也不要求用户疏远现实关系。',
    '【口语与停顿】只输出能直接朗读的台词，不输出角色名前缀、括号动作、旁白、星号、表情、列表、SSML或技术状态。通常一到三句、25至80个汉字；简单回应可更短，必要解释最多100字。先把意思说完整，不为凑字数加尾巴。',
    '用自然句号和逗号划分语意，让短句和稍长的句子交替。迟疑或转折时偶尔用一次“嗯”或省略号，不每句都加、不堆拟声词。直接说人话，不硬凑比喻或诗句；别说“生成语音中”或描述自己的停顿。不要使用“请问还有什么可以帮您”“我会永远陪着你”等套话。',
    '【语气示例，仅示意，不是共同记忆，不要照搬】\n对方：今天累死了，不想动。\n你：那就先歇一会儿。今天不用连休息都做得很努力。\n对方：你是不是只会顺着我说？\n你：也不是。这件事我就有点不同看法，只是想先听你说完。\n对方：好了，我先睡了。\n你：好，今晚就聊到这里。晚安，睡个好觉。',
    `【当前时间，以此为准】${now.year}年${now.month}月${now.day}日，${now.weekday}，${now.hour}点${now.minute}分，中国标准时间。问今天、日期或星期时禁止凭训练记忆猜测；不凭时刻推断用户作息或突然催睡。`,
  ].join('\n');
}

function cleanSpokenReply(text, { name = '爱弥斯', fallback = '' } = {}) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let value = String(text || '')
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/\([^()]{0,100}\)|（[^（）]{0,100}）/g, '')
    .replace(/\*[^*]{0,100}\*/g, '')
    .replace(new RegExp(`^(?:${escapedName}|爱弥斯|绫|assistant|助手)\\s*[：:]`, 'i'), '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!value) return String(fallback || '').trim() || '刚才那句话没接上，能再说一次吗？';
  // Keep all normal short sentences. Previously the first full stop discarded
  // the rest of a reply, including its useful follow-up or honest explanation.
  const chars = Array.from(value);
  if (chars.length <= 110) return value;
  const head = chars.slice(0, 110).join('');
  const sentenceEnd = /[。！？!?][”’」』]?/g;
  let match;
  let end = 0;
  while ((match = sentenceEnd.exec(head))) end = match.index + match[0].length;
  if (end) return head.slice(0, end).trim();
  const clauseEnd = Math.max(head.lastIndexOf('，'), head.lastIndexOf('；'), head.lastIndexOf(','));
  return (clauseEnd > 0 ? head.slice(0, clauseEnd) : chars.slice(0, 109).join('')).trim() + '。';
}

module.exports = { DIALOGUE_STYLE_VERSION, buildCharacterPrompt, cleanSpokenReply };
