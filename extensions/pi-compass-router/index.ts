// index.ts — pi 接線：事件、命令、工具、切換（SPEC Part 11、Part 5、Part 10）。
//
// 接線契約見 SPEC Part 11「index.ts 接線契約」節（2026-10-01 定）。
// 整個路由鉤子 fail-open（Part 2）：任何异常都不擋住使用者的回合。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadConfig, validatePatch, writeConfigPatch } from "./config/load.js";
import { loadSpend, recordSpend } from "./budget.js";
import { planTurn, type CostRates, type PlanDeps, type PlanSnapshot } from "./route/plan.js";
import { compose } from "./route/compose.js";
import { selectTargets, targetKey, tierOfModel } from "./route/select.js";
import { applyRoute, type ApplyHooks } from "./route/apply.js";
import { runFactsRefresh } from "./ui/facts-refresh.js";
import { appendDecision } from "./decisions.js";
import { createLayaClassifier } from "./classify/laya.js";
import { conversationText } from "./classify/history.js";
import { classifyInStages } from "./classify/flow.js";
import { createCloudClassifier } from "./classify/cloud.js";
import { reloadClassifier } from "./classify/lifecycle.js";
import type { Classifier, Judgment } from "./classify/types.js";
import { type RouteEntry } from "./ui/entries.js";
import { renderEntryCard } from "./ui/entry-card.js";
import { tr, tl } from "./ui/strings.js";
import { suggest } from "./suggest.js";
import { runSettingsWizard, factsAgeDays, type CandidateKind, type WizardHooks } from "./ui/wizard.js";
import { MODEL_FACTS } from "./policy/facts.js";
import { cloudClassifierKeys, localCheckpoints, openRouterModelKeys } from "./ui/sources.js";
import type { CompassConfig, Mode, Target, ThinkingLevel, Tier } from "./schema.js";

/** 事實檔過舊的提醒門檻（天）；與 wizard 的 STALE_FACTS_DAYS 同值。 */
const STALE_FACTS_DAYS_HINT = 14;

/** session 生命週期持有的資源（`session_start` 開、`session_shutdown` 收）。 */
interface SessionState {
  config: CompassConfig;
  classifier?: Classifier;
  /** 上一次 auto-switch 之前的模型，供 `/compass revert`（Part 10.1）。 */
  previousModel?: string;
  /** 本 session 上次真的切換模型的時間（cooldown 用，Part 7）。 */
  lastSwitchAtMs?: number;
  /** 最近一次估的 prompt-cache miss 成本（`/compass` 顯示，Part 7）。 */
  lastCacheMissUsd?: number;
  /** 上一輪結束時預期在位的模型；下一輪不同 = 使用者（或別的擴充）換過模型。 */
  lastExpectedModel?: string;
  /** 最近一次路由決定的完整細節（`/compass why` 顯示 + 回饋脈絡）。 */
  lastDecision?: {
    kind?: string;
    kindConfidence?: number;
    demand?: number;
    tier: string | null;
    model?: string | null;
    thinking?: string;
    symbol?: string;
    outcome?: string;
    cacheMissUsd?: number;
  };
  /** 本次 session 的切換次數（`/compass status` 的 `switches: N`）。 */
  switches: number;
}

/** 追蹤 session 狀態（工廠不啟動行程，狀態在 session_start 填）。 */
function createState(): SessionState {
  return { config: loadConfig().config, switches: 0 };
}

/** 當前模型 → Target 形狀（`provider/id` + 推導層級，供 guard stickiness/deadband）。 */
function currentTarget(ctx: ExtensionContext, config: CompassConfig): { model: string; tier: Tier | null } | null {
  const model = ctx.model;
  if (!model) return null;
  return { model: `${model.provider}/${model.id}`, tier: tierOfModel(config, model.provider, model.id) };
}

/** pi 模型 → 費率三件組（USD/每百萬 token）；缺欄位或型別不符回 null（不猜）。 */
function costRatesOf(model: ReturnType<typeof resolveModel>): CostRates | null {
  if (!model) return null;
  const cost = model.cost as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined;
  if (!cost || typeof cost.input !== "number") return null;
  return { input: cost.input, output: cost.output ?? 0, cacheRead: cost.cacheRead ?? 0, cacheWrite: cost.cacheWrite ?? 0 };
}

/** 解析 Target → pi Model；找不到回 undefined（可用性，Stage 4 實作契約第 1 點）。 */
function resolveModel(ctx: ExtensionContext, target: Target): ReturnType<ExtensionContext["modelRegistry"]["find"]> {
  if (target.provider) return ctx.modelRegistry.find(target.provider, target.model);
  // provider 為空（prefer 注入或裸 id）：在 registry 找**唯一**同 id 的模型；
  // 多個 provider 都有同 id → 歧義，拒絕而不是猜（2026-10-03 W3）。
  const matches = ctx.modelRegistry.getAll().filter((model) => model.id === target.model);
  return matches.length === 1 ? matches[0] : undefined;
}

/** 給 classify 的種類集合（`taskKinds` 的 keys）。 */
function kindsOf(config: CompassConfig): readonly string[] {
  return Object.keys(config.taskKinds);
}

/**
 * 路由鉤子：每輪 agent 前跑 Stage 1–5（Part 5）。
 * **整段包 try/catch**——fail-open，任何异常不得擋住回合（Part 2）。
 */
/** 回合環境快照（routeTurn 與 dry-run 共用；避免兩份接線漂移）。 */
function snapshotFor(ctx: ExtensionContext, config: CompassConfig, state: SessionState): PlanSnapshot {
  const current = currentTarget(ctx, config);
  const spend = loadSpend();
  return {
    currentModel: current?.model ?? null,
    currentTier: current?.tier ?? null,
    lastSwitchAtMs: state.lastSwitchAtMs ?? null,
    contextTokens: ctx.getContextUsage?.()?.tokens ?? null,
    currentCost: costRatesOf(ctx.model),
    todayUsd: spend.todayUsd,
    monthUsd: spend.monthUsd,
  };
}

/** PlanDeps（同上）。 */
function depsFor(ctx: ExtensionContext): PlanDeps {
  return {
    isAvailable: (candidate) => resolveModel(ctx, candidate) !== undefined,
    costOf: (candidate) => costRatesOf(resolveModel(ctx, candidate)),
  };
}

/**
 * W12（2026-10-03）：`/compass-route` 與 `compass_route` 的 dry-run——
 * **真的拿文字去分類**（先前完全忽略輸入，永遠回 fallback standard），
 * 再走 compose/select（有 ctx 時連 plan 的可用性與預算一起算），不切換。
 */
async function dryRun(
  text: string,
  state: SessionState,
  ctx?: ExtensionContext,
): Promise<string> {
  const config = state.config;
  const signal = ctx?.signal ?? AbortSignal.timeout(5000);
  let judgment: Judgment | undefined;
  if (state.classifier) {
    judgment = await classifyInStages(
      state.classifier,
      {
        request: text,
        kinds: kindsOf(config),
        conversation: ctx
          ? conversationText((ctx.sessionManager?.getBranch?.() ?? []) as never, config.classify.historyTurns)
          : undefined,
      },
      config,
      signal,
    );
  }
  const composed = compose(judgment, config);
  const kind = judgment ? `kind ${judgment.kind} ${Math.round(judgment.kindConfidence * 100)}%` : "kind fallback";
  if (!ctx) {
    const selected = selectTargets(composed.tier, judgment, config);
    const first = selected.picked ?? selected.chain[0];
    return `${kind} · demand ${composed.demand.toFixed(2)} · tier ${composed.tier}${first ? ` → ${targetKey(first)}` : " → (no route)"}`;
  }
  const plan = planTurn(judgment, config, snapshotFor(ctx, config, state), depsFor(ctx));
  const target = plan.target ? targetKey(plan.target) : "(no route available)";
  const reason = plan.guard?.reason ? ` · ${plan.guard.reason}` : "";
  return `${kind} · demand ${composed.demand.toFixed(2)} · tier ${plan.guard?.tier ?? composed.tier} → ${target}${reason}`;
}

async function routeTurn(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: SessionState,
  prompt: string,
): Promise<void> {
  const config = state.config;
  if (!config.enabled) return;
  const nowModel = currentTarget(ctx, config)?.model ?? null;
  // #8 手動換模型：上一輪我們預期在位的模型與現在不同 → 記一筆 feedback。
  // 限制：無法區分「使用者自己換」與「其他擴充換」，已知取捨（2026-10-03）。
  if (config.decisionLog && state.lastExpectedModel && nowModel && nowModel !== state.lastExpectedModel) {
    appendDecision({
      type: "feedback",
      feedback: "manual-override",
      from: state.lastExpectedModel,
      to: nowModel,
      tier: state.lastDecision?.tier ?? null,
      kind: state.lastDecision?.kind,
    });
  }
  // 過短 → continuation（Part 5 Stage 1），直接 skipped。
  if (prompt.length < config.classify.minPromptChars) {
    // W10（2026-10-03）：skipped 也走 Stage 5——SPEC 說所有模式的 skipped 都
    // 要套 thinking（修正陳舊層級）；entry 也由同一條管線產生。
    const skippedHooks = buildHooks(pi, ctx);
    await applyRoute(
      {
        outcome: "skipped",
        thinking: compose(undefined, config).thinking,
        mode: config.mode,
        skipReason: "continuation",
      },
      skippedHooks,
    );
    if (config.decisionLog) appendDecision({ type: "route", model: nowModel, symbol: "×", outcome: "skipped", tier: null });
    state.lastExpectedModel = nowModel ?? state.lastExpectedModel;
    return;
  }

  const signal = ctx.signal ?? new AbortController().signal;

  // Stage 1 — classify（W5：menu 模式走兩階段；W6：帶 conversation）。
  let judgment: Judgment | undefined;
  if (state.classifier) {
    judgment = await classifyInStages(
      state.classifier,
      {
        request: prompt,
        kinds: kindsOf(config),
        // W6：historyTurns > 0 時才組（Part 4.4 預設 0＝不送）。
        conversation: conversationText(
          (ctx.sessionManager?.getBranch?.() ?? []) as never,
          config.classify.historyTurns,
        ),
      },
      config,
      signal,
    );
  }

  // Stage 2–4 — 純編排（route/plan.ts）：compose → select → 可用性 → cache → guard。
  // 環境快照全部來自這裡（含 currentTier / lastSwitchAtMs / contextTokens /
  // 費率）——這正是 2026-10-03 前缺失、使 cache/cooldown 空轉的那段接線。
  const current = currentTarget(ctx, config);
  const plan = planTurn(judgment, config, snapshotFor(ctx, config, state), depsFor(ctx));

  if (plan.unavailable || !plan.target || !plan.guard) {
    const skippedHooks = buildHooks(pi, ctx);
    await applyRoute(
      {
        outcome: "skipped",
        thinking: plan.composed.thinking,
        mode: config.mode,
        tier: plan.composed.tier,
        skipReason: "no route available",
        notes: plan.notes,
      },
      skippedHooks,
    );
    if (config.decisionLog) {
      appendDecision({
        type: "route",
        kind: judgment?.kind,
        kindConfidence: judgment?.kindConfidence,
        demand: plan.composed.demand,
        tier: plan.composed.tier,
        model: null,
        symbol: "×",
        outcome: "skipped",
      });
    }
    state.lastExpectedModel = nowModel ?? state.lastExpectedModel;
    return;
  }

  const available = plan.target;
  const result = plan.guard;
  if (plan.cacheMissUsd !== undefined) state.lastCacheMissUsd = plan.cacheMissUsd;

  // Stage 5 — apply（hooks 接 pi / ctx）。
  const hooks = buildHooks(pi, ctx);
  const outcome = await applyRoute(
    {
      outcome: result.outcome,
      target: available,
      thinking: plan.composed.thinking,
      mode: config.mode,
      tier: result.tier,
      reason: result.reason,
      classify: judgment
        ? { source: judgment.source, latencyMs: judgment.latencyMs, hit: judgment.cacheHit ?? false }
        : { source: "fallback", latencyMs: 0, hit: false },
      demand: plan.composed.demand,
      notes: plan.notes,
      cacheMissUsd: plan.cacheMissUsd,
    },
    hooks,
  );

  // confirm 模式：apply 只標 needsConfirm（未寫 entry、未切模型），此處問。
  // W7（2026-10-03）：yes/no/fail 各產生**唯一的 final outcome**，entry、state
  // 與決策日誌都只用它——不再出現「確認前先寫 →、拒絕留假紀錄、接受寫兩筆」。
  let symbol = outcome.symbol;
  let outcomeKind: string = result.outcome;
  let appliedNow = outcome.applied;
  if (outcome.needsConfirm && ctx.hasUI) {
    const yes = await ctx.ui.confirm("Switch model?", `${available.provider}/${available.model} for this turn`);
    if (yes) {
      const applied = await applyRoute(
        {
          outcome: "applied",
          target: available,
          thinking: plan.composed.thinking,
          mode: "auto",
          tier: result.tier,
          reason: result.reason,
          classify: judgment
            ? { source: judgment.source, latencyMs: judgment.latencyMs, hit: judgment.cacheHit ?? false }
            : { source: "fallback", latencyMs: 0, hit: false },
          demand: plan.composed.demand,
          notes: plan.notes,
          cacheMissUsd: plan.cacheMissUsd,
        },
        hooks,
      );
      symbol = applied.symbol;
      outcomeKind = applied.failed ? "apply failed" : "applied";
      appliedNow = applied.applied;
    } else {
      // 拒絕：記一筆 cancelled（×），不切模型。
      writeEntry(pi, {
        symbol: "×",
        tier: result.tier,
        target: available,
        reason: "cancelled in confirm",
        notes: plan.notes,
        classify: judgment
          ? { source: judgment.source, latencyMs: judgment.latencyMs, hit: judgment.cacheHit ?? false }
          : { source: "fallback", latencyMs: 0, hit: false },
        demand: plan.composed.demand,
      });
      symbol = "×";
      outcomeKind = "cancelled";
      appliedNow = false;
    }
  }
  if (appliedNow) {
    state.switches += 1;
    state.lastSwitchAtMs = Date.now();
    state.previousModel = current?.model;
  }

  // #9 決策日誌（非內容欄位）+ #8 期望模型更新（一律用 final outcome）。
  state.lastExpectedModel = appliedNow ? targetKey(available) : (nowModel ?? targetKey(available));
  state.lastDecision = {
    kind: judgment?.kind,
    kindConfidence: judgment?.kindConfidence,
    demand: plan.composed.demand,
    tier: result.tier,
    model: appliedNow ? targetKey(available) : (nowModel ?? targetKey(available)),
    thinking: plan.composed.thinking,
    symbol,
    outcome: outcomeKind,
    cacheMissUsd: plan.cacheMissUsd,
  };
  if (config.decisionLog) {
    appendDecision({
      type: "route",
      kind: judgment?.kind,
      kindConfidence: judgment?.kindConfidence,
      demand: plan.composed.demand,
      tier: result.tier,
      model: targetKey(available),
      thinking: plan.composed.thinking,
      symbol,
      outcome: outcomeKind,
      cacheMissUsd: plan.cacheMissUsd,
      classify: judgment
        ? { source: judgment.source, latencyMs: judgment.latencyMs, hit: judgment.cacheHit ?? false }
        : { source: "fallback", latencyMs: 0, hit: false },
    });
  }
}

/** Stage 5 hooks：接 pi 的 setModel/setThinkingLevel + ctx 的 entry 寫入。 */
function buildHooks(pi: ExtensionAPI, ctx: ExtensionContext): ApplyHooks {
  return {
    async setModel(target: Target): Promise<void> {
      const model = resolveModel(ctx, target);
      const key = targetKey(target);
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
  pi.on("session_start", (_event, ctx) => {
    reloadConfig(state);
    // 事實檔過舊（>14 天）：主動提醒一次可一鍵更新（/compass refresh-facts）。
    if (ctx?.hasUI) {
      const age = factsAgeDays(MODEL_FACTS.generatedAt);
      if (age !== null && age > STALE_FACTS_DAYS_HINT) {
        ctx.ui.notify(
          `model facts are ${age} days old — run /compass refresh-facts to sync prices`,
          "warning",
        );
      }
    }
  });
  // W1（2026-10-03 審查）：主要成本=assistant 回覆。先前只記 cloud 分類費，
  // 導致 budget pressure 幾乎恆為 0。以權威 usage.cost.total 記一次。
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    const total = message.usage?.cost?.total;
    if (typeof total === "number" && total > 0) recordSpend(total);
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
  const descLang = state.config.display.language;
  pi.registerCommand("compass", {
    description: tl(descLang, "compass 狀態 / on|off / mode / budget / why / revert / suggest / refresh-facts"),
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      switch (sub) {
        case undefined:
        case "":
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
        case "revert": {
          const previous = state.previousModel;
          if (!previous) return ctx.ui.notify("nothing to revert", "info");
          const slash = previous.indexOf("/");
          const provider = slash > 0 ? previous.slice(0, slash) : "";
          const modelId = slash > 0 ? previous.slice(slash + 1) : previous;
          const model = ctx.modelRegistry.find(provider, modelId);
          if (!model) return ctx.ui.notify(`revert: model not found: ${previous}`, "warning");
          const ok = await pi.setModel(model);
          if (!ok) return ctx.ui.notify(`revert: auth not configured for ${previous}`, "warning");
          if (state.config.decisionLog) {
            appendDecision({
              type: "feedback",
              feedback: "revert",
              from: currentTarget(ctx, state.config)?.model ?? null,
              to: previous,
              tier: state.lastDecision?.tier ?? null,
              kind: state.lastDecision?.kind,
            });
          }
          state.lastExpectedModel = previous;
          return ctx.ui.notify(`revert → ${previous}`, "info");
        }
        case "suggest":
          return showSuggest(ctx, state);
        case "refresh-facts": {
          const result = runFactsRefresh();
          return ctx.ui.notify(result.message, result.ok ? "info" : "error");
        }
        default:
          return ctx.ui.notify(`unknown subcommand: ${sub}`, "warning");
      }
    },
  });

  pi.registerCommand("compass-set", {
    description: tl(descLang, "/compass-set 設定選單（寫 config.json + 時間戳備份）"),
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
          const lang = state.config.display.language;
          if (!classifier) return tl(lang, "沒有分類器（backend 未啟用）");
          const started = Date.now();
          try {
            const judgment = await classifier.classify(
              { request: tl(lang, "回一個字就好"), kinds: kindsOf(state.config) },
              AbortSignal.timeout(8000),
            );
            const ms = Date.now() - started;
            return `${classifier.id} ${ms}ms · kind ${judgment.kind} ${Math.round(judgment.kindConfidence * 100)}% · cache ${judgment.cacheHit ? "hit" : "miss"}`;
          } catch (error) {
            return tr(lang)`分類失敗：${error instanceof Error ? error.message : String(error)}`;
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
    description: tl(descLang, "/compass-route <text> 分類任意文字並顯示建議（不切換）"),
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) return ctx.ui.notify("compass-route: expected some text", "warning");
      ctx.ui.notify(await dryRun(text, state, ctx), "info");
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
  const cacheMiss = state.lastCacheMissUsd === undefined ? "" : ` · cache miss ≈ $${state.lastCacheMissUsd.toFixed(3)}`;
  const lines = [
    `compass:${state.config.enabled ? "on" : "off"} · $${spend.todayUsd.toFixed(2)} today · ${Math.round(pressure * 100)}% · ${state.config.mode}`,
    `model ${current} · switches ${state.switches}${cacheMiss} · profile ${state.config.profile}`,
    `routes quick[${state.config.routes.quick.length}] standard[${state.config.routes.standard.length}] high[${state.config.routes.high.length}]`,
  ];
  if (why) {
    lines.push(`classify ${state.config.classify.provider} · timeout ${state.config.classify.timeoutMs}ms`);
    const d = state.lastDecision;
    if (d) {
      const conf = d.kindConfidence === undefined ? "" : ` ${Math.round(d.kindConfidence * 100)}%`;
      const miss = d.cacheMissUsd === undefined ? "" : ` · cache miss ≈ $${d.cacheMissUsd.toFixed(3)}`;
      lines.push(
        `last: ${d.symbol ?? "?"} ${d.tier ?? "-"} ${d.model ?? "-"} · kind ${d.kind ?? "?"}${conf} · demand ${d.demand?.toFixed(2) ?? "-"} · thinking ${d.thinking ?? "-"}${miss} · ${d.outcome ?? "-"}`,
      );
    } else {
      lines.push("last: (none this session)");
    }
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

/** `/compass suggest`：分數檔提議（不切換，Part 10.1）。 */
async function showSuggest(ctx: ExtensionContext, state: SessionState): Promise<void> {
  try {
    const list = await suggest(state.config);
    if (list.length === 0) return ctx.ui.notify(tl(state.config.display.language, "沒有足夠的決策歷史或分數檔——先使用一段時間，或用 /compass-set ⑤ 指定分數檔"), "info");
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
    async execute(_id, params) {
      // W12：真的把 params.text 送進分類（先前忽略輸入）。
      const text = await dryRun(String(params.text ?? ""), state);
      return { content: [{ type: "text", text }], details: {} };
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
