// index.ts — pi 接線：事件、命令、工具、切換（SPEC Part 11、Part 5、Part 10）。
//
// 接線契約見 SPEC Part 11「index.ts 接線契約」節（2026-10-01 定）。
// 整個路由鉤子 fail-open（Part 2）：任何异常都不擋住使用者的回合。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadConfig, validatePatch, writeConfigPatch } from "./config/load.js";
import { loadSpend } from "./budget.js";
import { compose } from "./route/compose.js";
import { selectTargets, menuKeys, targetKey } from "./route/select.js";
import { guard, type GuardState } from "./route/guard.js";
import { applyRoute, type ApplyHooks } from "./route/apply.js";
import { createLayaClassifier } from "./classify/laya.js";
import { createCloudClassifier } from "./classify/cloud.js";
import { reloadClassifier } from "./classify/lifecycle.js";
import type { Classifier, Judgment } from "./classify/types.js";
import { type RouteEntry } from "./ui/entries.js";
import { renderEntryCard } from "./ui/entry-card.js";
import { suggest } from "./suggest.js";
import { runSettingsWizard, type CandidateKind, type WizardHooks } from "./ui/wizard.js";
import { cloudClassifierKeys, localCheckpoints, openRouterModelKeys } from "./ui/sources.js";
import type { CompassConfig, Mode, Target, ThinkingLevel, Tier } from "./schema.js";

/** session 生命週期持有的資源（`session_start` 開、`session_shutdown` 收）。 */
interface SessionState {
  config: CompassConfig;
  classifier?: Classifier;
  /** 上一次 auto-switch 之前的模型，供 `/compass revert`（Part 10.1）。 */
  previousModel?: string;
  /** 本次 session 的切換次數（`/compass status` 的 `switches: N`）。 */
  switches: number;
}

/** 追蹤 session 狀態（工廠不啟動行程，狀態在 session_start 填）。 */
function createState(): SessionState {
  return { config: loadConfig().config, switches: 0 };
}

/** 當前模型 → Target 形狀（`provider/id`，供 guard stickiness 比對）。 */
function currentTarget(ctx: ExtensionContext): { model: string; tier: Tier | null } | null {
  const model = ctx.model;
  if (!model) return null;
  return { model: `${model.provider}/${model.id}`, tier: null };
}

/** 解析 Target → pi Model；找不到回 undefined（可用性，Stage 4 實作契約第 1 點）。 */
function resolveModel(ctx: ExtensionContext, target: Target): ReturnType<ExtensionContext["modelRegistry"]["find"]> {
  if (!target.provider) return undefined;
  return ctx.modelRegistry.find(target.provider, target.model);
}

/** 給 classify 的種類集合（`taskKinds` 的 keys）。 */
function kindsOf(config: CompassConfig): readonly string[] {
  return Object.keys(config.taskKinds);
}

/**
 * 路由鉤子：每輪 agent 前跑 Stage 1–5（Part 5）。
 * **整段包 try/catch**——fail-open，任何异常不得擋住回合（Part 2）。
 */
async function routeTurn(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: SessionState,
  prompt: string,
): Promise<void> {
  const config = state.config;
  if (!config.enabled) return;
  // 過短 → continuation（Part 5 Stage 1），直接 skipped。
  if (prompt.length < config.classify.minPromptChars) {
    writeEntry(pi, { symbol: "×", tier: null, target: null, reason: "continuation" });
    return;
  }

  const signal = ctx.signal ?? new AbortController().signal;

  // Stage 1 — classify（menu 組 key 與 select 一致）。
  let judgment: Judgment | undefined;
  if (state.classifier) {
    try {
      const menu = menuKeys(compose(undefined, config).tier, undefined, config);
      judgment = await state.classifier.classify(
        { request: prompt, kinds: kindsOf(config), menu },
        signal,
      );
    } catch {
      judgment = undefined; // 超時/失敗 → fail-open，Stage 2 用 tier 預設
    }
  }

  // Stage 2 — compose。
  const composed = compose(judgment, config);

  // Stage 3 — select（picked 頂置）。
  const selected = selectTargets(composed.tier, judgment, config);

  // 可用性回退（Stage 4 實作契約第 1 點）：逐個試到第一個可用模型。
  let chosen: Target | undefined = selected.picked;
  let available: Target | undefined = chosen ? resolveModel(ctx, chosen) && chosen : undefined;
  if (!available) {
    for (const candidate of selected.chain) {
      if (resolveModel(ctx, candidate)) {
        available = candidate;
        break;
      }
    }
  }
  if (!available) {
    writeEntry(pi, {
      symbol: "×",
      tier: composed.tier,
      target: null,
      reason: "no route available",
      notes: selected.notes,
    });
    return;
  }

  // Stage 4 — guard。
  const current = currentTarget(ctx);
  const spend = loadSpend();
  const state4: GuardState = {
    currentModel: current?.model ?? null,
    currentTier: null,
    todayUsd: spend.todayUsd,
    monthUsd: spend.monthUsd,
    lastSwitchAtMs: null,
    // cachePenaltyUsd 需要 context token 與費率——呼叫端有價格時才算（Part 7）；
    // 此處未提供 → 跳過 cache 這步（價格未知不擋切換）。
  };
  const result = guard(
    { target: available, tier: composed.tier, demand: composed.demand },
    state4,
    config,
    config.mode,
  );

  // Stage 5 — apply（hooks 接 pi / ctx）。
  const hooks = buildHooks(pi, ctx);
  const outcome = await applyRoute(
    {
      outcome: result.outcome,
      target: available,
      thinking: composed.thinking,
      mode: config.mode,
      tier: result.tier,
      reason: result.reason,
      classify: judgment
        ? { source: judgment.source, latencyMs: judgment.latencyMs, hit: judgment.cacheHit ?? false }
        : { source: "fallback", latencyMs: 0, hit: false },
      demand: composed.demand,
      notes: selected.notes,
    },
    hooks,
  );

  // confirm 模式：apply 只標 needsConfirm，此處問（有 UI 時）。
  if (outcome.needsConfirm && ctx.hasUI) {
    const yes = await ctx.ui.confirm("Switch model?", `${available.provider}/${available.model} for this turn`);
    if (yes) {
      const applied = await applyRoute(
        { outcome: "applied", target: available, thinking: composed.thinking, mode: "auto", tier: result.tier },
        hooks,
      );
      if (applied.applied) state.switches += 1;
    }
  } else if (outcome.applied) {
    state.switches += 1;
  }
  if (outcome.applied && state.config.mode === "auto") {
    state.previousModel = current?.model;
  }
}

/** Stage 5 hooks：接 pi 的 setModel/setThinkingLevel + ctx 的 entry 寫入。 */
function buildHooks(pi: ExtensionAPI, ctx: ExtensionContext): ApplyHooks {
  return {
    async setModel(key: string): Promise<void> {
      const slash = key.indexOf("/");
      const provider = slash > 0 ? key.slice(0, slash) : "";
      const modelId = slash > 0 ? key.slice(slash + 1) : key;
      const model = ctx.modelRegistry.find(provider, modelId);
      if (!model) throw new Error(`model not found: ${key}`);
      const ok = await pi.setModel(model);
      if (!ok) throw new Error(`auth not configured for ${key}`);
    },
    setThinkingLevel(level: ThinkingLevel): void {
      pi.setThinkingLevel(level);
    },
    readThinkingLevel(): ThinkingLevel | undefined {
      return pi.getThinkingLevel();
    },
    writeEntry(entry: RouteEntry): void {
      writeEntry(pi, entry);
    },
  };
}

/** 寫一條 transcript entry（不進 LLM context，Part 5 Stage 5）。 */
function writeEntry(pi: ExtensionAPI, entry: RouteEntry): void {
  pi.appendEntry("compass", entry);
}

/**
 * 載入設定，並依**分類器輸入是否變動**決定要不要重建分類器
 *（`classify/lifecycle.ts`）。回載入後的設定（`/compass-set` 重繪用）。
 *
 * 輸入沒變就保留既有分類器（含暖好的 laya 子行程）——不然改個預算都會
 * 把已載好的模型殺掉；重建時一律立刻 `warm()`（與 session 啟動同一行為）。
 */
function reloadConfig(state: SessionState): CompassConfig {
  const result = loadConfig();
  reloadClassifier(state, result.config, (config) => {
    if (config.classify.provider === "laya") return createLayaClassifier(config);
    if (config.classify.provider === "cloud") return createCloudClassifier(config);
    return undefined; // 未知後端：不建分類器（路由走 tier 預設，fail-open）
  });
  return state.config;
}
/**
 * pi 擴充入口。pi 要求 **`export default` 工廠**（實測：命名匯出 `register()`
 * 會報 `does not export a valid factory function`，見 Part 11 接線契約）。
 * 工廠本身**不啟動行程/計時器**——長生命資源在 `session_start` 開（Part 4.2）。
 */
export default function compass(pi: ExtensionAPI): void {
  const state = createState();

  // session lifecycle：載入設定 + 預熱 laya（由 reloadConfig 重建時預熱，
  // 輸入沒變則沿用既有的暖子行程）；關閉時拆除。
  pi.on("session_start", () => {
    reloadConfig(state);
  });
  pi.on("session_shutdown", () => {
    state.classifier?.dispose?.();
    state.classifier = undefined;
  });

  // 路由鉤子：每輪 agent 前（Part 5）。fail-open 在 routeTurn 內。
  pi.on("before_agent_start", async (event, ctx) => {
    await routeTurn(pi, ctx, state, event.prompt);
  });

  // transcript entry 渲染（Part 10.4）：主題化卡片（ui/entry-card.ts）。
  // 收合一列脈絡、展開樹狀明細；內容來自 entries.ts（吃 display 設定）。
  pi.registerEntryRenderer<RouteEntry>("compass", (entry, options, theme) => {
    const data = entry.data ?? { symbol: "·" as const, tier: null, target: null };
    return renderEntryCard(data, { expanded: options.expanded, display: state.config.display }, theme);
  });

  registerCommands(pi, state);
  registerTools(pi, state);
}

/** `/compass` 與其子命令（Part 10.1）。 */
function registerCommands(pi: ExtensionAPI, state: SessionState): void {
  pi.registerCommand("compass", {
    description: "compass 狀態 / on|off / mode / budget / why / revert / suggest",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      switch (sub) {
        case undefined:
          return showStatus(ctx, state);
        case "on":
          state.config.enabled = true;
          return ctx.ui.notify("compass on (session)", "info");
        case "off":
          state.config.enabled = false;
          return ctx.ui.notify("compass off (session)", "info");
        case "mode": {
          const mode = rest[0] as Mode | undefined;
          if (mode === "auto" || mode === "confirm" || mode === "notify") {
            state.config.mode = mode;
            return ctx.ui.notify(`mode ${mode} (session)`, "info");
          }
          return ctx.ui.notify("mode: expected auto|confirm|notify", "warning");
        }
        case "budget": {
          const dim = rest[0] === "monthly" ? "monthlyUsd" : "dailyUsd";
          const value = rest[1] === "none" || rest[1] === undefined ? null : Number(rest[1]);
          if (value !== null && !Number.isFinite(value)) return ctx.ui.notify("budget: expected a number or 'none'", "warning");
          (state.config.budget as unknown as Record<string, number | null>)[dim] = value;
          return ctx.ui.notify(`${dim} ${value === null ? "cleared" : `$${value}`}`, "info");
        }
        case "why":
          return showStatus(ctx, state, true);
        case "revert":
          return ctx.ui.notify(state.previousModel ? `revert → ${state.previousModel}` : "nothing to revert", "info");
        case "suggest":
          return showSuggest(ctx, state);
        default:
          return ctx.ui.notify(`unknown subcommand: ${sub}`, "warning");
      }
    },
  });

  pi.registerCommand("compass-set", {
    description: "/compass-set 設定選單（寫 config.json + 時間戳備份）",
    handler: async (_args, ctx) => {
      const hooks: WizardHooks = {
        write: (key, value) => writeConfigPatch({ [key]: value }),
        // 回傳新設定物件：reload 會換掉 session 的設定，選單要改畫新物件。
        reload: () => reloadConfig(state),
        prompt: async (label, initial) => (await ctx.ui.input(label, initial)) ?? null,
        pick: async (label, options) => (await ctx.ui.select(label, options)) ?? null,
        notify: (message, type) => ctx.ui.notify(message, type ?? "info"),
        // 測試分類器：跑一輪真分類（不切換），回一列結果供「重設・診斷」顯示。
        probeClassifier: async () => {
          const classifier = state.classifier;
          if (!classifier) return "沒有分類器（backend 未啟用）";
          const started = Date.now();
          try {
            const judgment = await classifier.classify(
              { request: "回一個字就好", kinds: kindsOf(state.config) },
              AbortSignal.timeout(8000),
            );
            const ms = Date.now() - started;
            return `${classifier.id} ${ms}ms · kind ${judgment.kind} ${Math.round(judgment.kindConfidence * 100)}% · cache ${judgment.cacheHit ? "hit" : "miss"}`;
          } catch (error) {
            return `分類失敗：${error instanceof Error ? error.message : String(error)}`;
          }
        },
        // 候選來源（選單純資料，I/O 全在這裡）：失敗一律回空 → 該項退回打字。
        candidates: async (kind: CandidateKind): Promise<string[]> => {
          try {
            if (kind === "checkpoint") return localCheckpoints();
            if (kind === "classifier") {
              // cloud 端點只吃 typesafe；registry 其餘分類模型掛在 openrouter
              // 等 provider 下，選了會讓分類直接失效（見 sources.ts 說明）。
              return cloudClassifierKeys(ctx.modelRegistry.getModelsOfType("classifier"));
            }
            // registry（pi 的 models-store）∪ OpenRouter 最新清單（API）：
            // store 可能落後上架的新模型，線上清單補上（內部 24h 快取、
            // 斷線 fail-safe 回空）。
            const registryKeys = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);
            const liveKeys = await openRouterModelKeys();
            return [...registryKeys, ...liveKeys];
          } catch {
            return [];
          }
        },
      };
      await runSettingsWizard(state.config, hooks);
    },
  });

  pi.registerCommand("compass-route", {
    description: "/compass-route <text> 分類任意文字並顯示建議（不切換）",
    handler: async (args, ctx) => {
      if (!args.trim()) return ctx.ui.notify("compass-route: expected some text", "warning");
      const composed = compose(undefined, state.config);
      const selected = selectTargets(composed.tier, undefined, state.config);
      const first = selected.picked ?? selected.chain[0];
      ctx.ui.notify(first ? `→ ${composed.tier} ${targetKey(first)}` : "no route available", "info");
    },
  });
}

/** 顯示狀態（Part 10.3 / 10.1 `/compass`）。 */
async function showStatus(ctx: ExtensionContext, state: SessionState, why = false): Promise<void> {
  const spend = loadSpend();
  const pressure = Math.max(
    state.config.budget.dailyUsd ? spend.todayUsd / state.config.budget.dailyUsd : 0,
    state.config.budget.monthlyUsd ? spend.monthUsd / state.config.budget.monthlyUsd : 0,
  );
  const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
  const lines = [
    `compass:${state.config.enabled ? "on" : "off"} · $${spend.todayUsd.toFixed(2)} today · ${Math.round(pressure * 100)}% · ${state.config.mode}`,
    `model ${current} · switches ${state.switches} · profile ${state.config.profile}`,
    `routes quick[${state.config.routes.quick.length}] standard[${state.config.routes.standard.length}] high[${state.config.routes.high.length}]`,
  ];
  if (why) lines.push(`classify ${state.config.classify.provider} · timeout ${state.config.classify.timeoutMs}ms`);
  ctx.ui.notify(lines.join("\n"), "info");
}

/** `/compass suggest`：分數檔提議（不切換，Part 10.1）。 */
async function showSuggest(ctx: ExtensionContext, state: SessionState): Promise<void> {
  try {
    const list = await suggest(state.config);
    if (list.length === 0) return ctx.ui.notify("no suggestions (set suggest.scoresFile)", "info");
    ctx.ui.notify(list.map((s) => `${s.tier} ${targetKey(s.target)} — ${s.reason}`).join("\n"), "info");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

/** 兩個 model-calling 工具（Part 1）。 */
function registerTools(pi: ExtensionAPI, state: SessionState): void {
  pi.registerTool({
    name: "compass_route",
    label: "compass route",
    description: "Classify arbitrary text and show the recommended tier + model (does not switch).",
    parameters: Type.Object({ text: Type.String({ description: "Text to classify" }) }),
    async execute(_id, _params) {
      const composed = compose(undefined, state.config);
      const selected = selectTargets(composed.tier, undefined, state.config);
      const target = selected.picked ?? selected.chain[0];
      const text = target
        ? `tier ${composed.tier} · demand ${composed.demand.toFixed(2)} → ${targetKey(target)}`
        : "no route available";
      return { content: [{ type: "text", text }], details: { tier: composed.tier, demand: composed.demand } };
    },
  });

  pi.registerTool({
    name: "compass_config",
    label: "compass config",
    description: "Validate and write one whitelisted compass setting to config.json (with a timestamped backup).",
    parameters: Type.Object({
      key: Type.String({ description: "Setting key (whitelisted)" }),
      value: Type.Unknown({ description: "New value" }),
    }),
    async execute(_id, params) {
      const problem = validatePatch(params.key, params.value);
      if (problem) return { content: [{ type: "text", text: problem }], details: { ok: false }, isError: true };
      const writeProblem = writeConfigPatch({ [params.key]: params.value });
      if (writeProblem) return { content: [{ type: "text", text: writeProblem }], details: { ok: false }, isError: true };
      reloadConfig(state);
      return { content: [{ type: "text", text: `wrote ${params.key}` }], details: { ok: true } };
    },
  });
}

/** 保留骨架的 `register()` 命名匯出作別名（部分載入器可能找它）。 */
export function register(): void {
  // 實際註冊在 default 工廠內（pi 只載 default）；此函式保留相容性。
  throw new Error("use the default export: pi loads `export default function(pi)`");
}
