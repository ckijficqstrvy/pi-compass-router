#!/usr/bin/env bash
# accept.sh — SPEC Part 12 六項驗收的一鍵重跑（發佈前必過）。
#
# 用法：bash scripts/accept.sh
# 每項只認規格定的 exit code：驗收 5/5b/clean-room **只有 1 算過**
# （0=有命中=失敗，2=路徑不存在=根本沒跑）。
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0

check() { # check <name> <actual> <expected>
  local name="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS  $name (exit=$actual)"
    pass=$((pass + 1))
  else
    echo "  FAIL  $name (exit=$actual, 期望 $expected)"
    fail=$((fail + 1))
  fi
}

echo "[1] typecheck"
npm run typecheck >/dev/null 2>&1; check "typecheck" "$?" 0

echo "[2] test"
rm -rf build
npm test >/tmp/compass-accept-test.log 2>&1
check "npm test" "$?" 0
grep -E '^# (tests|pass|fail)' /tmp/compass-accept-test.log | sed 's/^/      /'

echo "[3] 驗收3 pi -ne -e 載入"
if [[ "${COMPASS_ACCEPT_SKIP_ENV:-0}" == "1" ]]; then
  echo "      (skip: COMPASS_ACCEPT_SKIP_ENV=1 — CI 無 pi CLI)"
else
  # 只驗「擴充載入」，不驗「供應商可用」：載入失敗時 pi 會明印
  # `Failed to load extension`；供應商 402／斷線是環境問題，不該讓本機 gate 變紅
  # （2026-10-05：openrouter 402 額度曾讓此項誤判失敗）。
  pi_out=$(pi -ne -e extensions/pi-compass-router/index.ts -p "ping" 2>&1)
  pi_code=$?
  if [[ $pi_code -eq 0 ]]; then
    check "pi -ne -e" 0 0
  elif grep -q 'Failed to load extension' <<<"$pi_out"; then
    printf '%s\n' "$pi_out" | head -5 | sed 's/^/      /'
    check "pi -ne -e (extension load)" 1 0
  else
    echo "      (extension loaded; provider call failed — 供應商/帳務問題不計入 gate)"
    printf '%s\n' "$pi_out" | head -1 | cut -c1-180 | sed 's/^/      /'
    check "pi -ne -e (provider unreachable, load OK)" 0 0
  fi
fi

echo "[4] 驗收4 laya p95 < 80ms"
if [[ "${COMPASS_ACCEPT_SKIP_ENV:-0}" == "1" ]]; then
  echo "      (skip: COMPASS_ACCEPT_SKIP_ENV=1 — CI 無本機 laya 模型)"
else
  npx esbuild test/latency.ts --bundle --packages=external --platform=node --format=esm --outdir=build/lat --log-level=error 2>/dev/null
  node build/lat/latency.js >/tmp/compass-accept-lat.log 2>&1
  check "laya latency" "$?" 0
  grep -E 'p50|PASS|FAIL' /tmp/compass-accept-lat.log | sed 's/^/      /'
fi

echo "[5] 驗收5 上游識別標記（要 1）"
# 本檔自身除外：它的 grep pattern 字面量必然含禁區字串（自污染），
# 掃描對象是「產品碼」，不是驗收器自己。
grep -riE 'da-vinci-noob|pi-jev-model-router|JEV_' extensions/ test/ docs/ package.json README.md scripts/*.mjs >/dev/null 2>&1
check "上游識別標記" "$?" 1

echo "[6] 驗收5b Jev 單字（要 1）"
grep -rnwE 'Jev' extensions/ test/ docs/ scripts/*.mjs >/dev/null 2>&1
check "Jev 單字" "$?" 1

echo "[7] clean-room 禁區（要 1）"
grep -rn 'dev/pi-jev-router' extensions/ test/ docs/ package.json README.md scripts/*.mjs >/dev/null 2>&1
check "clean-room 禁區" "$?" 1

echo "[8] 模組進度"
total=$(find extensions -name '*.ts' | wc -l | tr -d ' ')
done=$(for f in $(find extensions -name '*.ts'); do grep -q 'not implemented' "$f" || echo x; done | wc -l | tr -d ' ')
echo "      $done / $total 已實作"
if [[ "$done" == "$total" ]]; then echo "      PASS  全模組實作"; pass=$((pass+1)); else echo "      FAIL  仍有 stub"; fail=$((fail+1)); fi

echo
echo "結果：$pass 通過 / $fail 失敗"
exit "$fail"