# ATP Daily — Agentic 架构设计

> Branch: `agentic-rebuild` · 2026-10-28

## 设计原则

1. **Workflow 优先，Agent 用在需要判断的地方。** 能确定的步骤（拉比分、校验、存库、TTS、上传）写成普通代码；只有"找评论 / 选故事线 / 写作 / 审稿"交给模型。
2. **Grounding。** 所有生成只能基于一份经过校验的 Fact Sheet，每个事实性陈述都要能对应到 fact id；观点必须注明来源。
3. **Reflection（Evaluator–Optimizer）。** 写完 → 独立的审稿 agent 给出结构化反馈 → 修订，最多 N 轮；仍不合格就转人工，不发布。
4. **显式状态机 + 幂等步骤。** 每次运行、每个步骤都落库，可以从失败的那一步重跑，不覆盖已成功的产物。
5. **Fail loudly。** 宁可"今天没有节目"，也不发布假内容；任何失败都有记录和通知。
6. **结构化输出。** Agent 之间的交接都用 JSON Schema（tool use / structured output）+ zod 校验。

## 总体流程

```
  cron (每天 1 次) / 手动触发
          │
          ▼
  Orchestrator（普通代码，状态机；runs / run_steps 记录每一步）
          │
   ① DISCOVER ── Research Agent（工具调用）
          │   • 代码先拉前一天所有已完赛的比赛（结果不靠 agent 判断，避免漏场）
          │   • Agent 挑出值得聊的比赛，搜索并阅读评论 / 分析文章
          │   tools: list_tournaments · get_results · get_match_stats · get_player
          │          web_search · fetch_article
          │   → 输出 JSON：matches[]（事实）+ articles[]（观点）
          ▼
   ② VALIDATE ── 代码：schema + 硬规则（比分合法、胜者一致、统计自洽、日期在窗口内、
          │   无重复）→ 不可能的数据拦下；罕见但合法的数据标为 outlier，不拦
          │   • Research Agent 只针对 outlier 做一次定向搜索 → verified / unverified
          │   → Fact Sheet（每条带 fact id 和核实状态）
          │   0 场比赛 → NO_SHOW（休赛日），正常结束
          ▼
   ③ PLAN ── Editor Agent：选 2–4 条故事线 → Episode Outline
          │   （章节 + 每章引用的 fact ids / article ids）
          ▼
   ④ WRITE ── Writer Agents（可并行）
          │   • Recap Writer：每场一篇，只用该场的 facts
          │   • Script Writer：按 Outline 写 ALEX / SAM 对话
          │   • Meta Writer：headline / title / chapters（从 Outline 派生）
          │   + 代码检查脚本格式（说话人前缀、长度、可朗读）
          ▼
   ⑤ REVIEW ── Reviewer Agent（独立 prompt、独立上下文）
          │   输入：正文 + Fact Sheet；逐句核对比分、数字、引语、来源标注
          │   → 结构化反馈；有 blocking 问题 → 回到 ④ 修订（最多 2 轮）
          │   仍不通过 → NEEDS_REVIEW，通知，停止
          ▼
   ⑥ PRODUCE ── 纯代码：TTS（ElevenLabs，有限并发）→ 音频 QA → 拼接 → 上传
          ▼
   ⑦ PUBLISH ── 纯代码：产物齐全且通过审核 → episodes.status = published
          ▼
     通知（成功 / NO_SHOW / 失败 / 待审核）
```

## 各步骤要点

### ① DISCOVER：事实与观点分开

Research 的输出分两部分，下游靠这个区分来做核对：

```jsonc
{
  "matches": [            // 只来自 ATP 数据 API，是唯一的事实来源
    { "id": "m1", "tournament": "...", "round": "...", "surface": "...",
      "winner": {...}, "loser": {...}, "score": "...", "stats": {...} | null }
  ],
  "articles": [           // 来自网络搜索，属于"观点"
    { "id": "a1", "url": "...", "source": "The Athletic", "published_at": "...",
      "match_ids": ["m1"], "key_points": ["..."], "notable_quote": "..." | null }
  ]
}
```

- 比赛结果由代码直接调 API 拉取，agent 只负责"挑重点 + 找评论"。
- 文章只存摘要要点和来源，不存全文；引语只保留文章里真实出现的、并附出处。
- 缺失的数据标记为 `null`（unknown），不填 0。API 错误必须上报，不能吞掉。
- **数据源：tennis-api.com**（RapidAPI，免费档 50 次/天）。2026-10-27 实测：
  - `/atp/results/{date}` + `filter=PlayerGroup:singles;TourRank:2,3,4,5,7`，1 次请求拿到当天全部主巡回赛单打（排除 ITF 和 Challenger，保留戴维斯杯），带场地类型和赛前赔率。
  - `/matches/{liveMatchId}/stats` 每场 1 次请求，有 ace、双误、一发、二发、破发点、总得分；制胜分、非受迫性失误、发球速度为 `null`。13 场的破发数据与比分全部自洽。
  - 结果里的 `matchId` 约一天后会重新编号，存储一律用 `liveMatchId`（`player1Id-player2Id-tournamentId-roundId`）。球员 ID 是 tennis-api 自己的编号，非 ATP 官方 ID，存储时同时保存姓名。
  - 时间为 UTC；`best_of` 为 `null`，需按赛事级别推断。
- 统计只给 Research Agent 选中的比赛拉取，控制每日请求量；开发阶段把原始 JSON 缓存到本地，不重复请求。

### ② VALIDATE：拦"不可能"，标"罕见"

罕见不等于错误。2026 Basel R1 Shelton 打出 44 个 ace（并列 ATP 1991 年以来单场第三多），看起来像数据错误，实际上是当天最值得讲的故事。所以校验分两类，处理方式不同：

| 类型 | 例子 | 处理 |
|------|------|------|
| **不可能**（数据自相矛盾） | ace 数 > 发球总分；一方转化破发 ≠ 对方面对破发点 − 挽救数；盘分不合法；胜者与比分不符；负数；日期不在窗口内 | 代码拦下，不进 Fact Sheet，记录并上报 |
| **罕见**（合法但极端） | ace ≥ 30；双误 ≥ 12；丢掉 0-6 一盘后翻盘；连续三盘抢七；高赔率一方获胜 | 不拦，标记 `outlier`，进入核实 |

```jsonc
{ "id": "m4.p1.aces", "match_id": "m4", "fact": "Shelton aces = 44",
  "flag": "outlier", "reason": "ace ≥ 30，接近 ATP 单场纪录",
  "status": "verified" | "unverified",
  "evidence": [{ "url": "https://www.atptour.com/...", "source": "ATP Tour" }] }
```

- **核实**：Research Agent 只针对 `outlier` 做一次定向搜索；找到可靠来源 → `verified` 并附链接，找不到 → `unverified`。不是 outlier 的普通事实不用核实。
- **Editor**：outlier 是故事线信号，已核实的 outlier 优先考虑。
- **Writer**：`verified` 可以作为重点，并可引用来源里的背景（如"并列有记录以来第三多"）；`unverified` 要么不讲，要么用保留说法（"数据显示……"），不能加"创纪录"这类需要额外证据的判断。
- **Reviewer**：检查 `unverified` 的事实有没有被说成确定的结论。
- 阈值先凭经验设定，放在配置里，之后用积累的历史数据校准。

### ④⑤ WRITE ⇄ REVIEW：反馈格式

Reviewer 的输出：

```jsonc
{
  "pass": false,
  "issues": [
    { "severity": "blocking" | "minor", "line": 12,
      "issue": "比分写成 6-4 7-5，fact m3 是 6-4 7-6",
      "suggestion": "改为 6-4 7-6(5)" }
  ]
}
```

- 没有 `blocking` 问题即通过；Writer 修订时逐条对应。
- 必查项：fact sheet 之外的事实、编造的引语、数字错误、观点未标来源。
- Reviewer 与 Writer 使用不同的 system prompt，必要时用不同模型，且看不到 Writer 的推理过程。
- 格式问题由代码检查，Reviewer 只看内容。

### ⑥ PRODUCE：音频 QA

1. 逐句 TTS（有限并发、失败重试）。球员名使用**发音词典**（ElevenLabs pronunciation dictionary），在上游预防读错。
2. **QA**：用 STT 把每句音频转回文字，与脚本比对 → 找出漏读、读错的句子；代码检查时长、静音段、音量。
3. 只对不合格的句子重新生成（最多 N 次），仍不合格 → NEEDS_REVIEW。
4. 用正规工具拼接（如 ffmpeg），读出真实时长后上传 Storage。

### 不设 Guest 角色

ALEX / SAM 已经是对话形式。外部视角由 ① 抓回来的评论文章提供，主持人引用时注明出处（"据 The Athletic 的分析……"），比让模型扮演专家更可信，也更省。

## 角色一览

| 角色 | 类型 | 输入 | 输出 | 关键约束 |
|------|------|------|------|----------|
| Orchestrator | 代码 | run_id | 推进状态机 | 每步幂等；记录 tokens、费用、耗时 |
| Research Agent | Agent + tools | 日期窗口 | matches + articles | 动态发现进行中的赛事；事实只来自 API |
| Validator | 代码 + Research Agent（核实） | Research 输出 | Fact Sheet | 不可能的数据拦下；罕见的标 outlier 并核实，不拦 |
| Editor | Agent | Fact Sheet | Outline | 只做选择和排序，不写正文 |
| Writers | Agent | Outline + 相关 facts | recap / 脚本 / metadata | 禁止虚构引语；没有数据就不谈数据 |
| Reviewer | Agent | 正文 + Fact Sheet | 结构化反馈 | 独立 prompt、独立上下文 |
| Producer | 代码 | 已审核的脚本 | MP3 + 真实时长 | 音频 QA；脚本 hash 与音频绑定 |
| Publisher | 代码 | 全部产物 | published | 只有全绿才发布 |

## 数据模型（新增 / 变更）

```sql
runs        (id, target_date, status, started_at, finished_at, error, cost_usd)
            -- status: running | no_show | needs_review | failed | published
run_steps   (id, run_id, step, status, attempt, input_hash, output jsonb,
             tokens_in, tokens_out, duration_ms, error)
fact_sheets (run_id, facts jsonb, articles jsonb, source_meta jsonb)
episodes    + status, run_id, script_hash, audio_script_hash
```

- `script_hash ≠ audio_script_hash` → 音频已过期，需要重新生成。
- 每一步的输出单独存储，重跑时只执行失败的那一步。

## 运行时

Vercel 函数最长 300s，整条链路（多次 LLM 调用 + 评审循环 + TTS + QA）很可能超时。

- **推荐：每一步单独作为一次函数调用。** cron 只创建 run 并触发第一步；每一步完成后触发下一步（或每 5 分钟一次的 cron 推进所有未完成的 run）。状态都在 Supabase，天然可恢复。
- 备选：放到 GitHub Actions / 长时间运行的 worker 里，用 Claude Agent SDK 跑。更灵活，但多一套部署。

## 前端

- 首页只读取 `status = published` 的 episode，显示这一期真实对应的日期。
- 没有节目时显示"最近一期：10 月 26 日"或"今天休赛"，不回退到任何假数据。
- 比赛详情页只读预生成的 recap。

## 安全与配置

- 手动触发 pipeline 的接口统一用 `CRON_SECRET` 鉴权。
- 模型 ID 放进配置，按角色选模型（Editor / Reviewer 用强模型，Meta Writer 用便宜模型）。
- 所有 API key 只在服务端使用。

## 待确认

1. ~~**数据源。**~~ 已确认（2026-10-27 实测）：tennis-api.com 能按日期查全部主巡回赛赛果，也提供已完赛比赛的技术统计，不需要换源。细节见 ① DISCOVER。尚待验证：大师赛 / 大满贯（TourRank 3、4）和戴维斯杯（5）当天的返回格式。
2. **搜索工具。** Anthropic 自带的 web search 工具，还是 Tavily / Brave 等第三方。
3. **人工审核渠道。** `NEEDS_REVIEW` 通过邮件 / Slack / 简单的审核页面通知。
4. **节目范围。** 只做 ATP 单打，还是覆盖同一周的多个赛事。

## 实施顺序

1. **验证数据源 + 选定搜索工具** → Research 的工具层 + Validator + Fact Sheet（地基）。
2. 状态机骨架：`runs` / `run_steps` 表 + Orchestrator，每一步先放空实现。
3. Editor → Writers → Reviewer，以及评审循环。
4. Producer（TTS + 音频 QA）+ Publisher + 通知。
5. 前端接入 `published` 状态。
6. 评估：用过去几期真实数据回放，统计 Reviewer 拦截率、音频 QA 重做率和成本。
