/**
 * «Было / Стало» (docs/visual-review.md): скриншоты экрана до задачи и после
 * неё — вложениями задачи в папке `было-стало/`. Ответ исполнителя — поле
 * карточки «Было / Стало»: «Есть» (картинки приложены) или «Нет визуальных
 * изменений» (`--no-visual` с причиной). Ставят его `kaiten review` и
 * `kaiten done` по вложениям, руками его никто не заполняет.
 *
 * Пара — по имени: `было-<экран>` и `стало-<экран>` (регистр и расширение не
 * важны). Одно `стало-` — новый экран; одно `было-` — экран убрали, а что
 * стало, не показали: отказ. Картинки ложатся в git репозитория задач навсегда
 * — поэтому предел меньше, чем у прочих вложений.
 */

import type { TaskType, VisualAnswer } from './schema.js';

export const VISUAL_DIR = 'было-стало';
export const VISUAL_TYPES: readonly TaskType[] = ['story', 'tech', 'bug'];
export const VISUAL_MAX_BYTES = 1024 * 1024;
export const VISUAL_MAX_PAIRS = 10;

const PICTURE_RE = /^(было|стало)-(.+)\.(png|jpe?g)$/iu;

/** `было-x.png` → «было», «x»; `null` — имя не картинки «Было / Стало». */
function parsePicture(file: string): { side: 'было' | 'стало'; screen: string } | null {
  const m = PICTURE_RE.exec(file);
  if (!m) return null;
  return { side: m[1].toLowerCase() === 'было' ? 'было' : 'стало', screen: m[2].toLowerCase() };
}

/**
 * Куда положить файл без `--as`: картинка `было-…`/`стало-…` — сразу в папку
 * `было-стало/`; `null` — обычное вложение.
 */
export function visualAttachName(file: string): string | null {
  return !file.includes('/') && parsePicture(file) ? `${VISUAL_DIR}/${file}` : null;
}

/** Что не так с вложением в папке `было-стало/`; `null` — годится или это не папка «Было / Стало». */
export function visualAttachProblem(name: string, size: number): string | null {
  if (!name.toLowerCase().startsWith(`${VISUAL_DIR}/`)) return null;
  const file = name.slice(VISUAL_DIR.length + 1);
  if (file.includes('/') || !parsePicture(file)) return `в папке ${VISUAL_DIR}/ — только картинки было-<экран>.png и стало-<экран>.png (png или jpg)`;
  if (size > VISUAL_MAX_BYTES) return `картинка «Было / Стало» больше 1 МБ — снимите область изменения или один экран, а не всю страницу, или сохраните в jpg`;
  return null;
}

/**
 * Вложение — картинка «Было / Стало»: в папке `было-стало/` или с именем
 * `было-…`/`стало-…` вне её (приложенная мимо папки через `--as`). Такие
 * убирает `kaiten detach`: на картинку мимо папки отказывает `review`.
 */
export function isVisualAttachment(name: string): boolean {
  return name.toLowerCase().startsWith(`${VISUAL_DIR}/`) || parsePicture(name.split('/').at(-1) ?? '') !== null;
}

/**
 * Какое вложение задачи назвали в `kaiten detach`. Имя как есть — первым:
 * `было-x.png` убирает копию мимо папки, а не её двойника в `было-стало/`
 * (09.11.2026 он убрал правильную); нет такой — картинку из папки.
 */
export function detachTarget(asked: string, attachments: readonly string[]): { name: string } | { problem: string } {
  const normalized = asked.replaceAll('\\', '/');
  const byName = (wanted: string) => attachments.find((name) => name.toLowerCase() === wanted.toLowerCase());
  const found = byName(normalized) ?? (normalized.includes('/') ? undefined : byName(`${VISUAL_DIR}/${normalized}`));
  if (!found) return { problem: `${asked}: у задачи такого вложения нет` };
  if (!isVisualAttachment(found)) return { problem: `${asked}: убрать можно только картинку «Было / Стало»` };
  return { name: found };
}

/** Экран картинки из папки `было-стало/` (`было-стало/было-x.png` → «x»); `null` — не картинка «Было / Стало». */
function visualScreen(name: string): string | null {
  if (!name.toLowerCase().startsWith(`${VISUAL_DIR}/`)) return null;
  const file = name.slice(VISUAL_DIR.length + 1);
  return file.includes('/') ? null : (parsePicture(file)?.screen ?? null);
}

/** Команда, которой убирают лишние экраны, — для отказов. */
export function visualDetachHint(ref: string): string {
  return `kaiten detach ${ref} было-<экран>.png стало-<экран>.png`;
}

/**
 * Не даст ли картинка задаче экранов больше предела — проверка `attach` до
 * записи, а не отказ `review` после 40 приложенных скриншотов. Картинка
 * имеющегося экрана (переснятая или вторая половина пары) предел не трогает.
 */
export function visualLimitProblem(name: string, attachments: readonly string[], ref: string): string | null {
  const screen = visualScreen(name);
  if (screen === null) return null;
  const screens = new Set(attachments.map(visualScreen).filter((s): s is string => s !== null));
  if (screens.has(screen) || screens.size < VISUAL_MAX_PAIRS) return null;
  return (
    `у задачи уже ${screens.size} экранов «Было / Стало», больше ${VISUAL_MAX_PAIRS} не прикладывается — покажите главное. ` +
    `Переснятый экран приложите под его прежним именем; чтобы показать этот экран вместо другого, сначала уберите тот: ${visualDetachHint(ref)}`
  );
}

/** Ответ и запись для журнала (её нет, когда ответ уже был в задаче) — или что исправить. */
export type VisualDecision = { visual: VisualAnswer; note?: string } | { problems: string[] };

export interface VisualInput {
  /** Имена вложений задачи (`было-стало/было-x.png`, `report.md`…). */
  attachments: readonly string[];
  /** Причина из `--no-visual`; `undefined` — флага нет. */
  noVisual?: string;
  /** Ответ, уже записанный в задаче. */
  current?: VisualAnswer;
  /** Ключ задачи и команда — для готовых команд в отказе. */
  ref: string;
  command: 'review' | 'done';
}

/**
 * Ответ «Было / Стало» для `review`/`done`: по картинкам во вложениях или по
 * `--no-visual`. Всё, что не так, — одним списком: команда откажет до записи.
 */
export function visualDecision(input: VisualInput): VisualDecision {
  const pictures: Array<{ name: string; side: 'было' | 'стало'; screen: string }> = [];
  const problems: string[] = [];
  for (const name of input.attachments) {
    const inDir = name.toLowerCase().startsWith(`${VISUAL_DIR}/`);
    const file = inDir ? name.slice(VISUAL_DIR.length + 1) : name;
    const picture = file.includes('/') ? null : parsePicture(file);
    if (inDir && picture) pictures.push({ name, ...picture });
    else if (inDir) problems.push(`${name}: в папке ${VISUAL_DIR}/ — только было-<экран>.png и стало-<экран>.png; уберите его: kaiten detach ${input.ref} ${name}`);
    // Приложили мимо папки (через --as) — такую картинку никто не увидит как «Было / Стало».
    else if (picture) {
      const twin = input.attachments.some((other) => other.toLowerCase() === `${VISUAL_DIR}/${file}`.toLowerCase());
      problems.push(
        twin
          ? `${name} — лишняя копия вне папки ${VISUAL_DIR}/ (в папке такая есть), уберите её: kaiten detach ${input.ref} ${name}`
          : `${name} лежит не в папке ${VISUAL_DIR}/ — приложите заново: kaiten attach ${input.ref} <файл> --as ${VISUAL_DIR}/${name}, а эту уберите: kaiten detach ${input.ref} ${name}`,
      );
    }
  }

  if (input.noVisual !== undefined) {
    const why = input.noVisual.trim();
    if (!why) return { problems: ['--no-visual: напишите, почему на экране ничего не меняется'] };
    if (pictures.length > 0) return { problems: [`--no-visual, а во вложениях есть картинки «Было / Стало» (${pictures.length}) — уберите флаг: картинки и есть ответ`] };
    return { visual: 'no', note: `без «Было / Стало»: ${why}` };
  }

  if (pictures.length === 0 && problems.length === 0) {
    if (input.current) return { visual: input.current };
    return {
      problems: [
        `нет «Было / Стало». Задача меняет то, что видно на экране, — приложите скриншоты до и после: ` +
          `kaiten attach ${input.ref} было-<экран>.png, затем kaiten attach ${input.ref} стало-<экран>.png (как снимать — в скилле kaiten). ` +
          `На экране ничего не меняется — скажите почему: kaiten ${input.command} ${input.ref} --no-visual "<почему>"`,
      ],
    };
  }

  const screens = new Map<string, { было: string[]; стало: string[] }>();
  for (const p of pictures) {
    const entry = screens.get(p.screen) ?? { было: [], стало: [] };
    entry[p.side].push(p.name);
    screens.set(p.screen, entry);
  }
  for (const [screen, sides] of screens) {
    for (const side of ['было', 'стало'] as const) {
      if (sides[side].length > 1) problems.push(`${side}-${screen}: файлов несколько (${sides[side].join(', ')}) — оставьте один, лишние уберите: kaiten detach ${input.ref} <файл>`);
    }
    if (sides.стало.length === 0) problems.push(`было-${screen} без стало-${screen} — покажите, что стало: kaiten attach ${input.ref} стало-${screen}.png`);
  }
  if (screens.size > VISUAL_MAX_PAIRS) {
    problems.push(
      `экранов «Было / Стало» ${screens.size}, можно не больше ${VISUAL_MAX_PAIRS} — оставьте главные, остальные уберите: ${visualDetachHint(input.ref)} ` +
        `(можно несколько экранов за раз). Экраны: ${[...screens.keys()].join(', ')}`,
    );
  }
  if (problems.length > 0) return { problems };
  return { visual: 'yes', note: `«Было / Стало»: экранов ${screens.size}` };
}

/** Применимо ли «Было / Стало» к задаче этого типа. */
export function visualApplies(type: TaskType): boolean {
  return VISUAL_TYPES.includes(type);
}
