// test/preferences.test.ts — S4：從行為學來的、會衰減的偏好。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decayedScore,
  learnPreferences,
  preferenceBonus,
  PREF_HALF_LIFE_MS,
} from "../extensions/pi-compass-router/policy/preferences.js";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

test("decayedScore halves after one half-life", () => {
  assert.equal(decayedScore({ score: 2, updatedAt: NOW }, NOW + PREF_HALF_LIFE_MS), 1);
  assert.equal(decayedScore({ score: 2, updatedAt: NOW }, NOW), 2);
});

test("manual-override penalizes the routed model and boosts the user's pick, per kind", () => {
  const table = learnPreferences(
    [{ type: "feedback", feedback: "manual-override", from: "openrouter/a", to: "deepseek/b", kind: "implement", ts: at(0) } as never],
    NOW,
  );
  assert.ok(preferenceBonus(table, "deepseek", "b", "implement", NOW) > 0);
  assert.ok(preferenceBonus(table, "openrouter", "a", "implement", NOW) < 0);
  assert.equal(preferenceBonus(table, "deepseek", "b", "chat", NOW), 0, "kind-specific: other kinds unaffected");
});

test("revert penalizes; successful usage adds a small positive; failed usage does not", () => {
  const table = learnPreferences(
    [
      { type: "feedback", feedback: "revert", from: "p/r", kind: "write", ts: at(0) } as never,
      { type: "usage", model: "p/ok", ok: true, kind: "chat", ts: at(0) } as never,
      { type: "usage", model: "p/bad", ok: false, kind: "chat", ts: at(0) } as never,
    ],
    NOW,
  );
  assert.ok(preferenceBonus(table, "p", "r", "write", NOW) < 0);
  assert.ok(preferenceBonus(table, "p", "ok", "chat", NOW) > 0);
  assert.equal(preferenceBonus(table, "p", "bad", "chat", NOW), 0, "an error turn is a health event, not taste");
});

test("preference decays with inactivity", () => {
  const table = learnPreferences(
    [{ type: "feedback", feedback: "manual-override", from: "x", to: "p/liked", kind: "chat", ts: at(0) } as never],
    NOW,
  );
  const fresh = preferenceBonus(table, "p", "liked", "chat", NOW);
  const later = preferenceBonus(table, "p", "liked", "chat", NOW + 3 * PREF_HALF_LIFE_MS);
  assert.ok(fresh > 0 && later > 0 && later < fresh, "still positive but weaker after inactivity");
});

test("the score is clamped and the bonus is bounded", () => {
  const many = Array.from({ length: 20 }, () => ({
    type: "feedback",
    feedback: "manual-override",
    from: "x",
    to: "p/spam",
    kind: "chat",
    ts: at(0),
  })) as never[];
  const table = learnPreferences(many, NOW);
  const bonus = preferenceBonus(table, "p", "spam", "chat", NOW);
  assert.ok(bonus <= 5 && bonus >= -5, "bounded to ±5 even after many events");
  assert.equal(bonus, 5, "clamped at the ceiling");
});
