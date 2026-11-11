import * as assert from 'node:assert/strict';
import { completeExpression, importPrefix, numericTypes, scan, semicolonOffset, smartCandidates } from '../../editor/context';
import { embeddedModules } from '../../editor/moduleCatalog';

const options = { smartSnippets: true, autoInsertParentheses: true };
suite('Smart editing context', () => {
  for (const name of ['moshi', 'aida', 'chant', 'len', ...numericTypes]) {
    test(`native snippet template for ${name}`, () => {
      const before = numericTypes.includes(name) ? 'kaku x = ' : '';
      const candidate = smartCandidates(before, name.slice(0, -1), '', options).find(c => c.label === name)!;
      assert.ok(candidate.insert.includes('$1') || candidate.insert.includes('${1:condition}'));
      assert.ok(candidate.insert.endsWith('$0'));
    });
  }
  for (const before of ['kaku x: ', 'kaku data: []', 'array.make[', 'array.make[\n', 'waza f(x: ', 'kaku x = array.make[', 'array.make[int32, ', 'waza f(', 'waza f(\n']) {
    test(`plain numeric type after ${JSON.stringify(before)}`, () => {
      assert.equal(smartCandidates(before, 'uint8', '', options)[0]?.insert, 'uint8');
    });
  }
  for (const before of ['// ', '/* comment\n', 'chant("', 'kaku 日本', 'something_', 'object.']) {
    test(`no expansion after ${JSON.stringify(before)}`, () => {
      assert.deepEqual(smartCandidates(before, 'moshi', '', options), []);
    });
  }
  for (const suffix of ['(', ' ()', ' {', 'Identifier']) {
    test(`no duplicate block or identifier edit before ${suffix}`, () => {
      assert.deepEqual(smartCandidates('', 'moshi', suffix, options), []);
    });
  }
  test('does not offer unsupported uint64 from the pinned v2.1.2 type system', () => {
    assert.deepEqual(smartCandidates('kaku x = ', 'uint64', '', options), []);
  });
  test('settings independently disable transformations', () => {
    assert.deepEqual(smartCandidates('', 'moshi', '', { ...options, smartSnippets: false }), []);
    assert.equal(smartCandidates('kaku x = ', 'uint8', '', { ...options, autoInsertParentheses: false })[0].insert, 'uint8');
  });
  for (const prefix of ['', 'kiso/', 'kiso/ma', 'kiso/net/', '本地/模块', '日本語/']) {
    test(`import prefix ${prefix}`, () => {
      assert.equal(importPrefix(`yobu "${prefix}`)?.prefix, prefix);
      assert.equal(importPrefix(`/* comment */\nyobu "${prefix}`)?.prefix, prefix);
    });
  }
  for (const text of ['chant("kiso/', '// yobu "', '/* yobu "', 'yobu "closed"', 'yobu "bad\\path', 'yobu "bad\n']) {
    test(`no import at ${JSON.stringify(text)}`, () => assert.equal(importPrefix(text), undefined));
  }
  test('catalog includes verified embedded math and TCP modules', () => {
    assert.ok(embeddedModules.includes('kiso/math'));
    assert.ok(embeddedModules.includes('kiso/net/tcp'));
    assert.ok(!embeddedModules.includes('third-party/imaginary'));
  });
  test('lexical masking preserves offsets and complete literal marker', () => {
    const text = '"中\\\"文" /* comment */\n// line\n';
    const result = scan(text);
    assert.equal(result.code.length, text.length);
    assert.equal(result.code[0], '0');
    assert.equal(result.state, 'code');
  });
});
suite('Conservative semicolons', () => {
  for (const line of ['kaku x = 42', 'chant("Hello")', 'kaesu value', 'kaesu', 'yobu "kiso/math"', '  kaku x: uint8 = uint8(42)', 'chant("// literal") // trailing', 'chant(42) /* trailing */', 'waza main() -> unit {\n  chant(1)']) {
    test(`complete ${JSON.stringify(line)}`, () => {
      const offset = semicolonOffset(line);
      assert.notEqual(offset, undefined);
      const edited = line.slice(0, offset) + ';' + line.slice(offset);
      if (line.includes('// trailing')) { assert.match(edited, /\); \/\/ trailing$/u); }
    });
  }
  for (const line of ['moshi (condition) {', 'aida (condition) {', 'waza main() -> unit {', '}', 'kaku x = ', 'kaku x = 1 +', 'kaku x = moshi', 'kaku x = call(', 'chant("open)', 'kaku x = 42;', '// comment', '/* comment', 'kaku x = call(\n  value', 'kaku x = [\n chant(42)', 'moshi(condition)', 'aida(condition)', 'chant(1)\n']) {
    test(`skip ${JSON.stringify(line)}`, () => assert.equal(semicolonOffset(line), undefined));
  }
  for (const expr of ['f(1, g(2))', 'len(values) + 1', '-42', 'foo.bar[1]']) {
    test(`recognizes ${expr}`, () => assert.equal(completeExpression(expr), true));
  }
  for (const expr of ['1 +', 'foo(', 'f(,)', 'foo..bar', '[1,2]', 'value value']) {
    test(`rejects ${expr}`, () => assert.equal(completeExpression(expr), false));
  }
});
