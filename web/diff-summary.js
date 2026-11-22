import { translate } from './i18n.js';

function importPurpose(added, deleted, after) {
  const imports = /^\s*import[ \t]+(\{[^}]+\}|[\w$]+)\s+from\s+['"]([^'"\n]+)['"]/gm;
  for (const [, specifier, module] of added.matchAll(imports)) {
    for (const binding of specifier.replace(/[{}]/g, '').split(',')) {
      const name = binding.trim().split(/\s+as\s+/).at(-1);
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      const symbol = name.replaceAll('$', '\\$');
      const call = new RegExp(`(?<![\\w$])${symbol}\\s*\\(`);
      const definition = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${symbol}\\s*\\(`, 'm');
      const fallback = new RegExp(`([\\w$.]+)\\s*(\\?\\?|\\|\\|)\\s*${symbol}\\s*\\(`).exec(after);
      const extracted = definition.test(deleted);
      const called = call.test(after.replace(definition, ''));
      if (!fallback && !called && !extracted) continue;
      const intro = [extracted ? 'diffExtract' : 'diffImport', name, module];
      if (!fallback) return [intro];
      const [, value, operator] = fallback;
      if (value === 'hunk.explanation' && name === 'describeHunk') return [intro, ['diffMissingExplanation']];
      return [intro, [operator === '??' ? 'diffNullFallback' : 'diffFalsyFallback', value, name]];
    }
  }
  return null;
}

function changePurpose(hunk, removedFile, after) {
  const added = hunk.lines.filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n');
  const deleted = hunk.lines.filter(line => line.startsWith('-')).map(line => line.slice(1)).join('\n');
  const imported = importPurpose(added, removedFile, after);
  if (imported) return imported;
  const nullable = /([\w$]+)\?\.([\w$]+)/.exec(added);
  if (nullable && deleted.includes(`${nullable[1]}.${nullable[2]}`)) {
    return [['diffNullable', nullable[1], nullable[2]]];
  }
  const guard = /\bif\s*\(([^()\n]{1,100})\)\s*(?:\{\s*)?(return|throw)\b/.exec(added);
  if (guard) {
    return [[guard[2] === 'throw' ? 'diffThrow' : 'diffReturn', guard[1].trim()]];
  }
  const test = /\b(?:test|it)\s*\(\s*['"]([^'"\n]{1,130})['"]/.exec(added);
  return test ? [['diffTest', test[1]]] : null;
}

export function addDiffSummaries(hunks, afterText) {
  if (hunks.every(hunk => Array.isArray(hunk.summary))) return hunks;
  const lines = hunks.flatMap(hunk => hunk.lines);
  const removedFile = lines.filter(line => line.startsWith('-')).map(line => line.slice(1)).join('\n');
  const after = afterText ?? lines.filter(line => line.startsWith(' ') || line.startsWith('+')).map(line => line.slice(1)).join('\n');
  return hunks.map(hunk => {
    if (Array.isArray(hunk.summary)) return hunk;
    const summary = changePurpose(hunk, removedFile, after);
    return summary ? { ...hunk, summary } : hunk;
  });
}

export function describeHunk(hunk, language = 'zh-CN') {
  const t = (key, ...values) => translate(language, key, ...values);
  if (Array.isArray(hunk.summary)) return hunk.summary.map(([key, ...values]) => t(key, ...values)).join(language === 'en' ? ' ' : '');
  if (typeof hunk.summary === 'string' && language !== 'en') return hunk.summary;
  const added = hunk.lines.filter(line => line.startsWith('+'));
  const removed = hunk.lines.filter(line => line.startsWith('-'));
  const describe = lines => {
    const sample = lines.map(line => line.slice(1).trim()).find(Boolean);
    if (!sample) return t('blankLines', lines.length);
    const excerpt = sample.length > 85 ? `${sample.slice(0, 85)}…` : sample;
    return lines.length === 1 ? t('quoteExcerpt', excerpt) : t('lineExcerpt', excerpt, lines.length);
  };
  if (added.length && removed.length) {
    if (added.length === removed.length && added.every((line, index) => line.slice(1).trim() === removed[index].slice(1).trim())) {
      return t('diffWhitespace', added.length);
    }
    return t('diffReplace', describe(removed), describe(added));
  }
  if (added.length) return t('diffAdd', describe(added));
  if (removed.length) return t('diffRemove', describe(removed));
  return t('diffFinalNewline');
}
