import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modules = new Set([
  'agent-context', 'agent-control-block', 'agent-scheduler', 'agent-round',
  'model-requester', 'agent-runtime', 'integrations', 'server',
]);
const shared = ['types', 'capability', 'character', 'tools'];
const dependencies = {
  'agent-context': ['types'],
  'agent-control-block': ['agent-context', 'capability', 'types'],
  'agent-scheduler': ['agent-control-block', 'types'],
  'agent-round': ['agent-context', 'agent-scheduler', 'model-requester', 'types'],
  'model-requester': ['types'],
  'agent-runtime': ['agent-context', 'agent-control-block', 'agent-scheduler', 'agent-round', 'model-requester', ...shared],
  integrations: ['tools', 'types', 'capability'],
  server: ['agent-runtime', 'model-requester', 'integrations', ...shared],
};
const failures = [];
let checked = 0;
function parts(path) { return relative(root, path).split(sep); }
function owner(path) {
  const pathParts = parts(path);
  return pathParts[0] === 'src' ? pathParts[1] : pathParts[0];
}
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (/\.(?:ts|tsx|mjs|cjs)$/u.test(entry.name)) result.push(path);
  }
  return result;
}
function imports(source) {
  const values = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)) values.push(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)) values.push(node.argument.literal);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0])) values.push(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return values;
}
const scopes = [
  ...[...modules].map((module) => join(root, 'src', module)),
  ...['main', 'preload', 'renderer', 'shared'].map((area) => join(root, 'desktop-next', area)),
];
for (const scope of scopes) for (const path of await files(scope)) {
  checked++;
  const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const origin = owner(path);
  for (const specifier of imports(source)) {
    const value = specifier.text;
    const target = value.startsWith('.') ? resolve(dirname(path), value) : undefined;
    const destination = target ? owner(target) : undefined;
    let reason;
    if (modules.has(origin)) {
      if (destination === 'desktop' || destination === 'desktop-next' || /^(?:electron|react)(?:\/|$)/u.test(value)) {
        reason = '核心或适配模块不能依赖桌面与 UI';
      } else if (destination && destination !== origin && !dependencies[origin].includes(destination)) {
        reason = `依赖方向不允许 ${origin} -> ${destination}`;
      } else if (destination && destination !== origin && modules.has(destination) &&
          !/[\\/]index\.(?:js|ts)$/u.test(target)) {
        reason = '跨模块只使用 index 公共入口';
      }
    } else if (origin === 'desktop-next' && target) {
      const area = parts(path)[1];
      if (area !== 'main' && parts(target)[0] === 'src') reason = '渲染与预加载层不能直接依赖核心实现';
      if (area === 'main' && modules.has(destination) && !/[\\/]index\.(?:js|ts)$/u.test(target)) {
        reason = '桌面宿主只能使用新模块公共入口';
      }
      if (destination === 'desktop') reason = '新桌面不能接入旧桌面服务';
    }
    if (reason) {
      const line = source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1;
      failures.push(`${relative(root, path)}:${line} ${reason}：${value}`);
    }
  }
}
if (failures.length) {
  process.stderr.write(failures.join('\n') + '\n');
  process.exitCode = 1;
} else process.stdout.write(`模块边界检查通过：${checked}个生产源码文件。\n`);
