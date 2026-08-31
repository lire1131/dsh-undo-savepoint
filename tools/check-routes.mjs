/**
 * dsh-undo-savepoint: 双端 REST 契约 parity 检查。
 *
 * 用途：局内（lib/index.js）与局外（tools/undo-server.mjs）的 REST 面历史上
 * 靠人肉保持同步，issue #18（局外缺 /api/undo/note）就是漂移的直接产物。
 * 本工具把当前契约固化为清单，任何一端新增/删除路由而未登记契约时，
 * npm test 在此变红，强制开发者先想清楚"双端是否都要"。
 *
 * 已知且接受的协议级差异（path 相同但请求/响应结构不同，勿"顺手统一"，
 * 两端前端各自绑定现协议）：restore 参数名（host: body.id / standalone:
 * body.snapshot_id）、safe-mode 请求体（host: action / standalone: on）、
 * status 响应（standalone 额外带 profiles）、settings POST（仅 host 触发
 * watcher/timer/workspaceDirs）。export/import 双端均支持可选 password
 * （PR #30 起局外也透传，两端行为一致）。
 *
 * 用法：node tools/check-routes.mjs（已加入 npm test）
 *
 * @module dsh-undo-savepoint/check-routes
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 契约清单：双端必须都实现的 method+path */
const BOTH = [
  'GET /api/undo/status',
  'GET /api/undo/list',
  'GET /api/undo/diff',
  'GET /api/undo/settings',
  'GET /api/undo/messages',
  'POST /api/undo/settings',
  'POST /api/undo/message',
  'POST /api/undo/note',
  'POST /api/undo/snapshot',
  'POST /api/undo/undo',
  'POST /api/undo/redo',
  'POST /api/undo/restore',
  'POST /api/undo/remove',
  'POST /api/undo/prune',
  'POST /api/undo/export',
  'POST /api/undo/import',
  'POST /api/undo/pick-dir',
  'POST /api/undo/pick-file',
  'POST /api/undo/safe-mode',
];
/** 仅局内（DSH 宿主 REST 面）实现 */
const HOST_ONLY = ['GET /api/undo/tree'];
/** 仅局外 undo-server 实现 */
const STANDALONE_ONLY = ['GET /api/undo/doctor', 'GET /api/undo/locale'];

// 从源码提取路由登记：匹配 `method === 'GET' && path === '/api/undo/x'` 模式
function extractRoutes(src) {
  const re = /method\s*===\s*'(GET|POST)'\s*&&\s*path\s*===\s*'(\/api\/undo\/[a-z-]+)'/g;
  const found = new Set();
  for (const m of src.matchAll(re)) found.add(`${m[1]} ${m[2]}`);
  return found;
}

let fail = 0;
const check = (cond, label) => {
  if (!cond) { fail++; console.error('  FAIL -', label); }
  else console.log('  ok  -', label);
};

const hostSrc = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8');
const standaloneSrc = await readFile(join(ROOT, 'tools', 'undo-server.mjs'), 'utf8');
const host = extractRoutes(hostSrc);
const standalone = extractRoutes(standaloneSrc);

const bothSet = new Set(BOTH);
const hostExpected = new Set([...BOTH, ...HOST_ONLY]);
const standaloneExpected = new Set([...BOTH, ...STANDALONE_ONLY]);

// 1. 契约清单内部自洽（清单重复项检查）
check(bothSet.size === BOTH.length, `契约清单无重复项 (${BOTH.length} 条双端路由)`);

// 2. 双端实际注册面 == 契约清单（集合相等，任何未登记的新路由都会红）
const missingInHost = [...hostExpected].filter((r) => !host.has(r));
const extraInHost = [...host].filter((r) => !hostExpected.has(r));
check(missingInHost.length === 0, `局内无缺失路由${missingInHost.length ? '，缺: ' + missingInHost.join(', ') : ''}`);
check(extraInHost.length === 0, `局内无未登记路由${extraInHost.length ? '，多出: ' + extraInHost.join(', ') + '（请在 check-routes.mjs 登记契约，双端都要还是单端特有）' : ''}`);

const missingInStandalone = [...standaloneExpected].filter((r) => !standalone.has(r));
const extraInStandalone = [...standalone].filter((r) => !standaloneExpected.has(r));
check(missingInStandalone.length === 0, `局外无缺失路由${missingInStandalone.length ? '，缺: ' + missingInStandalone.join(', ') : ''}`);
check(extraInStandalone.length === 0, `局外无未登记路由${extraInStandalone.length ? '，多出: ' + extraInStandalone.join(', ') + '（请在 check-routes.mjs 登记契约）' : ''}`);

if (fail > 0) {
  console.error(`\n路由契约检查未通过。新增路由时请同步登记：双端都有的进 BOTH，单端特有的进 HOST_ONLY / STANDALONE_ONLY。已知可接受的协议级差异见本文件头注释。`);
  process.exit(1);
}
console.log(`路由契约 parity 检查通过：双端 ${BOTH.length} 条，局内独有 ${HOST_ONLY.length} 条，局外独有 ${STANDALONE_ONLY.length} 条。`);
