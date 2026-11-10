// Parsing of `mio test --format=json` (schema_version 1). Pure functions with no
// VS Code dependency so they can be unit tested against the real compiler.

export const SKIP_MARKER = '@@mio-test-skip@@';

export interface RawFailure {
  code?: string;
  message?: string;
}

export interface RawTest {
  name: string;
  path: string;
  status: string;
  duration_ms?: number;
  failures?: RawFailure[];
}

export interface RawPackage {
  path: string;
  status: string;
  tests?: RawTest[];
  error?: { code?: string; message?: string };
}

export interface RawReport {
  schema_version: number;
  packages: RawPackage[];
  summary?: { status?: string; passed?: number; failed?: number };
}

export type TestOutcome = 'passed' | 'failed' | 'skipped';

export interface TestResult {
  name: string;
  // File name as reported by the CLI (relative to the package directory).
  file: string;
  outcome: TestOutcome;
  durationMs: number | undefined;
  messages: string[];
}

export interface PackageResult {
  path: string;
  // A compile failure is distinct from a failing test: no test ran.
  compileError: string | undefined;
  tests: TestResult[];
}

export class TestReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestReportError';
  }
}

export function parseTestReport(stdout: string): PackageResult[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    throw new TestReportError(
      `mio test did not produce JSON output: ${(error as Error).message}`,
    );
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new TestReportError('mio test JSON output is not an object.');
  }
  const report = raw as Partial<RawReport>;
  if (report.schema_version !== 1) {
    throw new TestReportError(
      `Unsupported mio test JSON schema_version ${String(report.schema_version)}; this extension understands version 1.`,
    );
  }
  if (!Array.isArray(report.packages)) {
    throw new TestReportError('mio test JSON output has no packages array.');
  }
  return report.packages.map(toPackageResult);
}

function toPackageResult(raw: RawPackage): PackageResult {
  const compileError =
    raw.status === 'compile_failed'
      ? formatCompileError(raw.error)
      : undefined;
  return {
    path: raw.path,
    compileError,
    tests: (raw.tests ?? []).map(toTestResult),
  };
}

function formatCompileError(error: RawPackage['error']): string {
  const message = error?.message ?? 'compilation failed';
  return error?.code === undefined ? message : `${error.code}: ${message}`;
}

function toTestResult(raw: RawTest): TestResult {
  const messages = (raw.failures ?? []).map(
    (failure) => failure.message ?? '',
  );
  // The documented skip protocol: the marker record, then the reason record.
  if (messages[0] === SKIP_MARKER) {
    return {
      name: raw.name,
      file: raw.path,
      outcome: 'skipped',
      durationMs: raw.duration_ms,
      messages: messages.slice(1),
    };
  }
  return {
    name: raw.name,
    file: raw.path,
    outcome: raw.status === 'passed' ? 'passed' : 'failed',
    durationMs: raw.duration_ms,
    messages,
  };
}

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/gu;

// Anchored alternation for `mio test --run=<pattern>` (Go regexp syntax).
export function buildRunPattern(names: readonly string[]): string | undefined {
  const unique = [...new Set(names)];
  if (unique.length === 0) {
    return undefined;
  }
  return `^(${unique.map((n) => n.replace(REGEXP_SPECIAL, '\\$&')).join('|')})$`;
}

// A test function is any `test_*` function declared in a `*_test.mio` file.
export function isTestFileName(fileName: string): boolean {
  return fileName.endsWith('_test.mio');
}

export function isTestFunctionName(name: string): boolean {
  return name.startsWith('test_');
}
