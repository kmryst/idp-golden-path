import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { findBooleanInputsWithoutDefault } from "./workflow-input-contract.mjs";

test("default が無い boolean input を検出する", () => {
	const source = `name: X
on:
  workflow_call:
    inputs:
      upload-sarif:
        description: "SARIF を送るか"
        required: false
        type: boolean
jobs:
  a:
    runs-on: ubuntu-latest
`;
	assert.deepEqual(findBooleanInputsWithoutDefault(source), ["upload-sarif"]);
});

test("default を宣言した boolean input は違反にしない", () => {
	const source = `on:
  workflow_call:
    inputs:
      upload-sarif:
        required: false
        type: boolean
        default: true
`;
	assert.deepEqual(findBooleanInputsWithoutDefault(source), []);
});

test("string input は default が無くても違反にしない", () => {
	const source = `on:
  workflow_call:
    inputs:
      severity:
        required: false
        type: string
`;
	assert.deepEqual(findBooleanInputsWithoutDefault(source), []);
});

test("block scalar の description 本文をプロパティと誤認しない", () => {
	// 本文に `default:` / `type: boolean` を含む description を持つ string input。
	// 行単位の素朴な grep だと boolean と誤認したり default 宣言と誤認したりする
	const source = `on:
  workflow_call:
    inputs:
      exit-code:
        description: >-
          finding があったときの扱い。
          type: boolean ではない。
          default: '0' として扱う
        required: false
        type: string
      flag:
        description: >-
          default: true と書いてあるが宣言ではない
        required: false
        type: boolean
`;
	assert.deepEqual(findBooleanInputsWithoutDefault(source), ["flag"]);
});

test("workflow_dispatch の inputs は検査対象外", () => {
	// workflow_dispatch の boolean input は default が無くても false になるだけで、
	// reusable workflow の契約破りにはならない
	const source = `on:
  workflow_dispatch:
    inputs:
      dry-run:
        type: boolean
`;
	assert.deepEqual(findBooleanInputsWithoutDefault(source), []);
});

test("dual-trigger workflow でも workflow_call ブロックだけを見る", () => {
	const source = `on:
  pull_request:
    branches: [main]
  workflow_call:
    inputs:
      scan-ref:
        required: false
        type: string
`;
	assert.deepEqual(findBooleanInputsWithoutDefault(source), []);
});

test("引数を取らない裸の workflow_call でも落ちない", () => {
	const source = `on:
  push:
    branches: [main]
  pull_request:
  workflow_call:
jobs:
  a:
    runs-on: ubuntu-latest
`;
	assert.deepEqual(findBooleanInputsWithoutDefault(source), []);
});

test("workflow_call を持たない workflow は違反ゼロ", () => {
	assert.deepEqual(findBooleanInputsWithoutDefault("on:\n  push:\n    branches: [main]\n"), []);
});

test("リポジトリの reusable workflow が契約を満たす", () => {
	for (const file of [
		".github/workflows/trivy-image.yml",
		".github/workflows/trivy-config.yml",
	]) {
		assert.deepEqual(findBooleanInputsWithoutDefault(readFileSync(file, "utf8")), [], file);
	}
});
