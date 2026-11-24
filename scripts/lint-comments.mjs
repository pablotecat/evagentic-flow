import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function findComments(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    /\.jsonc?$/.test(file) ? ts.ScriptKind.JSON : undefined);
  if (source.parseDiagnostics.length) throw new Error(`${file}: cannot audit invalid syntax`);
  const ranges = new Map();
  const visit = node => {
    if (ts.isJSDoc(node) || node.kind === ts.SyntaxKind.JsxText) return;
    const children = node.getChildren(source);
    if (children.length) children.forEach(visit);
    else for (const range of [...ts.getLeadingCommentRanges(text, node.pos) ?? [],
      ...ts.getTrailingCommentRanges(text, node.pos) ?? []]) {
      if (range.end <= node.getStart(source)) ranges.set(range.pos, range);
    }
  };
  visit(source);
  return [...ranges.values()].sort((a, b) => a.pos - b.pos).map(({ pos, end }) => {
    const comment = text.slice(pos, end);
    const { line, character } = source.getLineAndCharacterOfPosition(pos);
    const endLine = source.getLineAndCharacterOfPosition(end).line;
    const before = text.slice(source.getPositionOfLineAndCharacter(line, 0), pos);
    const after = text.slice(end, source.getLineStarts()[endLine + 1] ?? text.length);
    return { file, line: line + 1, column: character + 1, pos, end, text: comment,
      hash: createHash('sha256').update(comment.replace(/\r\n?/g, '\n')).digest('hex'),
      lines: endLine - line + 1, removableLines: !before.trim() && !after.trim() ? endLine - line + 1 : 0 };
  });
}

export async function inventory(root) {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' }).split('\0'))]
    .filter(file => /\.(?:[cm]?[jt]sx?|jsonc?)$/.test(file)).sort();
  const comments = [];
  let sourceLines = 0;
  for (const file of files) {
    let text;
    try { text = await readFile(resolve(root, file), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    sourceLines += text.split(/\r\n|\r|\n/).length - Number(text.endsWith('\n'));
    comments.push(...findComments(file, text));
  }
  return { files, sourceLines, comments,
    commentLines: comments.reduce((sum, comment) => sum + comment.lines, 0),
    removableLines: comments.reduce((sum, comment) => sum + comment.removableLines, 0) };
}

export function checkBaseline(comments, baseline) {
  if (!Array.isArray(baseline) || baseline.some(entry => !entry || typeof entry.file !== 'string'
    || !/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isSafeInteger(entry.count) || entry.count < 1)) {
    throw new Error('Invalid comment baseline');
  }
  const key = entry => JSON.stringify([entry.file, entry.hash]);
  const allowed = new Map(baseline.map(entry => [key(entry), entry.count]));
  if (allowed.size !== baseline.length) throw new Error('Duplicate comment baseline entry');
  const current = new Map();
  const added = [];
  for (const comment of comments) {
    const id = key(comment);
    const entry = current.get(id) ?? { file: comment.file, hash: comment.hash, count: 0 };
    entry.count++;
    current.set(id, entry);
    if (entry.count > (allowed.get(id) ?? 0)) added.push(comment);
  }
  const stale = baseline.filter(entry => (current.get(key(entry))?.count ?? 0) < entry.count);
  return { added, stale, remaining: [...current.values()] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const mode = args[0]?.startsWith('--') ? args.shift() : undefined;
    const base = mode === '--base' ? args.shift() : undefined;
    if (args.length > 1 || (mode && !['--inventory', '--ratchet', '--base'].includes(mode))
      || (mode === '--base' && !base)) {
      throw new Error('Usage: node scripts/lint-comments.mjs [--inventory|--ratchet|--base <ref>] [repository]');
    }
    const root = resolve(args[0] ?? fileURLToPath(new URL('../', import.meta.url)));
    const result = await inventory(root);
    if (mode === '--inventory') console.log(JSON.stringify(result, null, 2));
    else {
      const path = resolve(root, '.comment-baseline.json');
      const baseline = JSON.parse(await readFile(path, 'utf8'));
      const { added, stale, remaining } = checkBaseline(result.comments, baseline);
      if (base) {
        const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
        const exists = git(['ls-tree', '--name-only', base, '--', '.comment-baseline.json']).trim();
        const previous = exists ? JSON.parse(git(['show', `${base}:.comment-baseline.json`])) : [];
        checkBaseline([], previous);
        const allowed = new Map(previous.map(entry => [JSON.stringify([entry.file, entry.hash]), entry.count]));
        if (baseline.some(entry => entry.count > (allowed.get(JSON.stringify([entry.file, entry.hash])) ?? 0))) {
          throw new Error('Comment baseline cannot increase relative to the base revision.');
        }
      }
      for (const comment of added) console.error(`${comment.file}:${comment.line}:${comment.column}: no-comments`);
      if (added.length) process.exitCode = 1;
      else if (mode === '--ratchet') {
        await writeFile(path, `${JSON.stringify(remaining, null, 2)}\n`);
        console.log(`Comment baseline reduced to ${result.comments.length}.`);
      } else if (stale.length) {
        console.error('Removed comments still have allowances. Run npm run lint:comments:ratchet.');
        process.exitCode = 1;
      } else console.log(`no-comments: ${result.comments.length} grandfathered, no new comments.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
