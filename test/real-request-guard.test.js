/**
 * 真实请求静态守卫 — 测试文件不得留下真实外呼/真实进程的口子(2026-06-06 事故防再犯)。
 *
 * 与运行时铁闸互补的静态防线(仿 test/test-env-isolation-guard.test.js 扫描器形态):
 *   R1:测试文件调用 spawnImProcess( → 同文件必须出现 spawnImpl(注入假 spawn)。
 *       L4 运行时闸(im-process-manager.js)会兜底拒绝,但静态层先行拦截,
 *       避免依赖运行时 warning 被忽略。
 *   R2:测试文件给全局 fetch 赋值(global/globalThis.fetch =)→ 同文件必须满足其一:
 *       a) 保存原值形态(= global(This).fetch,之后可还原);
 *       b) 退出兜底(process.exit / .unref()):合法的「常驻合成 fetch」模式
 *          (如 interceptor-fetch-errors.test.js,整进程生命周期都用合成上游,靠强退收尾)。
 *       两者皆无 = 改了全局 fetch 又不还原又不退出 → 污染同进程后续用例,违规。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = __dirname;
const SELF = 'real-request-guard.test.js';

/** R1:调用了 spawnImProcess 但全文无 spawnImpl → 违规 */
export function violatesSpawnInjection(src) {
  if (!/spawnImProcess\s*\(/.test(src)) return false;
  return !/spawnImpl/.test(src);
}

/** R2:赋值了全局 fetch,但既无原值保存形态、又无退出兜底 → 违规 */
export function violatesFetchDiscipline(src) {
  if (!/global(This)?\.fetch\s*=(?!=)/.test(src)) return false;       // 没改全局 fetch,不管辖
  if (/=\s*global(This)?\.fetch\b/.test(src)) return false;           // a) 保存原值(可还原)
  if (/process\.exit\s*\(|\.unref\s*\(/.test(src)) return false;      // b) 常驻合成 + 强退兜底
  return true;
}

describe('真实请求静态守卫(R1 spawn 注入 / R2 全局 fetch 纪律)', () => {
  it('扫描器自检:R1 好/坏样本', () => {
    assert.equal(violatesSpawnInjection(`pm.spawnImProcess('x')`), true, '无 spawnImpl 应违规');
    assert.equal(violatesSpawnInjection(`pm.spawnImProcess('x', { spawnImpl: fake })`), false);
    assert.equal(violatesSpawnInjection(`// 只是提到别的`), false, '未调用不管辖');
  });

  it('扫描器自检:R2 好/坏样本', () => {
    assert.equal(violatesFetchDiscipline(`globalThis.fetch = fake;`), true, '无保存无兜底应违规');
    assert.equal(violatesFetchDiscipline(`const o = globalThis.fetch; globalThis.fetch = fake;`), false, '有保存放行');
    assert.equal(violatesFetchDiscipline(`global.fetch = fake; setTimeout(() => process.exit(0), 30).unref();`), false, '常驻合成+强退放行');
    assert.equal(violatesFetchDiscipline(`if (globalThis.fetch === undefined) {}`), false, '比较运算不管辖');
    assert.equal(violatesFetchDiscipline(`await fetch(url)`), false, '未赋值不管辖');
  });

  it('全量 test/*.test.js:R1+R2 零违规', () => {
    const files = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js') && f !== SELF);
    const violations = [];
    for (const f of files) {
      const src = readFileSync(join(TEST_DIR, f), 'utf-8');
      if (violatesSpawnInjection(src)) violations.push(`${f} [R1: spawnImProcess 未注入 spawnImpl]`);
      if (violatesFetchDiscipline(src)) violations.push(`${f} [R2: 全局 fetch 赋值无保存也无退出兜底]`);
    }
    assert.deepEqual(violations, [],
      `以下测试文件存在真实外呼/真实进程口子(规则见文件头注释):\n  ${violations.join('\n  ')}`);
  });
});
