/** Отказ со списком — то, что агент обязан исполнить: что исправить, по пунктам. */
export class Refusal extends Error {
  constructor(
    readonly title: string,
    readonly items: string[],
  ) {
    super(title);
  }

  render(): string {
    return this.items.length === 1 ? `${this.title}: ${this.items[0]}` : `${this.title}:\n${this.items.map((x, i) => `${i + 1}. ${x}`).join('\n')}`;
  }
}

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** Выполнить тело инструмента: отказ — как есть, прочие ошибки — без внутренностей. */
export async function runTool(body: () => Promise<string>, describeError: (error: unknown) => string): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: await body() }] };
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Refusal ? error.render() : describeError(error) }], isError: true };
  }
}
