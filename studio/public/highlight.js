// Minimal, dependency-free syntax highlighter. Tokenizes a single pass over the
// source with one combined regex (comments/strings first, then keywords/numbers)
// and returns escaped HTML with <span class="tok-*"> wrappers, safe to inject as
// innerHTML. Not a full language grammar - just enough to make code readable.
const KEYWORDS = {
  js: 'const let var function return if else for while do switch case break continue class extends new this super import export from default async await try catch finally throw typeof instanceof in of yield static get set null undefined true false void delete'.split(' '),
  py: 'def class return if elif else for while break continue import from as try except finally raise with lambda yield pass in is not and or None True False global nonlocal async await del assert'.split(' '),
  css: [],
  html: [],
  json: ['true', 'false', 'null'],
  md: [],
};
export const LANGUAGE_ALIASES = {js: 'js', mjs: 'js', ts: 'js', tsx: 'js', jsx: 'js', py: 'py', json: 'json', jsonl: 'json', css: 'css', html: 'html', md: 'md', txt: null, yml: null, yaml: null, toml: null, ps1: null, lua: null, csv: null};

const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// One alternation covering: line comments, block comments, triple/py-triple strings,
// quoted strings, numbers, and bare words (checked against the keyword list after match).
const TOKEN_RE = /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?''')|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)/g;

export function highlightToHTML(text, lang) {
  const key = LANGUAGE_ALIASES[lang] ?? lang;
  const keywords = new Set(KEYWORDS[key] || []);
  if (!key || !(key in KEYWORDS)) return escapeHtml(text ?? '');
  const src = text ?? '';
  let out = '';
  let last = 0;
  for (const m of src.matchAll(TOKEN_RE)) {
    out += escapeHtml(src.slice(last, m.index));
    const [whole, lineComment, blockComment, hashComment, tripleString, string, number, word] = m;
    if (lineComment || blockComment || hashComment) out += `<span class="tok-comment">${escapeHtml(whole)}</span>`;
    else if (tripleString || string) out += `<span class="tok-string">${escapeHtml(whole)}</span>`;
    else if (number) out += `<span class="tok-number">${escapeHtml(whole)}</span>`;
    else if (word && keywords.has(word)) out += `<span class="tok-keyword">${escapeHtml(whole)}</span>`;
    else out += escapeHtml(whole);
    last = m.index + whole.length;
  }
  out += escapeHtml(src.slice(last));
  return out;
}
