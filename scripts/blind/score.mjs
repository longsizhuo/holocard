/**
 * 双盲实验解码：把评审交回来的结果串（对比页底部「复制结果」那一行）按 key.json 还原成各配置的胜负。
 *
 * 用法：
 *   node scripts/blind/score.mjs 实验目录/key.json "1A 2= 3B 4X ..."  [--candidate 512]
 *
 * A / B：这一边更好（偏好）；=：差不多；X：两边都有问题；
 * A! / B!：这一边赢，是因为对面有明显 bug。
 * 偏好和「坏了」分开算：每个配置出明显 bug 的次数（X 算两边各一次）比偏好重要得多——
 * 一张卡坏了，用户直接觉得产品有问题；好看一点点，多数人察觉不到。
 * --candidate 给了的话，给出候选配置的 bug 率和偏好（阈值由人定，这里只算数）。
 */
import { readFileSync } from 'node:fs';

const [keyPath, text] = process.argv.slice(2);
if (!keyPath || !text) {
  console.error('用法：node scripts/blind/score.mjs key.json "1A 2= 3B ..." [--candidate 名字]');
  process.exit(1);
}
const i = process.argv.indexOf('--candidate');
const candidate = i >= 0 ? process.argv[i + 1] : null;
const key = JSON.parse(readFileSync(keyPath, 'utf8'));
const [v1, v2] = key.variants;

const votes = new Map();
for (const m of text.matchAll(/(\d+)\s*([AB=X])(!?)/gi)) votes.set(Number(m[1]), m[2].toUpperCase() + m[3]);

const tally = (pairs) => {
  // t[配置]：这个配置更好（纯偏好）；t.bug[配置]：这个配置有明显 bug（输给了对面的 !，或者两边都有问题）
  const t = { [v1]: [], [v2]: [], same: [], bad: [], unrated: [], bug: { [v1]: [], [v2]: [] } };
  for (const p of pairs) {
    const v = votes.get(p.no);
    if (!v) t.unrated.push(p);
    else if (v === '=') t.same.push(p);
    else if (v === 'X') {
      t.bad.push(p);
      t.bug[v1].push(p);
      t.bug[v2].push(p);
    } else {
      const winner = v[0] === 'A' ? p.a : p.b;
      const loser = winner === v1 ? v2 : v1;
      if (v.endsWith('!')) t.bug[loser].push(p);
      else t[winner].push(p);
    }
  }
  return t;
};
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '-');
const line = (label, pairs) => {
  const t = tally(pairs);
  const rated = pairs.length - t.unrated.length;
  console.log(
    `${label.padEnd(8)} 已评 ${rated}/${pairs.length}：明显 bug ${v1} ${t.bug[v1].length}（${pct(t.bug[v1].length, rated)}）、${v2} ${t.bug[v2].length}（${pct(t.bug[v2].length, rated)}）｜` +
      `偏好 ${v1} 更好 ${t[v1].length}、${v2} 更好 ${t[v2].length}、差不多 ${t.same.length}｜其中两边都有问题 ${t.bad.length}`,
  );
  return t;
};

console.log(`实验 ${key.experiment}：${v1} 对 ${v2}，${key.totalPairs} 对可比，评审 ${key.pairs.length} 对`);
for (const [name, t] of Object.entries(key.timing ?? {})) if (t) console.log(`  ${name}：平均每张 ${t.perImage} 秒`);
const overall = line('全部', key.pairs);
for (const group of [...new Set(key.pairs.map((p) => p.group))]) line(group, key.pairs.filter((p) => p.group === group));

const list = (ps) => ps.map((p) => `#${p.no}(${p.name})`).join(' ');
for (const v of [v1, v2]) {
  const own = overall.bug[v].filter((p) => !overall.bad.includes(p));
  if (own.length) console.log(`\n只有 ${v} 有明显 bug 的：${list(own)}`);
}
if (overall.bad.length) console.log(`两边都有问题的：${list(overall.bad)}`);
for (const v of [v1, v2]) {
  const lost = overall[v === v1 ? v2 : v1];
  if (lost.length) console.log(`${v} 只是不如对面好看的：${list(lost)}`);
}

if (candidate && key.variants.includes(candidate)) {
  const other = candidate === v1 ? v2 : v1;
  const rated = key.pairs.length - overall.unrated.length;
  const onlyCand = overall.bug[candidate].length - overall.bad.length;
  const onlyOther = overall.bug[other].length - overall.bad.length;
  console.log(`\n${candidate} 独有的明显 bug ${onlyCand} 次，${other} 独有的 ${onlyOther} 次（共评 ${rated} 对）`);
  console.log(`不算 bug 的偏好：${candidate} 更好 ${overall[candidate].length}，${other} 更好 ${overall[other].length}，差不多 ${overall.same.length}`);
}
