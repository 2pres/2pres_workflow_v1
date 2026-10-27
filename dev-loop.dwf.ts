/* zcode-workflow
description: 通用开发闭环 v1.4：GLM 规划师拆解任务出 specs（五段式任务书+基线 commit+人工决策清单，固定落盘工作区
  .planning/ 并由脚本检查，开工前读禁止再犯清单）→ Opus 审查员独立审计划（意见分 blockers/suggestions，≤2轮）→
  按依赖细粒度调度、按 tier 派全新执行者（simple→DeepSeek Flash / medium、hard→GLM-5.3），上游失败自动跳过下游，
  每个任务做完立刻由 Flash 核对员核回执，卡住请教 Opus 导师 → 可选的项目验收命令由脚本执行，没过直接修 →
  Opus 验收员终判三态（pass / fail / pass+改进项），fail 派 Opus 修复工程师循环（≤N轮）。Opus 只用于审查、导师、
  验收、修复四个角色，脚本内有一行强模型开关可在额度用完时切到 GLM。状态全落 markdown。
whenToUse: 多步开发任务的默认通用流程：简单项目直接跑（小任务用 mode=quick 直通）；复杂项目先复制本 workflow
  按脚本内 [FORK] 注释适配。用户点名"跑 2pres_workflow_v1"、"用通用开发流程"时使用。
args:
  task:
    type: string
    description: 要开发的任务，必须自包含：写清做什么、交付什么、涉及哪些文件。full 模式下规划师会勘察代码库再拆解；quick 模式下这段直接交给执行者。
    required: true
  mode:
    type: string
    description: full=完整流程（规划→审查→[人工确认]→按 tier 派工→核对→验收修复循环）；quick=小任务直通（跳过拆解与审查，单执行者+验收）。
    required: false
    default: full
  tier:
    type: string
    description: 仅 quick 模式生效：执行者档位 simple/medium/hard（别名 flash/glm/opus）。full 模式由规划师在计划里逐任务标注。
    required: false
    default: medium
  human_checkpoints:
    type: boolean
    description: 仅 full 模式：计划审查通过后暂停，带着规划师的决策清单等人工拍板再开工。
    required: false
    default: false
  max_fix_rounds:
    type: number
    description: 验收 fail 后修复工程师（强模型）的重试轮数上限（1-10）。验收命令没过和验收员判 fail 共用这个上限。
    required: false
    default: 5
  accept_cmd:
    type: string
    description: 可选。项目自带的验收命令（如 npm test、./scripts/verify.sh），在会话工作目录下用 Git Bash 执行，最长 60 分钟。终验前由脚本跑，退出码非 0 或缺标记就直接进修复循环，通过后验收员只看它覆盖不到的问题。
    required: false
    default: ""
  accept_markers:
    type: string
    description: 可选，配合 accept_cmd。命令输出里必须出现的固定文字，多个用分号分隔，如 RELEASE_PIN_SYNC_OK;APP_LAYER_VERIFY_OK。
    required: false
    default: ""
*/
interface HumanDecision {
  /** 决策点编号，D1、D2… */
  id: string;
  /** 需要人工拍板的问题（方案取舍、命名、范围边界等） */
  question: string;
  /** 规划师的建议答案与理由 */
  recommendation: string;
}

interface PlannedTask {
  /** 任务编号，如 T1、T2，全计划内唯一 */
  id: string;
  /** 一句话标题 */
  title: string;
  /** 难度档位：simple=机械重复/格式化；medium=常规开发分析；hard=架构决策/疑难问题 */
  tier: "simple" | "medium" | "hard";
  /** 五段式自包含描述：①当前状态与涉及文件 ②起点（相对基线） ③完成标准（不超过 6 条，逐条可验收，优先可执行命令） ④约束（不许做什么） ⑤上下文提示 */
  description: string;
  /** 依赖的任务编号列表，无依赖为空数组 */
  dependsOn: string[];
}

interface Plan {
  /** 任务总数 */
  taskCount: number;
  /** 总体计划写入的文件路径 */
  planPath: string;
  /** 任务清单写入的文件路径 */
  tasksPath: string;
  /** 开工基线：当前 HEAD 的 commit 哈希；非 git 仓库写 no-git 并说明改用的快照基准 */
  baselineCommit: string;
  /** 需要人工拍板的决策清单，无则空数组 */
  humanDecisions: HumanDecision[];
  /** 拆解出的任务清单，按 tracer-bullet 顺序（先打通端到端主干） */
  tasks: PlannedTask[];
  /** 两三句：整体方案思路 */
  notes: string;
}

interface PlanReview {
  /** 必须修改才能开工的问题：会导致执行失败或方向错误的。没有就空数组 */
  blockers: string[];
  /** 建议性意见：改了更好、不改也能开工的。会移交验收员参考，不阻塞开工 */
  suggestions: string[];
}

interface AcceptanceResult {
  /** 验收标准（与任务书完成标准逐条对应） */
  criterion: string;
  /** 该条结果 */
  result: "pass" | "fail" | "blocked";
  /** 证据：实际执行的命令与输出摘要，或核对观察 */
  evidence: string;
}

interface TaskOutcome {
  /** 任务编号 */
  taskId: string;
  /** done=已完成；stuck=遇到无法自行决定的问题（或导师裁决后仍卡住） */
  status: "done" | "stuck";
  /** 验收回执：完成标准逐条结果。回执不等于证据，后面会被核对 */
  acceptance: AcceptanceResult[];
  /** 汇报：做了什么、改了哪些文件、关键过程 */
  summary: string;
  /** status=stuck 时：请教导师的问题，写清背景、已尝试什么、候选方案各是什么 */
  question?: string;
}

interface MentorDecision {
  /** 明确的裁决结论+理由，执行者拿去就能继续干 */
  answer: string;
}

interface ConsistencyReport {
  /** 已逐条核对的回执条目数 */
  checked: number;
  /** 回执与实际不一致之处：哪个任务哪条标准、回执怎么说、实际看到什么。全部一致就空数组 */
  mismatches: string[];
  /** 核对时实际运行过的命令 */
  commands: string[];
}

interface VerifyIssue {
  /** 问题位置：文件路径或模块名 */
  where: string;
  /** 一句话说清什么问题 */
  what: string;
  /** high=功能不可用/结果错误；medium=明显缺陷；low=小问题 */
  severity: "low" | "medium" | "high";
}

interface VerifyVerdict {
  /** pass=达标；fail=有问题必须修；pass_with_improvements=达标但有改进项 */
  verdict: "pass" | "fail" | "pass_with_improvements";
  /** 强制回答：相比基线（或上一验收节点），实际前进了什么。要对照基线 diff 说，不接受"自称完成" */
  progress: string;
  /** verdict=fail 时的问题清单 */
  issues: VerifyIssue[];
  /** 改进建议，不阻塞验收；验收员会负责写入 .planning/backlog.md */
  improvements: string[];
}

// [FORK] 模型分派表（2026-10-27 v1.3）：
//   规划师=GLM-5.3，计划审查员=强模型 —— 两个不同模型互审，防同款盲区；
//   执行者按任务 tier：simple→DeepSeek Flash / medium→GLM-5.3 / hard→GLM-5.3（hard 任务卡住可请教强模型导师）；
//   回执核对员=DeepSeek Flash（纯机械对照）；导师 / 计划审查员 / 验收员 / 修复工程师 = 强模型。要换模型或加档位，改这里。
// [ROUTING-SSOT] 权威表见 .zcode/workflow-drafts/ROUTING.md，改模型前先看这里
const OPUS = model("new-provider/claude-opus-5.5");
const GLM = model("new-provider-3/glm-5.3");
const FLASH = model("new-provider-2/deepseek-v4.1-flash");
// [FORK] 强模型开关：只有导师、计划审查员、验收员、修复工程师用它。
//        运行中 Opus 额度用完（运行被停下或长时间卡住）时：把下一行改成 `const STRONG = GLM;`，
//        再用 AmendWorkflow 指向本文件续跑，已完成的步骤按缓存规则复用，不用从头跑。
const STRONG = OPUS;
const MODEL_BY_TIER: Record<PlannedTask["tier"], ModelRef> = { hard: GLM, medium: GLM, simple: FLASH };
const TIER_ALIAS: Record<string, PlannedTask["tier"]> = {
  hard: "hard", opus: "hard", claude: "hard",
  medium: "medium", glm: "medium",
  simple: "simple", deepseek: "simple", flash: "simple",
};

const task = String(args.task ?? "").trim();
if (!task) throw new Error("缺少 task 参数：请传入自包含的任务描述（做什么、交付什么、涉及哪些文件）");

const quick = String(args.mode ?? "full").trim().toLowerCase() === "quick";
const humanGates = args.human_checkpoints === true;
const tierRaw = String(args.tier ?? "medium").trim().toLowerCase();
const quickTier = TIER_ALIAS[tierRaw] ?? "medium";

let maxFixRounds = Number(args.max_fix_rounds ?? 5);
if (!Number.isFinite(maxFixRounds)) maxFixRounds = 5;
maxFixRounds = Math.min(10, Math.max(1, Math.round(maxFixRounds)));

const acceptCmd = String(args.accept_cmd ?? "").trim();
const acceptMarkers = String(args.accept_markers ?? "")
  .split(/[;；\n]/)
  .map((s) => s.trim())
  .filter(Boolean);
if (acceptMarkers.length > 0 && !acceptCmd) {
  throw new Error("给了 accept_markers 却没有 accept_cmd：标记要从验收命令的输出里找");
}

// [FORK] 禁止再犯清单：规划师开工前读、计划审查员拿它检查计划。新踩的坑追加到这份文件里，不用改脚本。
//        换成你自己的路径；文件不存在时两个角色会跳过。
const LESSONS_PATH = "E:/Work/2pres_知识库/docs/工作流禁止再犯清单.md";

const taskResults: { id: string; title: string; tier: string; status: string; summary: string; acceptance: string }[] = [];
const unfinished: string[] = [];
let planSuggestions: string[] = [];
let planBlockersLeft: string[] = [];

artifact.board("tasks", {
  title: "任务看板",
  key: "taskId",
  status: "status",
  columns: ["执行中", "已完成", "卡住", "失败", "跳过"],
  cardTitle: "title",
  detail: [{ field: "summary", label: "汇报" }],
});

// 导师常驻一个会话：全项目裁决口径一致；每次裁决落盘 decision-log.md，后来的执行者先查日志再提问。
const mentor = agent("导师", {
  model: STRONG,
  system:
    "你是技术导师，只做裁决和讲解，不亲自改代码。执行者提出的每个问题：给出明确结论、理由，必要时给一小段示例。" +
    "每次裁决后把『问题→裁决→理由』追加写入 .planning/decision-log.md（目录不存在就创建），" +
    "让后来的执行者查日志即可、不必重复提问。",
});

const READ_RULES =
  "读文件纪律：先用 grep -n 定位，再按行范围读，单次读取不超过 120 行；同一文件的同一段不重复读；不要整份读日志或大文件。";

const EXECUTOR_SYSTEM =
  "你是开发者执行者，独立完成任务。规矩：开工前先读 .planning/decision-log.md（如存在），已有裁决直接照办，不要重复提问；" +
  "严格按任务书执行，不改任务范围外、约束里禁止的代码；验收命令必须真的执行；" +
  "任务书点名的输入文件（报告、findings、日志等）先用 ls 确认都在；找不到就 status=stuck 并写出找不到的路径，不得当成『无需处理』或『已处置』；" +
  READ_RULES +
  "省力纪律：每条验收命令只跑一次，长输出只看摘要（用 grep、tail 或计数取关键行），禁止反复全文重读交付物；" +
  "发现自己在重复同样的检查或同样的修改，立刻停下，按现状如实回填回执；" +
  "遇到无法自行决定的问题（需求歧义、方案取舍、验收方式自相矛盾），status 填 stuck 并在 question 里写清背景与候选方案，宁可提问也不要硬编；" +
  "如果任务确实无法完成，如实说明，绝不伪造完成。";

async function runTask(t: PlannedTask): Promise<string> {
  report({ taskId: t.id, title: t.title, status: "执行中", summary: "" }, "tasks");
  const executor = agent(`执行者-${t.id}`, { model: MODEL_BY_TIER[t.tier], system: EXECUTOR_SYSTEM });
  try {
    let outcome = await executor.ask<TaskOutcome>(
      `你的任务（编号 ${t.id}，档位 ${t.tier}）：\n${t.description}\n\n` +
        `收工前自查清单（全部满足才能 status=done，任何一条不满足就 stuck 并说明缺什么，不得交差）：\n` +
        `1. 完成标准逐条亲自验证，acceptance 数组逐条回填结果与证据（命令+输出摘要或核对观察）；\n` +
        `2. summary 里列清改动的文件清单；\n` +
        `3. 没有未说明的越界改动；有 blocked 项时如实标注而不是标 pass；\n` +
        `4. 回执里出现的任何数量（条数、行数、用例数、通过数）都必须来自命令输出（grep -c、wc -l、测试汇总行等），把命令和输出原样写进 evidence，禁止自己数。`,
    );
    let mentorRounds = 0;
    while (outcome.status === "stuck" && outcome.question && mentorRounds < 3) {
      mentorRounds += 1;
      log(`任务 ${t.id} 请教导师（第 ${mentorRounds} 次）`);
      const decision = await mentor.ask<MentorDecision>(
        `任务 ${t.id}（${t.title}）的执行者请教：\n${outcome.question}\n\n请裁决，并把本次裁决追加写入 .planning/decision-log.md。`,
      );
      outcome = await executor.ask<TaskOutcome>(
        `导师已就你的问题做出裁决：\n${decision.answer}\n\n按裁决继续完成任务；若裁决与事实矛盾导致仍无法继续，再次 status=stuck 说明原因。`,
      );
    }
    const status = outcome.status === "done" ? "已完成" : "卡住";
    if (outcome.status !== "done") unfinished.push(`${t.id} ${t.title}`);
    const acceptance = (outcome.acceptance ?? [])
      .map((a) => `  - [${a.result}] ${a.criterion}｜证据：${a.evidence}`)
      .join("\n");
    taskResults.push({ id: t.id, title: t.title, tier: t.tier, status, summary: outcome.summary, acceptance });
    report({ taskId: t.id, title: t.title, status, summary: outcome.summary.slice(0, 300) }, "tasks");
    return status;
  } catch (e) {
    unfinished.push(`${t.id} ${t.title}`);
    taskResults.push({ id: t.id, title: t.title, tier: t.tier, status: "失败", summary: String(e), acceptance: "" });
    report({ taskId: t.id, title: t.title, status: "失败", summary: String(e).slice(0, 300) }, "tasks");
    return "失败";
  }
}

interface PlanFileCheck {
  /** 工作区 .planning/ 下缺失的计划文件 */
  missing: string[];
  /** tasks.md 里对不上本次计划的任务编号（疑似上一次运行留下的旧文件） */
  stale: string[];
}

async function checkPlanFiles(p: Plan): Promise<PlanFileCheck> {
  const missing: string[] = [];
  for (const f of [".planning/PLAN.md", ".planning/tasks.md"]) {
    if ((await files.glob(f)).length === 0) missing.push(f);
  }
  const stale: string[] = [];
  if (missing.length === 0) {
    try {
      const text = await files.read(".planning/tasks.md");
      for (const t of p.tasks) {
        if (!text.includes(t.id) || !text.includes(t.title.slice(0, 8))) stale.push(t.id);
      }
    } catch {
      // tasks.md 超过读取上限时只按文件是否存在判断
    }
  }
  return { missing, stale };
}

function describePlanCheck(c: PlanFileCheck): string {
  const parts: string[] = [];
  if (c.missing.length > 0) parts.push(`缺少 ${c.missing.join("、")}`);
  if (c.stale.length > 0) parts.push(`.planning/tasks.md 里找不到本次计划的任务 ${c.stale.join("、")}（很可能是上一次运行留下的旧文件）`);
  return parts.join("；");
}

interface GateResult {
  /** 退出码为 0 且所有标记都出现 */
  passed: boolean;
  /** 验收命令的退出码；没能跑完时为 -1 */
  exitCode: number;
  /** 输出里没找到的标记 */
  missing: string[];
  /** 输出末尾，交给修复工程师定位问题 */
  tail: string;
}

const ACCEPT_LOG = ".planning/logs/accept.log";

// [FORK] 验收命令用 Git Bash 执行（本机安装路径）。工作流里不能直接写 "bash"，它不在命令搜索路径里；
//        Linux/mac 上把下面两处路径改成 "bash"。超时 60 分钟，回归更慢的项目改 timeoutMs。
async function runGate(): Promise<GateResult | null> {
  if (!acceptCmd) return null;
  let exitCode = -1;
  let tail = "";
  try {
    const r = await world.run(
      "C:/Program Files/Git/bin/bash.exe",
      [
        "-lc",
        `mkdir -p .planning/logs; ( ${acceptCmd}\n) > ${ACCEPT_LOG} 2>&1; code=$?; tail -n 60 ${ACCEPT_LOG} | tail -c 6000; exit $code`,
      ],
      { timeoutMs: 3_600_000 },
    );
    exitCode = r.exitCode;
    tail = r.stdout.trim();
  } catch (e) {
    return {
      passed: false,
      exitCode,
      missing: acceptMarkers,
      tail: `验收命令没能跑完（超过 60 分钟或无法启动）：${String(e).slice(0, 300)}`,
    };
  }
  let missing: string[] = [];
  if (acceptMarkers.length > 0) {
    const m = await world.run("C:/Program Files/Git/bin/bash.exe", [
      "-lc",
      'f="$1"; shift; for m in "$@"; do grep -qF -- "$m" "$f" || printf "%s\\n" "$m"; done',
      "_",
      ACCEPT_LOG,
      ...acceptMarkers,
    ]);
    missing = m.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  return { passed: exitCode === 0 && missing.length === 0, exitCode, missing, tail };
}

function describeGate(g: GateResult): string {
  const parts = [`退出码 ${g.exitCode}`];
  if (g.missing.length > 0) parts.push(`缺少标记 ${g.missing.join("、")}`);
  return parts.join("，");
}

function enforceGate(v: VerifyVerdict, g: GateResult | null): VerifyVerdict {
  if (!g || g.passed) return v;
  return {
    ...v,
    verdict: "fail",
    issues: [{ where: ACCEPT_LOG, what: `项目验收命令没通过：${describeGate(g)}`, severity: "high" }, ...v.issues],
  };
}

let plan: Plan;
if (quick) {
  plan = {
    taskCount: 1,
    planPath: "",
    tasksPath: "",
    baselineCommit: "",
    humanDecisions: [],
    notes: "quick 模式：跳过拆解与审查，单个执行者直通",
    tasks: [{
      id: "T1",
      title: task.slice(0, 40),
      tier: quickTier,
      description:
        `${task}\n\n（quick 模式：没有规划师给你写完成标准。开工前先自列不超过 5 条可验证的完成标准，` +
        `干完后逐条作为 acceptance 的 criterion 回填结果与证据。）`,
      dependsOn: [],
    }],
  };
  log(`quick 模式：跳过规划与审查，执行者档位 ${quickTier}`);
} else {
  phase("规划师拆解任务");
  // [FORK] 档案根固定为工作区根下的 .planning/：PLAN.md（含基线与决策清单）、tasks.md、decision-log.md、
  //        backlog.md、logs/。所有角色都用这个相对路径，规划完由脚本检查文件确实在这里——
  //        不要让规划师另选目录（v1.1 实测：会话目录与项目目录各长一套档案，修复任务找错地方漏修）。
  //        要换目录，把全文的 ".planning/" 一起替换，包括 checkPlanFiles。
  const planner = agent("规划师", {
    model: GLM,
    system:
      "你是项目规划师。职责：把任务拆解为可交给全新会话独立执行的任务清单。" +
      `开工前先读 ${LESSONS_PATH}（工作流的禁止再犯清单，读不到就跳过），计划不得重犯其中任何一条。` +
      "勘察只覆盖与任务直接相关的目录和文件，行号级的细节只核对任务书里要引用的位置，不做全库普查。" +
      "记录开工基线（git log -1 --format=%H 的当前 HEAD；不是 git 仓库就写 no-git 并说明改用什么快照做基准）。" +
      "所有计划文件一律写在当前工作目录（工作区根）下的 .planning/（不存在就创建），即使项目代码在子目录或别的目录里也不例外，不得另选目录；" +
      "任务过程中需要落盘的日志统一写到 .planning/logs/。" +
      ".planning/ 里如果已有上一次运行留下的文件，PLAN.md、tasks.md、decision-log.md 直接覆盖重写（旧裁决不适用于本次任务），backlog.md 保留。" +
      "在 .planning/ 下写三个文件：" +
      "PLAN.md（总体方案、顺序、风险、基线、待人工决策清单）、tasks.md（任务清单）、decision-log.md（先写入标题『# 决策日志』）。" +
      "每个任务描述按五段式写：①当前状态与涉及文件 ②起点（相对基线） ③完成标准（不超过 6 条，逐条可验收，优先可执行命令：命令+预期输出） " +
      "④约束（不许做什么） ⑤上下文提示。每个任务标注 tier（simple/medium/hard）、依赖关系明确。" +
      "任务顺序按 tracer-bullet 原则：先打通端到端最小主干，再填充外围。" +
      "把需要人工拍板的决策（方案取舍、命名、范围边界）整理成编号清单 D1、D2…，每条附建议答案与理由，写进 PLAN.md。" +
      "拆分守则：任务数最少化，不为流程而流程。能用 1 个任务完成的不拆；" +
      "同一文件的顺序编辑类任务（如写一份长文档），优先『一个会话写完 + 独立审校』共两个任务，" +
      "或让并行任务各写独立片段文件、最后一个任务合并——禁止为规避编辑冲突把同文件任务排成 3 个以上的串行长链；" +
      "串行依赖链超过 2 个任务时，必须在 PLAN.md 里说明为什么不能合并或改成片段并行。" +
      "工作流自带两道验收（每个任务做完由便宜模型核对回执 + 全部结束后强模型终验，终验会跑一次终态回归），" +
      "不要再排『终验、交付汇总、全量回归终跑』之类的任务；确实需要回归基线的，只在第一个任务里跑一次，日志写到 .planning/logs/。" +
      "你可以读写 .planning/、跑只读 git 命令、读代码，但不改业务代码。",
  });
  plan = await planner.ask<Plan>(
    `要完成的任务：\n${task}\n\n请勘察、拆解并落盘计划文件。` +
      (acceptCmd ? `\n\n终验前脚本会自动跑项目验收命令：${acceptCmd}，不用为它单独排任务。` : ""),
  );
  if (plan.tasks.length === 0) throw new Error("规划师没有产出任何任务，请检查 .planning/tasks.md 后重跑");
  let fileCheck = await checkPlanFiles(plan);
  if (fileCheck.missing.length > 0 || fileCheck.stale.length > 0) {
    log(`计划文件没有正确落在工作区的 .planning/ 下：${describePlanCheck(fileCheck)}，让规划师改正`);
    await planner.ask<string>(
      `检查发现：${describePlanCheck(fileCheck)}。` +
        `请把本次的 PLAN.md 和 tasks.md 写到（已有旧文件就覆盖）当前工作目录下的 .planning/，不要用别的目录，然后简要说明。`,
    );
    fileCheck = await checkPlanFiles(plan);
    if (fileCheck.missing.length > 0) {
      throw new Error(`规划师两次都没把计划写到工作区的 .planning/ 下：${describePlanCheck(fileCheck)}`);
    }
    if (fileCheck.stale.length > 0) {
      log(`提醒：tasks.md 仍对不上任务 ${fileCheck.stale.join("、")}，可能只是标题写法不同，继续执行；执行者以脚本下发的任务书为准`);
    }
  }
  plan.planPath = ".planning/PLAN.md";
  plan.tasksPath = ".planning/tasks.md";
  log(`计划：${plan.taskCount} 个任务 → ${plan.planPath}（基线 ${plan.baselineCommit || "未记录"}）`);

  phase("独立审查计划");
  // 审查员用强模型做深度审查。只有 blockers 阻塞开工；suggestions 记下移交验收员，防止为完美主义空转。
  const reviewer = agent("计划审查员", {
    model: STRONG,
    system:
      "你是计划审查员，没有参与写计划。对照实际代码库审查 .planning/PLAN.md 与 tasks.md，专挑会导致执行失败的问题：" +
      "任务不自包含、完成标准不可验收、依赖关系错误、tier 标注明显不合理、颗粒度失衡（该合并不合并、串行长链无理由）、整体方案有方向性漏洞、端到端主干没有最先打通。" +
      "同时审查待人工决策清单：有没有漏掉必须人拍板的决策、建议答案是否靠谱。" +
      `再对照 ${LESSONS_PATH}（工作流的禁止再犯清单，读不到就跳过）检查计划，重犯其中任何一条都算 blocker。` +
      "意见必须分级：会导致执行失败或方向错误的放 blockers；改了更好、不改也能开工的放 suggestions。" +
      "不要把措辞、格式、锦上添花的问题放进 blockers。只读不写，不改任何文件。",
  });
  let review: PlanReview | undefined;
  for (let round = 1; round <= 2; round++) {
    review = await reviewer.ask<PlanReview>(
      round === 1
        ? `请审查 ${plan.planPath} 与 ${plan.tasksPath}（共 ${plan.taskCount} 个任务），给出 blockers 与 suggestions。`
        : `规划师已按你的 blockers 修订，请重新审查 ${plan.planPath} 与 ${plan.tasksPath}，只确认 blockers 是否已解决、有无新的 blocker。`,
    );
    if (review.blockers.length === 0) break;
    log(`第 ${round} 轮审查：${review.blockers.length} 个必须修改、${review.suggestions.length} 条建议`);
    if (round < 2) {
      await planner.ask<string>(
        `审查员提出了必须修改的问题：\n${review.blockers.join("\n")}\n\n` +
          `另有建议（可选采纳）：\n${review.suggestions.join("\n") || "无"}\n\n` +
          `请修订 .planning/PLAN.md 与 tasks.md 后简要说明改了什么。`,
      );
    }
  }
  planBlockersLeft = review ? review.blockers : [];
  planSuggestions = review ? review.suggestions : [];
  if (planBlockersLeft.length > 0) log("两轮审查后仍有未解决的必改问题，带着意见开工，验收员会重点核对");

  if (humanGates) {
    const decisionList =
      plan.humanDecisions.length > 0
        ? plan.humanDecisions.map((d) => `${d.id}. ${d.question}\n   建议：${d.recommendation}`).join("\n")
        : "（规划师没有列出需要人工拍板的决策）";
    await hole<void>(
      "人工确认计划",
      `计划在 ${plan.planPath}（${plan.taskCount} 个任务），审查结论：${planBlockersLeft.length === 0 ? "无必改问题" : `仍有 ${planBlockersLeft.length} 个必改问题未解决`}。\n` +
        `需要你拍板的决策（按编号回复决定，或回复"按建议全部通过"；如需修改计划，回复改动要求）：\n${decisionList}`,
    );
  }
}

phase("逐任务执行并核对回执");
// [FORK] 任务调度：每个任务在它依赖的任务全部结束后立即开工（不等同批其他任务）；
//        任何一个依赖没有"已完成"，该任务直接标记"跳过"，不白干。依赖成环时，环及其下游按计划顺序串行。
//        执行者只喂单个任务的五段式任务书，主流程不碰代码，只调度与核对。
const allIds = new Set<string>(plan.tasks.map((t) => t.id));
const seenId = new Set<string>();
plan.tasks.forEach((t, i) => {
  let id = t.id && t.id.trim() ? t.id.trim() : `T${i + 1}`;
  while (seenId.has(id)) id = `${id}-${i}`;
  seenId.add(id);
  t.id = id;
  t.dependsOn = (t.dependsOn ?? []).filter((d) => allIds.has(d) && d !== t.id);
});

const ordered: PlannedTask[] = [];
const placed = new Set<string>();
let progressed = true;
while (progressed) {
  progressed = false;
  for (const t of plan.tasks) {
    if (!placed.has(t.id) && t.dependsOn.every((d) => placed.has(d))) {
      ordered.push(t);
      placed.add(t.id);
      progressed = true;
    }
  }
}
const leftover = plan.tasks.filter((t) => !placed.has(t.id));
if (leftover.length > 0) {
  log(`任务依赖成环：${leftover.map((t) => t.id).join("、")} 改为按计划顺序串行执行`);
  let prev = "";
  for (const t of leftover) {
    t.dependsOn = t.dependsOn.filter((d) => placed.has(d));
    if (prev) t.dependsOn.push(prev);
    prev = t.id;
    ordered.push(t);
  }
}

const baselineLine =
  !quick && plan.baselineCommit
    ? `计划基线：${plan.baselineCommit}。是 commit 哈希就先用 git diff 对照它核对实际改动；是 no-git 就按 PLAN.md 记录的快照基准核对。\n`
    : "";
const CHECKER_SYSTEM =
  "你是回执核对员，只做机械对照，不评价方案好坏、不改任何文件。" +
  "核对手段只限读：打开回执提到的文件和 .planning/logs/ 下的日志，用 grep -c、wc -l、git log、git diff --stat 这类几秒内跑完的只读命令取数。" +
  "禁止重跑测试、回归套件或任何要跑几分钟的命令——这些结果以已落盘的日志为准；回执说跑过、却找不到对应日志的，记一条 mismatch。" +
  "对每条验收标准，把『回执说的』和『实际看到的』对比；回执里的数字用计数命令复核；不一致就记一条 mismatch。" +
  READ_RULES;

// 每个任务一结束就派一个核对员核它自己的回执，和其他还在跑的任务同时进行；
// 下游任务只等上游任务本身结束，不等上游的核对。
const finished = new Map<string, Promise<string>>();
const checks: Promise<ConsistencyReport>[] = [];
for (const t of ordered) {
  const depRuns: Promise<string>[] = [];
  for (const d of t.dependsOn) {
    const dep = finished.get(d);
    if (dep) depRuns.push(dep);
  }
  const run = future(async () => {
    const depStatus = await Promise.all(depRuns);
    if (depStatus.some((s) => s !== "已完成")) {
      const reason = `依赖 ${t.dependsOn.join("、")} 未全部完成，跳过不执行`;
      unfinished.push(`${t.id} ${t.title}（已跳过）`);
      taskResults.push({ id: t.id, title: t.title, tier: t.tier, status: "跳过", summary: reason, acceptance: "" });
      report({ taskId: t.id, title: t.title, status: "跳过", summary: reason }, "tasks");
      return "跳过";
    }
    return runTask(t);
  });
  finished.set(t.id, run);
  checks.push(
    future(async () => {
      await run;
      const r = taskResults.find((x) => x.id === t.id);
      if (!r || !r.acceptance) return { checked: 0, mismatches: [], commands: [] };
      try {
        const rep = await agent(`回执核对员-${t.id}`, { model: FLASH, system: CHECKER_SYSTEM }).ask<ConsistencyReport>(
          `${baselineLine}请逐条核对任务 ${t.id} 的执行回执：\n[${r.id}｜${r.tier}｜${r.status}] ${r.summary}\n${r.acceptance}`,
        );
        return { ...rep, mismatches: rep.mismatches.map((m) => `[${t.id}] ${m}`) };
      } catch (e) {
        return { checked: 0, mismatches: [`[${t.id}] 回执核对没有完成：${String(e).slice(0, 200)}`], commands: [] };
      }
    }),
  );
}
// 终验要看完整交付和全部核对结果，必须等所有任务和所有核对都结束
const [, checkReports] = await Promise.all([Promise.all([...finished.values()]), Promise.all(checks)]);
const doneCount = taskResults.filter((r) => r.status === "已完成").length;
log(`执行完毕：${doneCount}/${taskResults.length} 个任务完成`);

const receiptLine = taskResults
  .map((r) => `[${r.id}｜${r.tier}｜${r.status}] ${r.summary}${r.acceptance ? `\n${r.acceptance}` : ""}`)
  .join("\n\n");
const consistency: ConsistencyReport = {
  checked: checkReports.reduce((n, c) => n + c.checked, 0),
  mismatches: checkReports.flatMap((c) => c.mismatches),
  commands: checkReports.flatMap((c) => c.commands),
};
log(`回执核对：${consistency.checked} 条，${consistency.mismatches.length} 处不一致`);

phase("终验与修复循环");
// [FORK] 修复工程师和验收员用强模型 STRONG（见模型分派表）；想换档位改那里。
const fixer = agent("修复工程师", {
  model: STRONG,
  system:
    "你是修复工程师，针对验收员列出的问题做最小修复：只修列出的问题，不做无关重构，" +
    "绝不靠删测试、改断言、放宽验收让问题消失。开工前先用 ls 确认问题清单点名的文件都在；" +
    "找不到就如实写出找不到的路径，不得当成『无需修复』或『已处置』。" +
    READ_RULES +
    "修完简要说明：改了什么、为什么、动了哪些文件。",
});
const verifier = agent("验收员", {
  model: STRONG,
  system:
    "你是验收员，独立于执行者与修复工程师，做最终判定。你手上有回执核对员的逐条对照结果：" +
    "核对员标出的不一致之处必须亲自查实；其余部分只抽查最关键的一两条命令亲自重跑，不要把核对员做过的再全做一遍。" +
    "有 commit 基线时用 git diff 基线..工作区核对改动范围，用 git status 查有没有未说明的越界改动。" +
    "结论三态：pass / fail（附问题清单）/ pass_with_improvements（达标但有改进项）。" +
    "必须回答 progress：相比基线（或上一验收节点）实际前进了什么——只有自述、没有对应改动证据的不算前进，原地打转的返工要如实指出。" +
    "需要全量回归时只跑一次终态回归，输出写到 .planning/logs/final-regression.log；复查轮只重跑和问题相关的部分。" +
    READ_RULES +
    "改进项由你追加写入 .planning/backlog.md（目录不存在就创建）。如果验收本身无法进行，如实说明，不要硬给结论。",
});
const contextLine = quick
  ? `原始任务：\n${task}`
  : `计划：${plan.planPath}，任务清单：${plan.tasksPath}，决策日志：.planning/decision-log.md` +
    (planBlockersLeft.length > 0 ? `\n计划审查未解决的必改问题（重点核对）：\n${planBlockersLeft.join("\n")}` : "") +
    (planSuggestions.length > 0 ? `\n计划审查建议（参考）：\n${planSuggestions.join("\n")}` : "");
const consistencyLine =
  `回执核对员结果：核对 ${consistency.checked} 条；运行过的命令：${consistency.commands.join("；") || "无"}\n` +
  `不一致之处：\n${consistency.mismatches.join("\n") || "无"}`;
// 项目自带的验收命令最硬：先由脚本跑，没过直接修；过了验收员只看它覆盖不到的问题。
let fixRounds = 0;
let gate = await runGate();
while (gate && !gate.passed && fixRounds < maxFixRounds) {
  fixRounds += 1;
  log(`项目验收命令没通过（${describeGate(gate)}），第 ${fixRounds} 轮修复`);
  await fixer.ask<string>(
    `项目验收命令没有通过：${describeGate(gate)}。输出末尾：\n${gate.tail}\n\n完整输出在 ${ACCEPT_LOG}。` +
      `请定位并修复。不许修改验收命令或检查脚本本身让它通过；修完不用自己跑这条命令，脚本会重跑。`,
  );
  gate = await runGate();
}
if (gate && !gate.passed) {
  return {
    conclusion: `${fixRounds} 轮修复后项目验收命令仍没通过（${describeGate(gate)}），没有进入终验，需要人工介入。完整输出在 ${ACCEPT_LOG}。`,
    verdict: "fail",
    gate,
    tasks: taskResults,
    fixRounds,
    planPath: plan.planPath,
    notCovered: ["项目验收命令没通过，验收员没有做终验"],
  };
}
if (gate) log(`项目验收命令通过：${acceptCmd}`);
const gateLine = gate
  ? `项目验收命令已由脚本执行并通过：${acceptCmd}（退出码 0` +
    (acceptMarkers.length > 0 ? `，标记 ${acceptMarkers.join("、")} 全部出现` : "") +
    `，输出在 ${ACCEPT_LOG}）。这条命令你不用再跑，只判断它覆盖不到的问题。\n`
  : "";

let verdict = await verifier.ask<VerifyVerdict>(
  `${gateLine}${baselineLine}${contextLine}\n\n各任务执行回执：\n${receiptLine}\n\n${consistencyLine}\n\n请做最终验收并给出三态结论。`,
);
log(`首验结论：${verdict.verdict}`);
while (verdict.verdict === "fail" && fixRounds < maxFixRounds) {
  fixRounds += 1;
  await fixer.ask<string>(
    `验收未通过（第 ${fixRounds} 轮），问题清单：\n${verdict.issues.map((i) => `[${i.severity}] ${i.where}：${i.what}`).join("\n")}\n\n请针对修复。`,
  );
  gate = await runGate();
  const recheck = !gate
    ? ""
    : gate.passed
      ? "脚本重跑了项目验收命令，仍然通过。"
      : `脚本重跑了项目验收命令，没有通过（${describeGate(gate)}），输出末尾：\n${gate.tail}\n`;
  verdict = enforceGate(
    await verifier.ask<VerifyVerdict>(
      `修复工程师完成了第 ${fixRounds} 轮修复。${recheck}请只针对上一轮的问题清单亲自复查，重新回答三态与 progress。`,
    ),
    gate,
  );
  log(`第 ${fixRounds} 轮修复后：${verdict.verdict}`);
}

if (verdict.verdict === "fail") {
  return {
    conclusion: `${maxFixRounds} 轮修复后验收仍未通过，需要人工介入。未完成项：${unfinished.length > 0 ? unfinished.join("；") : "无"}。过程文件见 .planning/。`,
    verdict: verdict.verdict,
    issues: verdict.issues,
    gate,
    tasks: taskResults,
    fixRounds,
    planPath: plan.planPath,
    notCovered: ["修复轮数上限已到，剩余问题未修复"],
  };
}

const md = [
  "# 开发完成报告",
  "",
  `**任务**：${task}`,
  "",
  `**结论**：${verdict.verdict === "pass" ? "验收通过" : "验收通过，附改进项"}（修复 ${fixRounds} 轮）`,
  "",
  `**实际进展**：${verdict.progress}`,
  "",
  !quick && plan.baselineCommit ? `**基线**：${plan.baselineCommit}` : "",
  gate
    ? `**项目验收命令**：\`${acceptCmd}\` 通过` +
      (acceptMarkers.length > 0 ? `（标记 ${acceptMarkers.join("、")} 全部出现）` : "")
    : "",
  "",
  "## 任务执行",
  ...taskResults.map((r) => `- [${r.id}] ${r.title} — ${r.tier} → ${r.status}`),
  "",
  `回执核对：${consistency.checked} 条，${consistency.mismatches.length} 处不一致（已交验收员查实）`,
  "",
  ...(unfinished.length > 0 ? [`**未完成**：${unfinished.join("；")}`, ""] : []),
  ...(verdict.improvements.length > 0
    ? ["## 改进项（已记入 .planning/backlog.md）", ...verdict.improvements.map((s) => `- ${s}`), ""]
    : []),
  `过程文件：${quick ? "quick 模式未落盘计划" : `${plan.planPath}、${plan.tasksPath}、.planning/decision-log.md`}`,
].filter(Boolean).join("\n");
await artifact.markdown("summary", md, {
  title: "开发完成报告",
  description: `三态验收：${verdict.verdict}；修复 ${fixRounds} 轮。`,
  primary: true,
});

return {
  conclusion: `任务完成：${verdict.verdict === "pass" ? "验收通过" : "验收通过，改进项已记入 backlog"}。${verdict.progress}`,
  verdict: verdict.verdict,
  progress: verdict.progress,
  tasks: taskResults,
  improvements: verdict.improvements,
  fixRounds,
  planPath: plan.planPath,
  baselineCommit: plan.baselineCommit,
  verified: [
    "执行者逐条回填了验收回执（每条标准 pass/fail/blocked + 证据）",
    `回执核对员逐条对照了回执与实际结果（${consistency.checked} 条）`,
    "验收员查实了全部不一致之处，并抽查重跑了关键命令",
    ...(gate
      ? [
          `项目验收命令 ${acceptCmd} 由脚本执行，退出码 0` +
            (acceptMarkers.length > 0 ? `，标记 ${acceptMarkers.join("、")} 全部出现` : ""),
        ]
      : []),
  ],
  notCovered: [
    ...(quick ? ["quick 模式：未做计划拆解与独立计划审查"] : []),
    ...(acceptCmd ? [] : ["没有提供项目验收命令（accept_cmd），终验只靠模型判断"]),
    ...(unfinished.length > 0 ? ["未完成或跳过的任务：" + unfinished.join("；")] : []),
  ],
};
