import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MIO_KEYWORDS } from '../../graph/model/identifiers';

const root = path.resolve(__dirname, '../../..');

// Keywords that the TextMate grammar scopes as keywords (control + declaration patterns).
function grammarKeywords(): string[] {
  const grammar = JSON.parse(
    fs.readFileSync(path.join(root, 'syntaxes/mio.tmLanguage.json'), 'utf8'),
  );
  const words = new Set<string>();
  for (const pattern of grammar.repository.keywords.patterns) {
    const m = /\(\?:([a-z|]+)\)/.exec(pattern.match);
    assert.ok(m, `unexpected keyword pattern ${pattern.match}`);
    m[1].split('|').forEach((w: string) => words.add(w));
  }
  // Literals are scoped separately.
  for (const literal of ['hai', 'iie', 'mu']) {
    words.add(literal);
  }
  return [...words].sort();
}

suite('Mio keyword lists', () => {
  test('the TextMate grammar and MIO_KEYWORDS list the same keywords', () => {
    assert.deepEqual(grammarKeywords(), [...MIO_KEYWORDS].sort());
  });

  test('yuzuru is a reserved keyword', () => {
    assert.ok(MIO_KEYWORDS.includes('yuzuru'));
    assert.ok(grammarKeywords().includes('yuzuru'));
  });

  test('every keyword of the checked-out core lexer is listed', () => {
    const tokenFile = path.join(root, '.mio-core/internal/token/token.go');
    if (!fs.existsSync(tokenFile)) {
      return; // core checkout is only present in the integration setup
    }
    const source = fs.readFileSync(tokenFile, 'utf8');
    const compiler = new Set<string>();
    for (const block of source.matchAll(/var keywords\w+ = map\[string\]Type\{([\s\S]*?)\n\}/g)) {
      for (const m of block[1].matchAll(/"([a-z]+)":/g)) {
        compiler.add(m[1]);
      }
    }
    assert.ok(compiler.size > 0, 'no keywords parsed from the core lexer');
    // The pinned core may predate newer reserved words, so only a superset is required.
    for (const word of compiler) {
      assert.ok(MIO_KEYWORDS.includes(word), `${word} is a compiler keyword missing from MIO_KEYWORDS`);
      assert.ok(grammarKeywords().includes(word), `${word} is a compiler keyword missing from the grammar`);
    }
  });
});
