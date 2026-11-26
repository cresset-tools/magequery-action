import assert from "node:assert/strict";
import { test } from "node:test";

import { choosesFormat, helpOffersGithub, withFormat } from "../src/doctor.js";

test("args that pick an output format are left alone", () => {
  assert.equal(choosesFormat(["doctor"]), false);
  assert.equal(choosesFormat(["doctor", "--source", "app"]), false);
  assert.equal(choosesFormat(["doctor", "--json"]), true);
  assert.equal(choosesFormat(["doctor", "--format", "text"]), true);
  assert.equal(choosesFormat(["doctor", "--format=sarif"]), true);
});

test("the GitHub format is used only when the installed magequery has it", () => {
  const old = "Options:\n      --deny <CODE>\n      --json\n";
  const current = "Options:\n      --format <FORMAT>  [possible values: auto, text, json, github, gitlab, sarif]\n";
  assert.equal(helpOffersGithub(old), false);
  assert.equal(helpOffersGithub(current), true);
});

test("a doctor run keeps the user's args and adds the format", () => {
  assert.deepEqual(withFormat("shop", ["doctor", "--source", "app"], "github"), [
    "--root",
    "shop",
    "doctor",
    "--source",
    "app",
    "--format",
    "github",
  ]);
});
