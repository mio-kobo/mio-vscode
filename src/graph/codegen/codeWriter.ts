// 结构化 Mio 源码输出：统一管理缩进、换行与行号，
// 避免各代码生成分支自己拼接字符串。

const INDENT_UNIT = '    ';

export class MioCodeWriter {
  private readonly lines: string[] = [];
  private indentLevel = 0;

  // 下一行（1-based）的行号，用于 source map。
  nextLineNumber(): number {
    return this.lines.length + 1;
  }

  line(text = ''): void {
    if (text === '') {
      this.pushBlankLine();
      return;
    }
    this.lines.push(`${INDENT_UNIT.repeat(this.indentLevel)}${text}`);
  }

  pushBlankLine(): void {
    if (this.lines.length === 0 || this.lines[this.lines.length - 1] === '') {
      return;
    }
    this.lines.push('');
  }

  pushIndent(): void {
    this.indentLevel += 1;
  }

  popIndent(): void {
    if (this.indentLevel > 0) {
      this.indentLevel -= 1;
    }
  }

  toString(): string {
    const lines = [...this.lines];
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return `${lines.join('\n')}\n`;
  }
}
