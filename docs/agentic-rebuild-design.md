# ATP Daily — Agentic 重构设计

> Branch: `agentic-rebuild` · 2026-10-28

## 一、现有 workflow 的漏洞

现有流程：`06:00 UTC cron/generate-content`（拉数据 → 逐场写 recap → 写播客脚本 → 生成 metadata JSON）→ `06:15 UTC cron/generate-audio`（逐行 TTS → 拼接 MP3 → 上传）。

### A. 数据层：拉不到、拉错、拉得太薄

| # | 问题 | 位置 | 后果 |
|---|------|------|------|
| A1 | 赛事 ID 写死成 `[21324…21327]`，注释写着"新赛事开始时手动更新" | `lib/rapidapi-atp.ts:15` | 5 月以后再也拉不到比赛，这就是线上一直显示 Madrid mock 数据的根本原因 |
| A2 | 06:00 UTC 跑，但取的是 **当天** UTC 日期的比赛 | `generate-content.ts`（`date` 默认值） | 这个时间点当天的比赛基本还没打，正确做法应该是取前一天（并考虑时区） |
| A3 | 场地按月份猜、赛事名按日期猜、轮次靠一张"大概"的映射表 | `surfaceFromDate` / `tournamentName` / `ROUND_MAP` | 10 月的室内硬地会被写成什么都有可能，轮次也会错 |
| A4 | 技术统计全部是 0（`EMPTY_STATS`），种子永远是 `null` | `normalizeMatch` | 下游 prompt 却要求"分析发球、破发、关键局" → 只能编 |
| A5 | 国家代码映射只有 20 个 | `COUNTRY_MAP` | 其他国家的代码原样透传，国旗显示错 |
| A6 | `apiGet` 出任何错都返回 `null`，HTTP 状态、配额用尽都被吞掉 | `apiGet` | 无法区分"今天没比赛"和"API 挂了" |
| A7 | 默认只有一个赛事：`matches[0].tournament` | `buildPodcastPrompt` | 同一周有 2–3 个赛事时会混在一起，还都被当成同一个赛事 |

### B. 生成层：没有事实约束，没有质检

| # | 问题 | 后果 |
|---|------|------|
| B1 | Recap prompt 要求写"决定性时刻、回球深度、站位"，但输入里只有比分 | **事实性幻觉**：编造比赛过程 |
| B2 | Metadata prompt 明确要求"1–2 句**虚构的**球员赛后引语"，并要求 `player_of_day.stats` 给数字 | 给真实球员编造引语、编造数据，而且直接上线（这是声誉/法律风险） |
| B3 | Metadata 用 `JSON.parse` 解析纯文本，没有 schema 校验，失败就整个变成 `{}` | 标题、headline、chapters 全部为 null，页面静默降级 |
| B4 | Metadata 只看到脚本前 800 个字符 | chapter_titles 跟实际内容对不上 |
| B5 | 脚本格式（`ALEX:` / `SAM:`）没有校验；不合格的行在 TTS 时被静默丢掉 | 音频缺句子 |
| B6 | 三次 LLM 调用互相独立，没有共享"今天的故事线是什么" | recap、脚本、headline 讲的重点可能不一致 |
| B7 | 没有任何评审 / 修订 / 人工审核环节 | 生成什么就发布什么 |

### C. 编排层：不可恢复、不幂等、时序靠运气

| # | 问题 | 后果 |
|---|------|------|
| C1 | 两个 cron 靠"相隔 15 分钟"来保证先后顺序 | content 超时或失败时，audio 直接 skip，当天没有音频 |
| C2 | 重跑 content 时如果脚本生成失败，会把已有脚本 upsert 成 `null` | 重跑反而把好数据冲掉 |
| C3 | audio 只要 `audio_url` 存在就 skip | 脚本重新生成后，音频还是旧的，两者不一致 |
| C4 | 所有 recap 串行执行 + 3 次 LLM，全塞在一个 300s 函数里；TTS 也是逐行串行 ~40 次请求 | 比赛多的日子会超时 |
| C5 | 直接 `Buffer.concat` 拼接多个 MP3，时长靠"字节数 ÷ 16000"估算 | 帧头重复、时长不准（之前 iOS 的 seek 问题就和这有关） |
| C6 | cron 总是返回 200，即使 0 场比赛或全部失败 | 没有人知道它坏了，坏了半年 |

### D. 呈现层：用假数据掩盖故障

| # | 问题 | 后果 |
|---|------|------|
| D1 | DB 没数据 → 首页回退到 `mockData`，并且套上**今天的日期** | 用户看到的是"今天的 Madrid R32"——假内容伪装成新内容 |
| D2 | 没有音频 → 回退到 SoundHelix 的示例歌曲 | 播放器放的是一首无关的歌 |
| D3 | `displayDate` 取的是 matches 表里最新的日期，而不是"最近一期已完成的节目" | 比赛有了但节目没生成时，页面是半成品 |

### E. 安全与成本

| # | 问题 | 后果 |
|---|------|------|
| E1 | `/api/recap`、`/api/podcast`、`/api/tts` 标注了"已废弃"，但仍然部署着且**不需要鉴权** | 任何人都能刷你的 Anthropic / ElevenLabs 额度 |
| E2 | `/api/recap` 会把客户端传上来的 body 原样 upsert 进 `matches` | 任何人都能改写数据库里的比赛结果 |
| E3 | `/api/seed` 用 GET、无鉴权，会把 mock 数据写进生产库 | 爬虫访问一次就污染数据 |
| E4 | 比赛详情页仍然从前端调用 `/api/recap` | 废弃接口其实还在被用 |
| E5 | 模型名写死 `claude-sonnet-4-6`；prompt 远低于缓存阈值却加了 `cache_control` | 升级困难，缓存实际不生效 |
| E6 | 没有运行日志表、没有 token / 费用记录、没有告警 | 无法评估、无法调试 |

**一句话总结**：旧系统是一条"乐观的直线管道"——假设每一步都会成功，失败了就吞掉错误、用假数据把空洞填上。

---

## 二、新架构设计

### 设计原则（来自 Agentic AI 课程的几个核心思想）

1. **Workflow 优先，Agent 用在需要判断的地方。** 能确定的步骤（存库、TTS、上传）写成普通代码；只有"找数据源 / 选故事线 / 写作 / 审稿"这些需要判断的环节交给模型。
2. **Grounding：所有生成都只能基于一份经过校验的 Fact Sheet。** 写作 agent 看不到 fact sheet 以外的"事实"，每个事实性陈述都要能对应到 fact id。
3. **Evaluator–Optimizer 循环。** 写完 → 独立的审稿 agent 打分 + 指出问题 → 修订，最多 N 轮；仍不合格就转人工，而不是发布。
4. **显式状态机 + 幂等步骤。** 每次运行和每个步骤都落库，可以从任意失败步骤重跑，不会覆盖已经成功的产物。
5. **Fail loudly。** 宁可"今天没有节目"，也不发布假内容；任何失败都要有记录和通知。
6. **结构化输出。** 所有 agent 之间的交接都用 JSON Schema（tool use / structured output）+ zod 校验，不靠 `JSON.parse` 赌运气。

### 总体流程

```
                    ┌────────────────────────────────────────────┐
  cron (每天 1 次)   │  Orchestrator（普通代码，状态机）            │
  或手动触发  ─────▶ │  runs / run_steps 表记录每一步               │
                    └───────┬────────────────────────────────────┘
                            │
   ① DISCOVER  ─────────────┤  Data Agent（工具调用）
                            │   tools: list_tournaments(date_range)
                            │          get_results(tournament, date)
                            │          get_match_stats(match_id)
                            │          get_player(player_id)  (排名/种子/国籍)
                            │   → 产出原始数据
                            ▼
   ② VALIDATE  ── 纯代码：schema 校验 + 规则校验（比分合法、胜者一致、
                            │   日期在窗口内、无重复）→ Fact Sheet v1（带 fact id）
                            │   0 场比赛 → 状态 = NO_SHOW（休赛日），正常结束
                            ▼
   ③ PLAN      ── Editor Agent：从 Fact Sheet 选出 2–4 条故事线，
                            │   输出 Episode Outline（结构化：章节、每章引用的 fact ids）
                            ▼
   ④ WRITE     ── Writer Agents（可并行）
                            │   • Recap Writer：每场一篇，只能用该场的 facts
                            │   • Script Writer：按 Outline 写 ALEX/SAM 对话
                            │   • Meta Writer：headline / title / chapters / insights
                            │     （直接从 Outline 派生，不再看截断的脚本）
                            ▼
   ⑤ REVIEW    ── Fact-Checker Agent（独立 prompt、独立上下文）
                            │   逐句检查：有无 fact sheet 之外的事实？有无引语？
                            │   数字对不对？格式对不对？→ 评分 + 问题列表
                            │   不通过 → 回到 ④ 带着反馈修订（最多 2 轮）
                            │   仍不通过 → 状态 = NEEDS_REVIEW，通知你，停止
                            ▼
   ⑥ PRODUCE   ── 纯代码：TTS（有限并发）→ 用正规工具拼接音频 → 读出真实时长
                            │   → 上传 Storage
                            ▼
   ⑦ PUBLISH   ── 纯代码：所有产物齐全且通过审核 → episodes.status = published
                            │   前端只读取 status = published 的节目
                            ▼
                     通知（成功 / NO_SHOW / 失败 / 待审核）
```

### 各角色说明

| 角色 | 类型 | 输入 | 输出 | 关键约束 |
|------|------|------|------|----------|
| Orchestrator | 代码 | run_id | 推进状态机 | 每步幂等；记录 tokens、费用、耗时 |
| Data Agent | Agent + tools | 日期窗口 | 原始比赛数据 | 动态发现正在进行的赛事，不再写死 ID；API 错误必须上报，不能吞掉 |
| Validator | 代码 | 原始数据 | Fact Sheet | 只有通过规则的事实才进入 fact sheet；缺失字段标记为 unknown，而不是填 0 |
| Editor | Agent | Fact Sheet | Outline | 只做选择和排序，不写正文 |
| Writers | Agent | Outline + 相关 facts | 正文 | 禁止虚构引语；没有数据就不谈数据 |
| Fact-Checker | Agent（评审者） | 正文 + Fact Sheet | 评分 + 问题列表 | 与 writer 使用不同的 system prompt，不看 writer 的推理过程 |
| Producer | 代码 | 已审核的脚本 | MP3 + 真实时长 | 有限并发、失败重试；脚本 hash 和音频绑定 |
| Publisher | 代码 | 全部产物 | published | 只有全绿才发布 |

### 数据模型（新增 / 变更）

```sql
runs        (id, target_date, status, started_at, finished_at, error, cost_usd)
            -- status: running | no_show | needs_review | failed | published
run_steps   (id, run_id, step, status, attempt, input_hash, output jsonb,
             tokens_in, tokens_out, duration_ms, error)
fact_sheets (run_id, facts jsonb, source_meta jsonb)   -- 每个 fact 有 id 和来源
episodes    + status, run_id, script_hash, audio_script_hash
```

- `script_hash` ≠ `audio_script_hash` → 说明音频过期了，需要重新生成（修复 C3）。
- 每一步的输出单独存储，重跑时只执行失败的那一步（修复 C2）。

### 运行时选择

Vercel 函数最长 300s，而整条链路（多次 LLM 调用 + 评审循环 + TTS）很可能超过这个时间。两种做法：

- **推荐：每一步单独作为一次函数调用。** cron 只负责创建 run 并触发第一步；每一步完成后触发下一步（或者用每 5 分钟一次的 cron "推进所有未完成的 run"）。状态都在 Supabase，天然可以恢复。
- 备选：把 pipeline 放到 GitHub Actions / 一个长时间运行的 worker 里，用 Claude Agent SDK 跑。更灵活，但多了一套部署。

### 前端改动

- 删除生产环境中所有 mock 回退（D1、D2）；没有节目时显示"最近一期：10 月 26 日"或"今天休赛"。
- 首页只读取 `status = published` 的 episode，并显示**这一期真实对应的日期**（D3）。
- 比赛详情页的 recap 改为只读预生成的内容，删除前端调用 `/api/recap`（E4）。

### 安全清理（第一步就做）

- 删除 `/api/recap`、`/api/podcast`、`/api/tts`、`/api/seed`、`/api/hello`、`/api/debug/*`（E1–E3）。
- 手动触发 pipeline 的接口统一使用 `CRON_SECRET` 鉴权。
- 模型 ID 放进配置；按角色选模型（例如 Editor/Fact-Checker 用强模型，Meta Writer 用便宜模型）。

---

## 三、待确认的问题

1. **数据源。** 现在这个 RapidAPI 本身就不提供技术统计（A4）。需要先确认它有没有"按日期列出进行中赛事"的接口；如果连这个都没有，A1 无法根治，需要换数据源。这是整个重构的第一个技术风险，建议最先验证。
2. **要不要人工审核。** 设计里 `NEEDS_REVIEW` 状态需要一个通知渠道（邮件 / Slack / 一个简单的审核页面）。
3. **节目范围。** 只做 ATP 单打，还是同一周的多个赛事都要覆盖？

## 四、建议的实施顺序

1. **安全清理 + 去掉 mock 回退**（半天，立刻止血）。
2. **验证数据源** → 写 Data Agent 的工具层 + Validator + Fact Sheet（这是地基）。
3. 状态机骨架：`runs` / `run_steps` 表 + Orchestrator，每一步先放空实现。
4. Editor → Writers → Fact-Checker，以及评审循环。
5. Producer（音频）+ Publisher + 通知。
6. 前端接入 `published` 状态。
7. 评估：用过去几期的真实数据回放，统计 fact-checker 拦截率和成本。
