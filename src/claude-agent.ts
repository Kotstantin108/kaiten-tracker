/**
 * Запуск модели одним вопросом: `claude -p` только на чтение, ответ — по схеме.
 * Общее для скрипта оценки (`assess.ts`) и исследования находок
 * (`kaiten-found.ts`): ни записи, ни MCP, ни сети, кроме самой модели.
 */

import { spawn, spawnSync } from 'node:child_process';

import { z } from 'zod';

/** Что читаем из ответа `claude -p --output-format json`. */
const ClaudeResultSchema = z
  .object({
    is_error: z.boolean().optional(),
    subtype: z.string().optional(),
    result: z.string().optional(),
    structured_output: z.unknown().optional(),
    total_cost_usd: z.number().optional(),
    permission_denials: z.array(z.object({ tool_name: z.string(), tool_input: z.object({ command: z.string().optional() }).passthrough().optional() }).passthrough()).optional(),
  })
  .passthrough();

/** `denied` — вызовы, в которых модели отказано: ответ мог стать слабее. */
export type ClaudeOutcome = { answer: unknown; costUsd?: number; denied?: string[] } | { error: string };

export interface ClaudeJob {
  model: string;
  /** Папка, в которой работает модель. */
  cwd: string;
  prompt: string;
  /** Схема ответа (zod) — уходит модели как JSON Schema. */
  schema: z.ZodType;
  /** Инструменты, которые модель видит: `Read`, `Grep`, `Glob`, `Bash`. */
  tools: readonly string[];
  /** Что разрешено без вопроса: имена инструментов и правила вида `Bash(git log:*)`. */
  allowed: readonly string[];
  /** Ещё папки, которые модель может читать. */
  addDirs?: readonly string[];
  timeoutMs: number;
}

/** Haiku для оценки и исследования не используем: ложный вердикт дороже экономии. */
export function modelProblem(model: string): string | null {
  return /haiku/i.test(model) ? 'Haiku не используем — claude-opus-5-5 или claude-sonnet-5-5' : null;
}

/** Запускается ли модель на этой машине — тем же способом, каким её запускает `runClaude`. */
export function claudeAvailable(): boolean {
  return spawnSync('claude', ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 20_000 }).status === 0;
}

export function runClaude(job: ClaudeJob): Promise<ClaudeOutcome> {
  // Без `$schema`: `claude` не знает адреса draft 2020-12 и отвергает схему (живьём 20.10).
  const schema = JSON.stringify(Object.fromEntries(Object.entries(z.toJSONSchema(job.schema)).filter(([k]) => k !== '$schema')));
  return new Promise((done) => {
    const args = [
      '-p',
      '--model',
      job.model,
      '--output-format',
      'json',
      '--json-schema',
      schema,
      '--tools',
      ...job.tools,
      '--allowedTools',
      ...job.allowed,
      ...(job.addDirs && job.addDirs.length > 0 ? ['--add-dir', ...job.addDirs] : []),
      '--strict-mcp-config',
      '--no-session-persistence',
      '--permission-prompts',
      'none',
    ];
    const child = spawn('claude', args, { cwd: job.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), job.timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ error: `агент не запустился: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json: unknown;
      try {
        json = JSON.parse(out);
      } catch {
        done({ error: `агент не ответил (код ${code ?? 'нет'})${err.trim() ? `: ${err.trim().slice(0, 300)}` : ''}` });
        return;
      }
      const parsed = ClaudeResultSchema.safeParse(json);
      if (!parsed.success) {
        done({ error: 'ответ агента не разбирается' });
        return;
      }
      const r = parsed.data;
      if (r.is_error || r.structured_output === undefined) {
        done({ error: `агент не дал ответа по схеме (${r.subtype ?? 'ошибка'})${r.result ? `: ${r.result.slice(0, 300)}` : ''}` });
        return;
      }
      const denied = (r.permission_denials ?? []).map((d) => d.tool_input?.command ?? d.tool_name);
      done({ answer: r.structured_output, costUsd: r.total_cost_usd, denied });
    });
    // Модель не запустилась — писать некуда: ошибку уже сообщил обработчик `error`.
    child.stdin.on('error', () => undefined);
    child.stdin.end(job.prompt);
  });
}
