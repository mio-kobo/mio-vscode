// 函数签名提供者。生成器本身不硬编码标准库；
// 未来可以把这里替换成从 Mio 编译器 / LSP 读取签名的实现。

import type {
  GraphFunctionSignature,
  MioDataTypeName,
  MioTypeName,
} from './model/types';
import { normalizeMioTypeName } from './model/types';

// any 只用于内置函数参数（例如 chant），不会出现在蓝图文件里。
export type MioParameterType = MioDataTypeName | 'any';

export interface MioFunctionParameter {
  name: string;
  type: MioParameterType;
}

export interface MioFunctionSignature {
  name: string;
  parameters: MioFunctionParameter[];
  returnType: MioTypeName;
  builtin: boolean;
}

export interface FunctionSignatureProvider {
  resolve(name: string): MioFunctionSignature | undefined;
  list(): readonly MioFunctionSignature[];
}

// Mio v1 的语言内置函数。它们不来自任何包，因此可以在任意文件中直接调用。
// len 需要数组类型，第一阶段蓝图不支持数组，故不在此声明。
export const BUILTIN_FUNCTION_SIGNATURES: readonly MioFunctionSignature[] = [
  {
    name: 'chant',
    parameters: [{ name: 'value', type: 'any' }],
    returnType: 'unit',
    builtin: true,
  },
];

export class StaticFunctionSignatureProvider
  implements FunctionSignatureProvider
{
  private readonly signatures = new Map<string, MioFunctionSignature>();

  constructor(signatures: readonly MioFunctionSignature[] = []) {
    for (const signature of signatures) {
      this.signatures.set(signature.name, signature);
    }
  }

  resolve(name: string): MioFunctionSignature | undefined {
    return this.signatures.get(name);
  }

  list(): readonly MioFunctionSignature[] {
    return [...this.signatures.values()];
  }
}

export class CompositeFunctionSignatureProvider
  implements FunctionSignatureProvider
{
  constructor(private readonly providers: readonly FunctionSignatureProvider[]) {}

  resolve(name: string): MioFunctionSignature | undefined {
    for (const provider of this.providers) {
      const signature = provider.resolve(name);
      if (signature !== undefined) {
        return signature;
      }
    }
    return undefined;
  }

  list(): readonly MioFunctionSignature[] {
    const seen = new Set<string>();
    const result: MioFunctionSignature[] = [];
    for (const provider of this.providers) {
      for (const signature of provider.list()) {
        if (seen.has(signature.name)) {
          continue;
        }
        seen.add(signature.name);
        result.push(signature);
      }
    }
    return result;
  }
}

// 把蓝图 metadata.functions 中的函数契约转换为运行时签名。
export function signaturesFromMetadata(
  functions: readonly GraphFunctionSignature[],
): MioFunctionSignature[] {
  return functions.map((signature) => ({
    name: signature.name,
    parameters: signature.parameters.map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
    })),
    returnType: normalizeMioTypeName(signature.returnType),
    builtin: false,
  }));
}

export function createGraphSignatureProvider(
  functions: readonly GraphFunctionSignature[],
): FunctionSignatureProvider {
  return new CompositeFunctionSignatureProvider([
    new StaticFunctionSignatureProvider(signaturesFromMetadata(functions)),
    new StaticFunctionSignatureProvider(BUILTIN_FUNCTION_SIGNATURES),
  ]);
}

// 蓝图自带签名优先，其次是外部提供者（例如未来的 LSP），最后是 Mio 内置函数。
export function createSignatureProvider(
  functions: readonly GraphFunctionSignature[],
  external?: FunctionSignatureProvider,
): FunctionSignatureProvider {
  const providers: FunctionSignatureProvider[] = [
    new StaticFunctionSignatureProvider(signaturesFromMetadata(functions)),
  ];
  if (external !== undefined) {
    providers.push(external);
  }
  providers.push(new StaticFunctionSignatureProvider(BUILTIN_FUNCTION_SIGNATURES));
  return new CompositeFunctionSignatureProvider(providers);
}
