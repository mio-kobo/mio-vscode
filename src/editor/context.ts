/** Tolerant lexical masking only; no compiler or semantic analysis. Offsets are UTF-16. */
export interface LexicalContext {
  code: string;
  state: 'code' | 'lineComment' | 'blockComment' | 'string';
  stringStart: number;
}
export function scan(text: string): LexicalContext {
  const output = text.split('');
  let state: LexicalContext['state'] = 'code';
  let quote = '';
  let stringStart = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (state === 'lineComment') {
      if (c === '\n') { state = 'code'; } else { output[i] = ' '; }
    } else if (state === 'blockComment') {
      if (c !== '\n') { output[i] = ' '; }
      if (c === '*' && next === '/') { output[++i] = ' '; state = 'code'; }
    } else if (state === 'string') {
      if (c !== '\n') { output[i] = ' '; }
      if (c === '\\' && next !== undefined) { output[++i] = next === '\n' ? '\n' : ' '; }
      else if (c === quote) { output[stringStart] = '0'; state = 'code'; }
    } else if (c === '/' && (next === '/' || next === '*')) {
      state = next === '/' ? 'lineComment' : 'blockComment';
      output[i] = output[++i] = ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      state = 'string'; quote = c; stringStart = i; output[i] = ' ';
    }
  }
  return { code: output.join(''), state, stringStart };
}
export const numericTypes = ['int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'float32', 'float64', 'rune'];
export const smartNames = ['moshi', 'aida', 'chant', 'len', ...numericTypes];
export interface SmartCandidate { label: string; insert: string; }
export interface EditingOptions { smartSnippets: boolean; autoInsertParentheses: boolean; }

export function importPrefix(text: string): { prefix: string; start: number } | undefined {
  const lexical = scan(text);
  if (lexical.state !== 'string' || text[lexical.stringStart] !== '"') { return undefined; }
  const before = lexical.code.slice(0, lexical.stringStart);
  if (!/(?:^|[;{}\n])\s*yobu\s+$/u.test(before)) { return undefined; }
  const prefix = text.slice(lexical.stringStart + 1);
  if (/["\\\n\r]/u.test(prefix)) { return undefined; }
  return { prefix, start: lexical.stringStart + 1 };
}

export function smartCandidates(beforeWord: string, prefix: string, after: string, options: EditingOptions): SmartCandidate[] {
  if (!options.smartSnippets || !prefix || /[\p{L}\p{N}_]/u.test(after[0] ?? '')) { return []; }
  const lex = scan(beforeWord);
  if (lex.state !== 'code' || /[\p{L}\p{N}_.]$/u.test(beforeWord)) { return []; }
  const code = lex.code;
  const line = code.slice(code.lastIndexOf('\n') + 1);
  const typeArgument = /[\p{L}\p{N}_.]\[\s*[\p{L}\p{N}_, \n\[\]]*$/u.test(code);
  const expression = !typeArgument && !/\bwaza\b[^{};]*$/u.test(code) && /(?:=(?!=)|\bkaesu|[+(,\-*/%!?]|&&|\|\|)\s*$/u.test(code);
  const statement = /(?:^|[;{}\n])\s*$/u.test(code);
  const items: SmartCandidate[] = [];
  for (const label of smartNames.filter(name => name.startsWith(prefix))) {
    let insert = label;
    const emptyTail = /^\s*(?:\/\/.*)?$/u.test(after);
    if (options.autoInsertParentheses && !/^\s*[({]/u.test(after)) {
      if (['moshi', 'aida'].includes(label) && statement && emptyTail) { insert += ' (${1:condition}) {\n\t$2\n}$0'; }
      else if (label === 'chant' && statement && emptyTail) { insert += '($1);$0'; }
      else if (label === 'len' && (statement || expression)) { insert += '($1)$0'; }
      else if (numericTypes.includes(label) && expression && !/:\s*(?:\[\])*[^=]*$/u.test(line)) { insert += '($1)$0'; }
    }
    // Numeric type names remain plain in all ambiguous and type positions.
    if (numericTypes.includes(label) || insert !== label) { items.push({ label, insert }); }
  }
  return items;
}

/** Deliberately small expression recognizer: skip unfamiliar or incomplete syntax. */
export function completeExpression(text: string): boolean {
  const tokens = text.match(/(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[\p{L}_][\p{L}\p{N}_]*|==|!=|<=|>=|&&|\|\||[()+\-*/%<>,.!\[\]])/gu) ?? [];
  if (tokens.join('') !== text.replace(/\s/gu, '') || !tokens.length) { return false; }
  const incompleteKeywords = new Set(['kaku', 'teisu', 'waza', 'moshi', 'aida', 'sore', 'yobu', 'kaesu', 'kata', 'sentaku', 'awase', 'baai', 'koukai', 'nukeru', 'tsuzuku', 'yuzuru']);
  if (tokens.some(token => incompleteKeywords.has(token))) { return false; }
  let index = 0;
  const atom = (): boolean => {
    if (['!', '-', '+'].includes(tokens[index])) { index++; return atom(); }
    if (tokens[index] === '(') {
      index++;
      if (!expression() || tokens[index++] !== ')') { return false; }
    } else if (/^(?:[\p{L}_][\p{L}\p{N}_]*|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/u.test(tokens[index] ?? '')) { index++; }
    else { return false; }
    while (['(', '[', '.'].includes(tokens[index])) {
      const op = tokens[index++];
      if (op === '.') { if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(tokens[index++] ?? '')) { return false; } }
      else {
        const end = op === '(' ? ')' : ']';
        if (tokens[index] !== end) {
          if (!expression()) { return false; }
          while (tokens[index] === ',' && op === '(') { index++; if (!expression()) { return false; } }
        } else if (op === '[') { return false; }
        if (tokens[index++] !== end) { return false; }
      }
    }
    return true;
  };
  const expression = (): boolean => {
    if (!atom()) { return false; }
    while (/^(?:[+\-*/%<>]|==|!=|<=|>=|&&|\|\|)$/u.test(tokens[index] ?? '')) { index++; if (!atom()) { return false; } }
    return true;
  };
  return expression() && index === tokens.length;
}

/** Returns the insertion offset in the full prefix ending at the previous line. */
export function semicolonOffset(text: string): number | undefined {
  const lexical = scan(text);
  if (lexical.state === 'string' || lexical.state === 'blockComment') { return undefined; }
  const start = text.lastIndexOf('\n') + 1;
  const code = lexical.code.slice(start);
  const trimmed = code.trim();
  if (!trimmed || /[;{}]$/u.test(trimmed)) { return undefined; }
  // Earlier unclosed calls/arrays imply a multiline expression, never a new statement.
  const earlier = lexical.code.slice(0, start);
  let depth = 0;
  for (const c of earlier) { if (c === '(' || c === '[') { depth++; } else if (c === ')' || c === ']') { depth--; } }
  if (depth !== 0) { return undefined; }
  const declaration = /^(?:kaku|teisu)\s+[\p{L}_][\p{L}\p{N}_]*(?:\s*:\s*(?:\[\])*[\p{L}_][\p{L}\p{N}_]*)?\s*=\s*(.+)$/u.exec(trimmed);
  const returned = /^kaesu(?:\s+(.+))?$/u.exec(trimmed);
  const imported = /^yobu\s+0$/u.test(trimmed);
  if (/^(?:moshi|aida|waza|awase|baai|sore)\b/u.test(trimmed)) { return undefined; }
  const call = /^[\p{L}_][\p{L}\p{N}_.]*\s*\(/u.test(trimmed);
  if (!(imported || (declaration && completeExpression(declaration[1])) ||
    (returned && (!returned[1] || completeExpression(returned[1]))) || (call && completeExpression(trimmed)))) { return undefined; }
  // Closed string masks are padded; find literal end using original source, not the mask.
  // Find a trailing comment outside literals by scanning prefixes at the comment delimiter.
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === '/' && ['/', '*'].includes(text[i + 1]) && scan(text.slice(0, i)).state === 'code') {
      return text.slice(0, i).trimEnd().length;
    }
  }
  return text.trimEnd().length;
}
