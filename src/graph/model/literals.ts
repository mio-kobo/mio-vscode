// Mio 字面量校验与格式化。所有输出都遵循 Mio v1 的真实词法规则：
// 整数只允许十进制，浮点必须带小数点或指数，字符串只支持 \n \r \t \" \\ 转义。

import type { GraphLiteral, MioDataTypeName } from './types';
import { isFloatMioType, isIntegerMioType } from './types';

interface IntegerRange {
  min: number;
  max: number;
}

// int64 在 JSON/JS 中只能安全表示到 2^53-1；更大的值要求用户改用拆分计算。
const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;

const INTEGER_RANGES: Record<string, IntegerRange> = {
  int8: { min: -128, max: 127 },
  int16: { min: -32768, max: 32767 },
  int32: { min: -2147483648, max: 2147483647 },
  int64: { min: -SAFE_INTEGER_MAX, max: SAFE_INTEGER_MAX },
  uint8: { min: 0, max: 255 },
  uint16: { min: 0, max: 65535 },
  uint32: { min: 0, max: 4294967295 },
};

// 返回错误描述；undefined 表示字面量与目标类型兼容。
export function validateLiteral(
  type: MioDataTypeName,
  value: GraphLiteral,
): string | undefined {
  if (type === 'string') {
    if (typeof value !== 'string') {
      return `expected a string literal for ${type}, got ${describeLiteral(value)}`;
    }
    const unsupported = findUnsupportedStringCharacter(value);
    if (unsupported !== undefined) {
      return `string contains U+${unsupported
        .toString(16)
        .toUpperCase()
        .padStart(4, '0')}, which Mio string literals cannot represent`;
    }
    return undefined;
  }
  if (type === 'bool') {
    if (typeof value !== 'boolean') {
      return `expected hai/iie for ${type}, got ${describeLiteral(value)}`;
    }
    return undefined;
  }
  if (!isIntegerMioType(type) && !isFloatMioType(type)) {
    return `unsupported literal type ${String(type)}`;
  }
  if (typeof value !== 'number') {
    return `expected a number literal for ${type}, got ${describeLiteral(value)}`;
  }
  if (!Number.isFinite(value)) {
    return `literal for ${type} must be finite`;
  }
  if (isIntegerMioType(type)) {
    if (!Number.isInteger(value)) {
      return `literal ${value} is not an integer and cannot initialize ${type}`;
    }
    if (!Number.isSafeInteger(value)) {
      return `literal ${value} is outside the safe JSON integer range (|value| <= 2^53-1)`;
    }
    const range = INTEGER_RANGES[type];
    if (range === undefined) {
      return `unsupported integer type ${type}`;
    }
    if (value < range.min || value > range.max) {
      return `literal ${value} is out of range for ${type} (${range.min}..${range.max})`;
    }
    return undefined;
  }
  // 浮点：float32 需要能精确落到 binary32（不能溢出为 Infinity）。
  if (type === 'float32' && !Number.isFinite(Math.fround(value))) {
    return `literal ${value} overflows float32`;
  }
  return undefined;
}

export function describeLiteral(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return `a ${typeof value}`;
}

// 返回 Mio 源码中的字面量文本。调用前必须先通过 validateLiteral。
export function formatMioLiteral(
  type: MioDataTypeName,
  value: GraphLiteral,
): string {
  if (type === 'string') {
    return `"${escapeMioString(String(value))}"`;
  }
  if (type === 'bool') {
    return value === true ? 'hai' : 'iie';
  }
  const numeric = Number(value);
  if (type === 'float32') {
    return formatFloatText(Math.fround(numeric), true);
  }
  if (type === 'float64') {
    return formatFloatText(numeric, false);
  }
  return String(Math.trunc(numeric));
}

function escapeMioString(value: string): string {
  let result = '';
  for (const character of value) {
    switch (character) {
      case '\\':
        result += '\\\\';
        break;
      case '"':
        result += '\\"';
        break;
      case '\n':
        result += '\\n';
        break;
      case '\r':
        result += '\\r';
        break;
      case '\t':
        result += '\\t';
        break;
      default:
        result += character;
        break;
    }
  }
  return result;
}

function findUnsupportedStringCharacter(value: string): number | undefined {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      if (code === 0x0a || code === 0x0d || code === 0x09) {
        continue;
      }
      return code;
    }
    // 未配对的 UTF-16 代理项会在写成 UTF-8 时变成替换字符，必须拒绝而不是悄悄改变数据。
    if (code >= 0xd800 && code <= 0xdfff) {
      return code;
    }
  }
  return undefined;
}

// 浮点文本必须能被 Mio 词法器重新解析，且对 float32 还要能精确舍入回去。
function formatFloatText(value: number, roundToFloat32: boolean): string {
  if (Object.is(value, -0)) {
    return '-0.0';
  }
  if (roundToFloat32) {
    for (let precision = 1; precision <= 17; precision += 1) {
      const candidate = value.toPrecision(precision);
      if (Math.fround(Number(candidate)) === value) {
        return normalizeFloatText(candidate);
      }
    }
    return normalizeFloatText(value.toPrecision(17));
  }
  return normalizeFloatText(String(value));
}

function normalizeFloatText(text: string): string {
  let result = text;
  if (result.includes('e') || result.includes('E')) {
    const [mantissa, exponent] = result.split(/e/i);
    const normalizedMantissa = trimMantissa(mantissa ?? '0');
    return `${normalizedMantissa}e${exponent ?? '0'}`;
  }
  result = trimMantissa(result);
  return result.includes('.') ? result : `${result}.0`;
}

function trimMantissa(text: string): string {
  if (!text.includes('.')) {
    return text;
  }
  let result = text.replace(/0+$/u, '');
  if (result.endsWith('.')) {
    result = result.slice(0, -1);
  }
  return result === '' || result === '-' ? '0' : result;
}
