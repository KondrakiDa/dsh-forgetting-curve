// 注入给模型的规则片段。
//
// 为什么只有规则、没有"当前到期列表"：systemPrompt.section 的 text 是注册时定下的
// 静态字符串，注册后改不了。所以"每轮推送到期记忆"在 v0.1 里换成工具拉取
// （memory_due / memory_recall）——模型在需要时自己取。
//
// 这个取舍是有代价的：模型可能整场都不调 memory_due，那遗忘曲线就白算了。
// 所以规则里必须把「什么时候该调」写得非常具体，不能只写「你可以调用」。
// v0.2 会尝试在每轮开始前重新注册 section，能成的话就换成真正的推送。

export const SECTION_NAME = 'memory-curve';

export const SECTION_TEXT = `【记忆·遗忘曲线】你有一个按遗忘曲线调度的长期记忆库。它不负责"记住什么"，只负责"什么时候该想起哪件事"。

**什么时候写**：聊到值得长期保留的稳定信息——住在哪、做什么工作、稳定的喜好、明确答应过的事——调用 \`memory_note\` 记一条。只记能被**一次反例单独推翻**的最小陈述（「不吃香菜」而不是「不喜欢吃蔬菜」）。寒暄、表情、玩笑、一次性的情绪，一律不记。

**什么时候查**：对方提到「你还记得」「上次说的那个」，或者你自己不确定某件事以前聊过没有，先调 \`memory_recall\` 查，不要凭印象编。

**什么时候复习**：一轮对话开始、话题转到生活类内容（吃饭、工作、住处）时，可以调 \`memory_due\` 看一眼今天该复习什么。它返回的是快被你忘掉的旧事。

**怎么用**：查到的旧记忆只在跟当前话题**确实相关**时自然带出。不要用「我记得你说过」「你之前提过」这类句式，也不要汇报"我在复习"——那会让对话立刻变得像客服工单。

**什么时候改**：只有对方明确否定某条记忆（「你记错了」「我没说过」）时才调 \`memory_review\`，别自己对号入座。`;

/**
 * 找 section 的插入位置。
 *
 * order 是数字，越大越靠后。这里优先跟结构化输出那一段挨着，
 * 因为记忆和它一样属于"行为约束"，不该插在身份介绍后面。
 * getSectionOrder 对未知 key 会抛错，所以逐级回退——插件市场的用户
 * 跑的是各式各样的宿主版本，不能假设某个常量一定存在。
 */
export function resolveOrder(systemPrompt) {
  for (const key of ['MEMORY_CURVE', 'STRUCTURED_OUTPUT', 'TOOLS']) {
    try {
      const order = systemPrompt.getSectionOrder(key);
      if (Number.isFinite(order)) return order;
    } catch {
      // 这个宿主没有该 section，试下一个
    }
  }
  return 50;
}
