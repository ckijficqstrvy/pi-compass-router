// test/i18n.test.ts — 英文版完整性（SPEC Part 3.1 `display.language`）。
//
// 三層保證：
//   1. 每個 t() 鍵都有 EN 翻譯（靜態掃描）。
//   2. 含漢字的 template literal 必須經 t`` 包裝（否則 en 模式會漏中文）；
//      含漢字的普通字串必須是 t(...) 參數或是字典鍵（供 t(variable) 動態查）。
//   3. en 模式跑一輪 wizard + entry 卡片，顯示字串不得出現 CJK（執行期）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EN, setLang, t, langOf } from "../extensions/pi-compass-router/ui/strings.js";
import { runSettingsWizard } from "../extensions/pi-compass-router/ui/wizard.js";
import { renderEntryCard } from "../extensions/pi-compass-router/ui/entry-card.js";
import { DEFAULT_CONFIG } from "../extensions/pi-compass-router/schema.js";
import type { CompassConfig } from "../extensions/pi-compass-router/schema.js";
import type { WizardHooks } from "../extensions/pi-compass-router/ui/wizard.js";

const HAN = /[\u4e00-\u9fff]/;
// 測試 bundle 後落在 build/test/，原始碼在 repo 根：用 cwd（npm test 由 repo 根執行）。
const SRC = [
  join(process.cwd(), "extensions/pi-compass-router/ui/wizard.ts"),
  join(process.cwd(), "extensions/pi-compass-router/ui/entry-card.ts"),
  join(process.cwd(), "extensions/pi-compass-router/index.ts"),
];

/** 去註解（保留字串內容）。 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        const d = src[i];
        out += d;
        i++;
        if (d === "\\") {
          out += src[i] ?? "";
          i++;
          continue;
        }
        if (d === quote) break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 跳過一個 template literal（回傳結尾反引號索引）。 */
function skipTemplate(src: string, start: number): number {
  let j = start + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") return j;
    if (c === "$" && src[j + 1] === "{") {
      let depth = 1;
      j += 2;
      while (j < src.length && depth > 0) {
        const d = src[j];
        if (d === "`") {
          j = skipTemplate(src, j) + 1;
          continue;
        }
        if (d === "{") depth++;
        else if (d === "}") {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
    }
    j++;
  }
  return j;
}

interface Found {
  key: string;
  /** "call" = t(...)；"tag" = t`...`；"plain" = 一般字串；"template" = 未包裝模板。 */
  kind: "call" | "tag" | "plain" | "template";
  wrapped: boolean;
}

/** 掃出所有字串/模板（含漢字者），並標記是否經過 t。 */
function scanLiterals(src: string): Found[] {
  const out: Found[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const prev = src[i - 1] ?? "";
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") {
          s += src[j + 1];
          j += 2;
          continue;
        }
        s += src[j];
        j++;
      }
      if (HAN.test(s)) {
        // t("…") 呼叫引數？
        const before = src.slice(Math.max(0, i - 3), i);
        const call = /t\(\s*$/.test(before);
        out.push({ key: s, kind: "call", wrapped: call });
      }
      i = j + 1;
      continue;
    }
    if (c === "`") {
      const end = skipTemplate(src, i);
      const raw = src.slice(i + 1, end);
      // 靜態跨度（洞以 ${} 取代）；洞內字面遞迴掃。
      const spans: string[] = [];
      let k = 0;
      let cur = "";
      while (k < raw.length) {
        const d = raw[k];
        if (d === "\\") {
          cur += raw[k + 1];
          k += 2;
          continue;
        }
        if (d === "$" && raw[k + 1] === "{") {
          spans.push(cur);
          cur = "";
          let depth = 1;
          k += 2;
          const exprStart = k;
          while (k < raw.length && depth > 0) {
            const e = raw[k];
            if (e === "`") {
              k = skipTemplate(raw, k) + 1;
              continue;
            }
            if (e === "{") depth++;
            else if (e === "}") {
              depth--;
              if (depth === 0) break;
            }
            k++;
          }
          out.push(...scanLiterals(raw.slice(exprStart, k)));
          k++;
          continue;
        }
        cur += d;
        k++;
      }
      spans.push(cur);
      const norm = spans.join("${}");
      const tagged = prev === "t";
      if (HAN.test(spans.join("")) || HAN.test(norm)) {
        out.push({ key: norm, kind: tagged ? "tag" : "template", wrapped: tagged });
      }
      i = end + 1;
      continue;
    }
    i++;
  }
  return out;
}

test("every t() key has an English translation", () => {
  const missing: string[] = [];
  for (const file of SRC) {
    const literals = scanLiterals(stripComments(readFileSync(file, "utf8")));
    for (const found of literals) {
      if (found.kind !== "tag" && found.kind !== "call") continue; // 只看 t() 鍵
      if (!found.wrapped) continue;
      if (EN[found.key] === undefined) missing.push(found.key);
    }
  }
  assert.deepEqual([...new Set(missing)], [], "these t() keys lack EN translations");
});

test("Han template literals are all t-tagged; Han plain strings are translated or dictionary keys", () => {
  const untagged: string[] = [];
  const unknown: string[] = [];
  for (const file of SRC) {
    for (const found of scanLiterals(stripComments(readFileSync(file, "utf8")))) {
      if (found.kind === "template") untagged.push(found.key);
      // 動態鍵：一般字串、或 t() 呼叫引數，都必須存在於字典（否則 en 模式查不到）
      if (found.kind === "call" || found.kind === "plain") {
        if (EN[found.key] === undefined) unknown.push(found.key);
      }
    }
  }
  assert.deepEqual([...new Set(untagged)], [], "untagged Han templates would leak zh in en mode");
  assert.deepEqual([...new Set(unknown)], [], "Han strings missing from the EN dictionary");
});

// ---------------------------------------------------------------------------
// 執行期：en 模式不得出現 CJK
// ---------------------------------------------------------------------------

/** 極簡 scripted hooks：錄下所有顯示字串，選單照 `menu` 腳本走。 */
function scripted(menu: string[], answers: Record<string, string> = {}) {
  const queue = [...menu];
  const seen: string[] = [];
  const hooks: WizardHooks = {
    write: () => null,
    reload: () => undefined,
    async pick(label, options) {
      seen.push(label, ...options);
      const want = queue.shift();
      if (want === undefined) return null;
      return options.find((row) => row.startsWith(want)) ?? null;
    },
    async prompt(label, initial) {
      seen.push(label, initial ?? "");
      const key = Object.keys(answers).find((k) => label.startsWith(k));
      return key ? answers[key] : null;
    },
    notify: (message) => seen.push(message),
  };
  return { hooks, seen };
}

test("en-mode wizard renders no CJK anywhere", async () => {
  const groups = ["①", "②", "③", "④", "⑤", "⑥", "⑦"];
  const allSeen: string[] = [];
  for (const group of groups) {
    const s = scripted([group, "←"]);
    const config = { ...DEFAULT_CONFIG, display: { ...DEFAULT_CONFIG.display, language: "en" as const } };
    await runSettingsWizard(config, s.hooks);
    allSeen.push(...s.seen);
  }
  const leaked = allSeen.filter((text) => HAN.test(text));
  assert.deepEqual(leaked, [], "en wizard leaked Chinese");
  setLang("zh");
});

test("en-mode entry card renders no CJK (including the expand hint)", () => {
  const flattened: Array<{ children?: unknown[]; text?: string }> = [];
  const collect = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const record = node as { text?: string; children?: unknown[] };
    if (typeof record.text === "string") flattened.push(record);
    for (const child of record.children ?? []) collect(child);
  };
  const theme = {
    colors: { customMessageBg: "#000", accent: "#fff" },
    fg: (_token: string, text: string) => text,
    bg: (_token: string, text: string) => text,
    style: (text: string) => text,
    bold: (text: string) => text,
  };
  const entry = {
    symbol: "→" as const,
    tier: "standard" as const,
    target: { provider: "openrouter", model: "xiaomi/mimo-v2.6-pro" },
    kind: "plan",
    kindConfidence: 0.9,
    demand: 1.63,
    classify: { source: "laya", latencyMs: 73, hit: false },
    thinking: { resolved: "high" as const },
  };
  const display = { ...DEFAULT_CONFIG.display, language: "en" as const };
  collect(renderEntryCard(entry, { expanded: false, display }, theme as never));
  const leaked = flattened.map((n) => n.text ?? "").filter((text) => HAN.test(text));
  assert.deepEqual(leaked, [], "en entry card leaked Chinese");
});

test("t() is identity in zh and translates in en; rawOf round-trips fixed keys", async () => {
  const { rawOf } = await import("../extensions/pi-compass-router/ui/strings.js");
  setLang("zh");
  assert.equal(t("開"), "開");
  assert.equal(t`已寫入 ${"x"}`, "已寫入 x");
  setLang("en");
  assert.equal(t("開"), "On");
  assert.equal(t`已寫入 ${"x"}`, "saved x");
  assert.equal(rawOf("On"), "開");
  assert.equal(langOf(), "en");
  setLang("zh");
});

test("EN translations of hole-free keys are unique (rawOf reverse map is unambiguous)", () => {
  // rawOf() 用「EN 值 → zh 原文」反向查表來把固定選項翻回原文鍵；
  // 若兩個無洞的鍵譯成同一句，後者會被覆蓋，rawOf 可能回錯鍵。
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const [key, value] of Object.entries(EN)) {
    if (key.includes("${}")) continue; // 含洞的鍵不進反向表
    const previous = seen.get(value);
    if (previous !== undefined && previous !== key) collisions.push(`${JSON.stringify(previous)} & ${JSON.stringify(key)} → ${JSON.stringify(value)}`);
    else seen.set(value, key);
  }
  assert.deepEqual(collisions, [], "hole-free EN translations must be unique");
});
