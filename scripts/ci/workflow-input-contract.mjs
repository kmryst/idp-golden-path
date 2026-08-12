#!/usr/bin/env node
// workflow_call の boolean input が `default:` を宣言しているか静的に検査する
//
// 背景: GitHub Actions の `workflow_call` boolean input は、caller が値を渡さず、かつ
// 定義側に `default:` が無い場合、`inputs.<name>` が `false` に評価される。
// `if: ${{ inputs['x'] != false }}` のようなガードと組み合わさると、対象 step が
// 黙って skip されたまま job は success になる（silent failure）。
// 実測: `upload-sarif` の `default: true` 欠落により、ticket-c2c-platform の
// run 31567906354 で SARIF が 1 件も上がらないまま 2 job とも success だった（Issue #186）。
//
// string 型は `inputs.x || 'fallback'` という式側のフォールバックが慣用であり、
// 未指定時は空文字なので同種の罠にならない。boolean だけを検査対象にする。
//
// YAML パーサへの依存を増やさないため、`on: > workflow_call: > inputs:` ブロックだけを
// インデントベースで読む最小の走査を行う。description の block scalar（`>-`）本文は
// プロパティより深いインデントに現れるため、プロパティ行の判定から自然に除外される。

import { readFileSync } from "node:fs";

const indentOf = (line) => line.length - line.trimStart().length;
const isSkippable = (line) => line.trim() === "" || line.trimStart().startsWith("#");

/**
 * 指定インデントの親キー配下にある子行を返す（親キー行自身は含まない）。
 * 親キーが見つからない場合は null を返す。
 */
function childLines(lines, key, parentIndent) {
	const start = lines.findIndex(
		(line) => indentOf(line) === parentIndent && line.trim() === `${key}:`,
	);
	if (start === -1) return null;

	const body = [];
	for (const line of lines.slice(start + 1)) {
		if (isSkippable(line)) continue;
		if (indentOf(line) <= parentIndent) break;
		body.push(line);
	}
	return body;
}

/** workflow ファイル 1 つを検査し、違反した input 名の配列を返す */
export function findBooleanInputsWithoutDefault(source) {
	const lines = source.split("\n").filter((line) => !isSkippable(line));

	// 各ブロックは空になり得る（例: 引数を取らない `workflow_call:` の裸宣言）
	const onBody = childLines(lines, "on", 0);
	if (!onBody || onBody.length === 0) return [];

	const callBody = childLines(onBody, "workflow_call", indentOf(onBody[0]));
	if (!callBody || callBody.length === 0) return [];

	const inputsBody = childLines(callBody, "inputs", indentOf(callBody[0]));
	if (!inputsBody || inputsBody.length === 0) return [];

	const nameIndent = indentOf(inputsBody[0]);
	const violations = [];

	for (const [index, line] of inputsBody.entries()) {
		if (indentOf(line) !== nameIndent) continue;
		const match = line.trim().match(/^([A-Za-z0-9_-]+):$/);
		if (!match) continue;

		// この input のプロパティ行だけを集める（次の同インデント行の手前まで）
		const props = [];
		for (const next of inputsBody.slice(index + 1)) {
			if (indentOf(next) <= nameIndent) break;
			props.push(next);
		}
		const propIndent = props.length > 0 ? indentOf(props[0]) : 0;
		const ownProps = props.filter((prop) => indentOf(prop) === propIndent);

		const isBoolean = ownProps.some((prop) => /^type:\s*boolean\s*$/.test(prop.trim()));
		const hasDefault = ownProps.some((prop) => /^default:/.test(prop.trim()));

		if (isBoolean && !hasDefault) violations.push(match[1]);
	}

	return violations;
}

function main(files) {
	let failed = false;

	for (const file of files) {
		const violations = findBooleanInputsWithoutDefault(readFileSync(file, "utf8"));
		for (const name of violations) {
			failed = true;
			console.error(
				`::error file=${file}::workflow_call input '${name}' は type: boolean ですが default: が宣言されていません。` +
					"未指定の caller から呼ばれると false に評価され、if: ガードが黙って偽になります（Issue #186）",
			);
		}
		if (violations.length === 0) {
			console.log(`ok: ${file}`);
		}
	}

	if (failed) process.exit(1);
	console.log("すべての workflow_call boolean input が default: を宣言しています");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	const files = process.argv.slice(2);
	if (files.length === 0) {
		console.error("Usage: node scripts/ci/workflow-input-contract.mjs <workflow.yml>...");
		process.exit(1);
	}
	main(files);
}
