# dsh-memory-curve

遗忘曲线记忆插件，给 DeepSeek Harness 加一层**带强度衰减与复习调度的长期记忆**。

它不负责「记住什么」，只负责「什么时候该想起哪件旧事」。

## 它解决什么

大部分「记忆」插件做的是**存储**：把对话存下来、检索出来。它们不回答另一个问题——一条三个月没被提过的旧事，要不要现在端出来？

这个插件用艾宾浩斯那一套来分配这个额度：每条记忆有两个独立的强度量，越接近遗忘阈值的越优先出现，被接住就拉长间隔，被否定就砍半重学。

## 和「灵枢」（dsh-memory）的区别

两个都能装，不冲突，也不重复：

| | 灵枢 `@furongjun1999/dsh-memory` | 本插件 |
|---|---|---|
| 管什么 | 知识本身——实体、三元组、认知图 | 知识的时间轴——强度、衰减、复习 |
| 核心问题 | 「我知道什么」 | 「我该在什么时候想起来」 |
| 数据形态 | md_cg 文档 + 认知图 | jsonl 事件流 + 强度索引 |

灵枢是图书馆，这个是图书管理员手里的还书日期表。

## 装

```sh
# 本地目录安装
dsh plugin --profile desktop add "F:\dsh my own skill\dsh-memory-curve"

# 或者从 npm（发布后）
dsh plugin --profile desktop add dsh-memory-curve
```

装完重启 DSH。插件注册进宿主后对**所有会话**生效——包括 QQ 桥接的会话，因为它跑的也是 DSH 会话。

## 四个工具

模型自己决定什么时候用，规则写在 system prompt 里：

| 工具 | 时机 |
|---|---|
| `memory_note` | 聊到值得长期保留的稳定事实（住哪、做什么、稳定喜好、约定） |
| `memory_recall` | 对方说「你还记得」，或你不确定以前聊过没有 |
| `memory_due` | 话题转到生活类内容时，看一眼今天该复习什么 |
| `memory_review` | 对方明确否定某条记忆（「你记错了」） |

## 台账页面

装好后访问：

```
<你的 DSH 地址>/plugins/dsh-memory-curve/
```

两个 tab：台账（每条记忆的 kind / state / rs / 下次唤醒，点开看衰减曲线）和调参（所有曲线参数，支持改完先试算再保存）。

## 数据

默认在 `$DSH_HOME/memory-curve/`（Windows 上通常是 `C:\Users\<你>\.dsh\memory-curve\`）。

- `items.jsonl` —— append-only 事件流，可完整重建
- `snapshot.json` —— 物化索引，删了也能重建
- `params.json` / `params-history.jsonl` —— 参数与变更记录

不放在插件目录里：卸载重装插件不该把记忆一起带走。

## v0.1 的已知取舍

**注入是「拉」不是「推」。** `systemPrompt.section` 的文本在注册时就定死了，改不了，所以没法每轮把「今天到期」写进 prompt。v0.1 退化成让模型在需要时调 `memory_due`。

代价是真实的：模型可能整场都不调它，那遗忘曲线就白算了。规则里已经把调用时机写得很具体，但效果取决于模型。v0.2 会试着在每轮开始前重新注册 section，能成就换成真推送。

**没有自动抽取。** 记忆靠模型主动调 `memory_note` 写入，不是后台扫描对话。好处是零额外 token、不会误记；坏处是模型偷懒就漏记。

## 模型

`rs(t) = exp(-(t - lastReviewAt) / ss)`

- `ss` 存储强度：只增不减，每次成功复习 × 2.6，封顶 180 天
- `rs` 提取强度：随时衰减，落到 0.368（=1/e）时该复习了

状态机：`learning`（10min→1h→9h 密集巩固）→ `review`（按 ss 排期）→ `dormant`（连续 3 次没人接住）。

## 开发

```sh
node test/apply.test.mjs   # 装配测试，用假 ctx，不需要真宿主
```

## License

MIT
