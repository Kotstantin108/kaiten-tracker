/**
 * Отдельный процесс для теста параллельной записи (`parallel.test.ts`): ведёт
 * себя как агент — несколько записей в свою задачу, после каждой отправка
 * общим, как это делает фоновый `kaiten __send`.
 *
 *   node --import tsx parallel-worker.ts <хранилище> <id задачи> <сколько записей> <метка>
 */
import { recordOp, syncStore } from '../store-write.js';
import { StoreError } from '../task-store.js';

const [store, id, count, tag] = process.argv.slice(2);
const DATE = '2026-09-30';
const problems: string[] = [];

for (let i = 0; i < Number(count); i += 1) {
  const recorded = recordOp(store, { kind: 'log', id, text: `${tag}-${i}` }, `журнал ${tag}`, DATE);
  if ('error' in recorded) problems.push(`запись ${tag}-${i}: ${recorded.error}`);
  try {
    const sent = syncStore(store);
    for (const f of sent.failed) problems.push(`не применено ${f.what}: ${f.reason}`);
  } catch (error) {
    // «Занято» и «отвергнуто» — не потеря: операция в журнале, её отправит следующий проход.
    if (!(error instanceof StoreError) || (error.kind !== 'busy' && error.kind !== 'rejected')) problems.push(`отправка ${tag}-${i}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.stdout.write(JSON.stringify({ tag, problems }));
