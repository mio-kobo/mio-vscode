// Mio 标识符规则。生成器只会输出通过这里校验的名称，
// 因此生成结果不会出现与关键字、内置函数或保留前缀冲突的标识符。

import { MIO_GRAPH_RESERVED_PREFIX } from './types';

// 来自 Mio v1 语言文档的关键字。
export const MIO_KEYWORDS: readonly string[] = [
  'kaku',
  'waza',
  'moshi',
  'sore',
  'kaesu',
  'hai',
  'iie',
  'mu',
  'aida',
  'nukeru',
  'tsuzuku',
  'kata',
  'sentaku',
  'awase',
  'baai',
  'yobu',
  'koukai',
  'teisu',
];

export const MIO_PRIMITIVE_TYPE_NAMES: readonly string[] = [
  'int8',
  'int16',
  'int32',
  'int64',
  'rune',
  'uint8',
  'uint16',
  'uint32',
  'float32',
  'float64',
  'bool',
  'string',
  'unit',
];

export const MIO_BUILTIN_FUNCTION_NAMES: readonly string[] = [
  'chant',
  'len',
];

export const MIO_RESERVED_TYPE_NAMES: readonly string[] = [
  'Map',
  'Number',
  'Integer',
  'Signed',
  'Float',
  'resource',
];

const RESERVED = new Set<string>([
  ...MIO_KEYWORDS,
  ...MIO_PRIMITIVE_TYPE_NAMES,
  ...MIO_BUILTIN_FUNCTION_NAMES,
  ...MIO_RESERVED_TYPE_NAMES,
]);

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function isMioIdentifier(name: string): boolean {
  return IDENTIFIER_PATTERN.test(name);
}

export function isReservedMioIdentifier(name: string): boolean {
  return RESERVED.has(name);
}

export interface IdentifierValidation {
  valid: boolean;
  reason?: string;
}

// 校验蓝图声明出来的名称（变量、函数、参数）。
export function validateDeclarationName(name: string): IdentifierValidation {
  if (name === '') {
    return { valid: false, reason: 'name must not be empty' };
  }
  if (!isMioIdentifier(name)) {
    return {
      valid: false,
      reason:
        'name must start with an ASCII letter or underscore and contain only ASCII letters, digits and underscores',
    };
  }
  if (isReservedMioIdentifier(name)) {
    return {
      valid: false,
      reason: `"${name}" is a Mio keyword, built-in or reserved type name`,
    };
  }
  if (name.startsWith(MIO_GRAPH_RESERVED_PREFIX)) {
    return {
      valid: false,
      reason: `names starting with "${MIO_GRAPH_RESERVED_PREFIX}" are reserved for generated temporaries`,
    };
  }
  return { valid: true };
}

// FunctionCall 目标允许一个包限定名，例如 math.sqrt。
export function validateCallableName(name: string): IdentifierValidation {
  const segments = name.split('.');
  if (segments.length > 2) {
    return {
      valid: false,
      reason:
        'function name must be a plain identifier or one package-qualified name such as math.sqrt',
    };
  }
  if (segments.length === 2) {
    const [alias, member] = segments;
    if (alias === undefined || member === undefined) {
      return { valid: false, reason: 'invalid qualified function name' };
    }
    const aliasValidation = validatePackageAlias(alias);
    if (!aliasValidation.valid) {
      return aliasValidation;
    }
    if (!isMioIdentifier(member) || isReservedMioIdentifier(member)) {
      return {
        valid: false,
        reason: `"${name}" contains an invalid or reserved member name`,
      };
    }
    return { valid: true };
  }
  const plain = segments[0] ?? '';
  if (!isMioIdentifier(plain)) {
    return { valid: false, reason: `"${name}" is not a valid Mio identifier` };
  }
  return { valid: true };
}

function validatePackageAlias(alias: string): IdentifierValidation {
  if (!isMioIdentifier(alias)) {
    return {
      valid: false,
      reason: `"${alias}" is not a valid package alias`,
    };
  }
  // 标准库路径末段可以与类型同名（例如 kiso/string），只有关键字不能作别名。
  if (MIO_KEYWORDS.includes(alias)) {
    return {
      valid: false,
      reason: `"${alias}" is a Mio keyword and cannot be used as a package alias`,
    };
  }
  return { valid: true };
}
