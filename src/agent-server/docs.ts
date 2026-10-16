/**
 * Режим «Документы»: страницы в документах Kaiten по правилам папок.
 *
 * Три слоя защиты (docs/agent-server.md):
 *   1. уровни — свободно / с подтверждением человека / запрещено — по правилам
 *      папки («⚙ Правила для агента», наследуются подпапками);
 *   2. подтверждение — не через агента: сервер возвращает одноразовую ссылку,
 *      человек видит разницу «было → станет» и нажимает «Применить»;
 *   3. копия страницы перед каждой записью — для отката.
 *
 * Kaiten пишет содержимое только целиком и без блокировки, поэтому перед
 * записью страница перечитывается: изменилась после чтения — отказ.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { KaitenApiError } from '../kaiten-client.js';
import { normalizeTitle, titleProblem } from './board-rules.js';
import {
  addHistory,
  type DocLink,
  findSection,
  FolderRulesSchema,
  type FolderRules,
  HISTORY,
  isRulesTitle,
  linkTypes,
  type Page,
  parsePage,
  renderPage,
  type Status,
  STATUSES,
} from './doc-page.js';
import type { AgentKaiten, Catalog, KaitenDocument } from './kaiten-agent.js';
import { openData, sealData } from './key.js';
import { docOf, markdownToNodes, nodesToMarkdown, parseDocData, type PMNode, plainText } from './prosemirror.js';
import { Refusal, runTool } from './refusal.js';
import type { Store } from './store.js';
import { cardIdOf, cardRef, cardUrl } from './tasks.js';

export interface DocDeps {
  kaiten: AgentKaiten;
  catalog: Catalog;
  domain: string;
  secret: string;
  store: Store;
  /** Адрес сервера — для ссылок подтверждения. */
  publicUrl: string;
  /** Ключ агента этого человека: по нему подтверждённое действие выполнится от его имени. */
  agentKey: string;
  describeError: (error: unknown) => string;
}

/**
 * Страницы, написанные людьми в интерфейсе, агент пока только читает: не
 * проверено, примет ли API правку документа новой схемы (чек-листы, вкладки).
 */
export const HUMAN_PAGES_WRITABLE = false;

const PENDING_TTL = 30 * 60;
const SNAPSHOT_TTL = 30 * 86400;

export const docUrl = (domain: string, uid: string): string => `https://${domain}/documents/${uid}`;

const today = (): string => new Date().toISOString().slice(0, 10);

/** uid документа или папки из uid или ссылки. */
export function uidOf(ref: string): string | null {
  const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(ref);
  return match ? match[0].toLowerCase() : null;
}

// ── правила папки ───────────────────────────────────────────────────────────

export interface ResolvedRules {
  rules: FolderRules;
  folderTitle: string;
}

/** Правила из страницы правил: блок кода YAML. */
export function parseRulesPage(nodes: PMNode[]): { rules: FolderRules } | { problem: string } {
  const block = nodes.find((n) => n.type === 'code_block');
  if (!block) return { problem: 'на странице правил нет блока кода с правилами' };
  let raw: unknown;
  try {
    raw = parseYaml((block.content ?? []).map((n) => n.text ?? '').join(''));
  } catch (error) {
    return { problem: `блок правил не разбирается как YAML: ${(error as Error).message.split('\n')[0]}` };
  }
  const parsed = FolderRulesSchema.safeParse(raw);
  if (!parsed.success) return { problem: parsed.error.issues.map((i) => `${i.path.join('.') || 'корень'} — ${i.message}`).join('; ') };
  return { rules: parsed.data };
}

/**
 * Правила для узла дерева: ищем страницу правил в нём и выше по папкам.
 * Сломанные правила не наследуются сверху — папка закрыта (fail closed).
 */
export async function rulesFor(deps: DocDeps, startUid: string | null | undefined): Promise<ResolvedRules | { problem: string }> {
  let uid = startUid ?? null;
  for (let depth = 0; uid && depth < 10; depth++) {
    const children = await deps.kaiten.treeChildren(uid).catch(() => []);
    const rulesNode = children.find((n) => n.entity_type === 'document' && isRulesTitle(n.title));
    let title = '';
    let parent: string | null = null;
    try {
      const group = await deps.kaiten.getDocumentGroup(uid);
      title = group.title;
      parent = group.parent_entity_uid ?? null;
    } catch {
      // Не папка: документ внутри документа — идём к его родителю; иначе — пространство, выше правил нет.
      const doc = await deps.kaiten.getDocument(uid).catch(() => null);
      if (!doc) return { problem: 'у папки нет правил для агента («⚙ Правила для агента») — она только для чтения' };
      if (rulesNode) return { problem: 'правила лежат внутри документа, а не в папке — папка только для чтения' };
      uid = doc.parent_entity_uid ?? null;
      continue;
    }
    if (rulesNode) {
      const page = await deps.kaiten.getDocument(rulesNode.uid);
      const parsed = parseRulesPage(parseDocData(page.data));
      if ('problem' in parsed) return { problem: `правила папки «${title}» не разбираются: ${parsed.problem} — папка закрыта для агента` };
      return { rules: parsed.rules, folderTitle: title };
    }
    uid = parent;
  }
  return { problem: 'у папки нет правил для агента («⚙ Правила для агента») — она только для чтения' };
}

// ── загрузка страницы ───────────────────────────────────────────────────────

interface Loaded {
  doc: KaitenDocument;
  nodes: PMNode[];
  page: Page;
  rules: ResolvedRules | { problem: string };
}

async function loadDoc(deps: DocDeps, ref: string): Promise<Loaded> {
  const uid = uidOf(ref);
  if (!uid) throw new Refusal('Не понял, какой документ', ['укажите uid документа или ссылку на него']);
  const doc = await deps.kaiten.getDocument(uid);
  if (isRulesTitle(doc.title)) throw new Refusal('Это служебная страница правил', ['агент её не читает и не меняет — правила папки видны в list_docs и read_doc']);
  const nodes = parseDocData(doc.data);
  return { doc, nodes, page: parsePage(nodes), rules: await rulesFor(deps, doc.parent_entity_uid) };
}

function requireWritable(loaded: Loaded): ResolvedRules {
  if ('problem' in loaded.rules) throw new Refusal('Документ только для чтения', [loaded.rules.problem]);
  if (!loaded.page.header && !HUMAN_PAGES_WRITABLE) {
    throw new Refusal('Страницу написал человек в Kaiten', ['такие страницы агент пока только читает; правки — вручную в Kaiten']);
  }
  return loaded.rules;
}

type Level = 'free' | 'confirm';

function levelFor(action: 'append' | 'replace' | 'status' | 'rename' | 'rollback' | 'link', rules: FolderRules, page: Page): Level {
  if (action === 'status' || action === 'rename' || action === 'rollback') return 'confirm';
  if (action === 'link') return 'free';
  const base = rules.levels[action];
  if (rules.levels.locked_when_active && page.header?.status === 'Действует') return 'confirm';
  return base;
}

// ── запись, копии, подтверждения ────────────────────────────────────────────

interface Snapshot {
  title: string;
  data: unknown;
  savedAt: string;
  by: string;
}

async function snapshot(deps: Pick<DocDeps, 'store' | 'secret'>, doc: KaitenDocument, by: string): Promise<void> {
  // Пустую страницу (только что созданную) хранить незачем.
  if (!plainText(parseDocData(doc.data))) return;
  const value: Snapshot = { title: doc.title, data: doc.data ?? null, savedAt: new Date().toISOString(), by };
  await deps.store.put(`snap:${doc.uid}:${Date.now().toString().padStart(15, '0')}`, await sealData(value, deps.secret), SNAPSHOT_TTL);
}

interface WritePlan {
  uid: string;
  /** `updated` страницы на момент чтения агентом; нет — страница только что создана. */
  baseUpdated?: string;
  content: PMNode[];
  title?: string;
  /** Внешние ссылки на документ, которые добавить в карточки после записи. */
  cardLinks?: Array<{ cardId: number; title: string }>;
}

/** Запись: перечитать, сверить, снять копию, записать. */
export async function commitWrite(deps: Pick<DocDeps, 'kaiten' | 'store' | 'secret' | 'domain'>, plan: WritePlan, by: string): Promise<string[]> {
  const fresh = await deps.kaiten.getDocument(plan.uid);
  if (isRulesTitle(fresh.title)) throw new Refusal('Это служебная страница правил', ['её агент не меняет']);
  if (plan.baseUpdated !== undefined && fresh.updated !== plan.baseUpdated) {
    throw new Refusal('Страница изменилась после того, как агент её прочитал', ['перечитайте её (read_doc) и повторите правку — иначе пропали бы чужие изменения']);
  }
  await snapshot(deps, fresh, by);
  await deps.kaiten.updateDocument(plan.uid, { data: docOf(plan.content), ...(plan.title ? { title: plan.title } : {}) });
  const failed: string[] = [];
  for (const link of plan.cardLinks ?? []) {
    try {
      await deps.kaiten.addExternalLink(link.cardId, docUrl(deps.domain, plan.uid), link.title);
    } catch {
      failed.push(`ссылка на документ в карточке #${link.cardId}`);
    }
  }
  return failed;
}

const PendingSchema = z.object({
  userId: z.number(),
  agentKey: z.string(),
  docTitle: z.string(),
  summary: z.string(),
  before: z.string(),
  after: z.string(),
  by: z.string(),
  plan: z.object({
    uid: z.string(),
    baseUpdated: z.string().optional(),
    content: z.array(z.unknown()),
    title: z.string().optional(),
    cardLinks: z.array(z.object({ cardId: z.number(), title: z.string() })).optional(),
  }),
});
export type Pending = z.infer<typeof PendingSchema>;

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function askHuman(deps: DocDeps, userId: number, pending: Omit<Pending, 'userId' | 'agentKey'>): Promise<string> {
  const id = randomId();
  const value: Pending = { ...pending, userId, agentKey: deps.agentKey };
  await deps.store.put(`pending:${id}`, await sealData(value, deps.secret), PENDING_TTL);
  return (
    `НУЖНО ПОДТВЕРЖДЕНИЕ ЧЕЛОВЕКА — пока ничего не записано.\n${pending.summary}\n\n` +
    `Покажите пользователю ссылку и попросите открыть её и нажать «Применить»: ${deps.publicUrl.replace(/\/+$/, '')}/confirm/${id}\n` +
    'Ссылка одноразовая, действует 30 минут. Сами по ней не переходите.'
  );
}

export async function loadPending(store: Store, secret: string, id: string): Promise<Pending | null> {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(id)) return null;
  const sealed = await store.get(`pending:${id}`);
  if (!sealed) return null;
  const parsed = PendingSchema.safeParse(await openData(sealed, secret));
  return parsed.success ? parsed.data : null;
}

export async function dropPending(store: Store, id: string): Promise<void> {
  await store.delete(`pending:${id}`);
}

/** Выполнить подтверждённое действие (вызывает страница подтверждения). */
export async function applyPending(deps: Pick<DocDeps, 'kaiten' | 'store' | 'secret' | 'domain'>, pending: Pending): Promise<string> {
  try {
    const failed = await commitWrite(deps, { ...pending.plan, content: pending.plan.content as PMNode[] }, pending.by);
    return `Применено: ${pending.summary}${failed.length ? ` Не получилось: ${failed.join(', ')}.` : ''}`;
  } catch (error) {
    if (error instanceof Refusal) return `Не применено. ${error.render()}`;
    if (error instanceof KaitenApiError) return `Не применено: Kaiten ответил ошибкой ${error.status}.`;
    throw error;
  }
}

/** Записать сразу или спросить человека — по уровню. */
async function writeOrAsk(deps: DocDeps, level: Level, loaded: Loaded, plan: WritePlan, summary: string, me: { id: number; name: string }): Promise<string> {
  if (level === 'free') {
    const failed = await commitWrite(deps, plan, me.name);
    return `Готово: ${summary} — ${docUrl(deps.domain, plan.uid)}${failed.length ? `\nНе получилось: ${failed.join(', ')}.` : ''}`;
  }
  return askHuman(deps, me.id, {
    docTitle: plan.title ?? loaded.doc.title,
    summary,
    before: `# ${loaded.doc.title}\n\n${nodesToMarkdown(loaded.nodes).markdown}`,
    after: `# ${plan.title ?? loaded.doc.title}\n\n${nodesToMarkdown(plan.content).markdown}`,
    by: me.name,
    plan,
  });
}

// ── построение содержимого ──────────────────────────────────────────────────

function convertSection(name: string, markdown: string, problems: string[]): PMNode[] {
  const converted = markdownToNodes(markdown);
  for (const p of converted.problems) problems.push(`раздел «${name}»: ${p}`);
  if (!plainText(converted.nodes)) problems.push(`раздел «${name}» пустой — напишите его или спросите пользователя`);
  return converted.nodes;
}

async function me(deps: DocDeps): Promise<{ id: number; name: string }> {
  const user = await deps.kaiten.currentUser();
  return { id: user.id, name: user.full_name?.trim() || user.email || `#${user.id}` };
}

async function cardLinksFor(deps: DocDeps, refs: Array<number | string>, rules: FolderRules, problems: string[]): Promise<Array<{ cardId: number; link: DocLink }>> {
  const out: Array<{ cardId: number; link: DocLink }> = [];
  const types = await deps.catalog.cardTypes();
  const wanted = linkTypes(rules);
  for (const ref of refs) {
    const id = cardIdOf(ref);
    const card = id === null ? null : await deps.kaiten.getCard(id).catch(() => null);
    if (!card) {
      problems.push(`карточка «${String(ref)}» не найдена или недоступна`);
      continue;
    }
    const spaceId = card.board_id ? await deps.catalog.spaceOf(card.board_id) : null;
    out.push({ cardId: card.id, link: { title: `#${card.id} ${card.title ?? ''}`.trim(), url: cardUrl(deps.domain, spaceId ?? 0, card.id) } });
    const typeName = types.find((t) => t.id === card.type_id)?.name;
    if (wanted.length && typeName && !wanted.includes(typeName)) problems.push(`#${card.id} — «${typeName}», а связывать страницу этой папки нужно с: ${wanted.join(', ')}`);
  }
  if (wanted.length && out.length === 0 && !problems.some((p) => p.startsWith('карточка'))) {
    problems.push(`свяжите страницу с карточкой типа ${wanted.map((t) => `«${t}»`).join(' или ')} (links)`);
  }
  return out;
}

function rulesSummary(r: ResolvedRules): string {
  const rules = r.rules;
  const link = linkTypes(rules);
  return [
    `Папка «${r.folderTitle}»: название «${rules.title}»`,
    `разделы: ${rules.sections.length ? rules.sections.join(', ') : 'свободно'}`,
    `связь с карточкой: ${link.length ? `обязательна (${link.join(' или ')})` : 'не обязательна'}`,
    `дописывать — ${rules.levels.append === 'free' ? 'свободно' : 'с подтверждением'}, заменять — ${rules.levels.replace === 'free' ? 'свободно' : 'с подтверждением'}${rules.levels.locked_when_active ? ', после «Действует» — всё с подтверждением' : ''}`,
    'статус, переименование и откат — всегда с подтверждением человека',
  ].join('; ');
}

// ── регистрация ─────────────────────────────────────────────────────────────

const docRef = z.string().min(1).describe('uid документа или ссылка на него');
const userRequest = z.string().min(1).describe('просьба пользователя своими словами — попадёт в историю изменений');

export function registerDocTools(server: McpServer, deps: DocDeps): void {
  const run = (body: () => Promise<string>) => runTool(body, deps.describeError);

  server.registerTool(
    'list_docs',
    {
      title: 'Документы пространства',
      description: 'Дерево папок и страниц документов пространства: uid, и где агент может создавать страницы (по каким правилам).',
      inputSchema: { space_id: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    ({ space_id }) =>
      run(async () => {
        const space = (await deps.kaiten.listSpaces()).find((s) => s.id === space_id);
        if (!space?.uid) throw new Refusal('Пространство не найдено', ['id пространства — в list_boards']);
        const lines: string[] = [];
        const walk = async (uid: string, depth: number): Promise<void> => {
          if (depth > 6) return;
          for (const node of (await deps.kaiten.treeChildren(uid)).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))) {
            if (node.entity_type === 'document' && isRulesTitle(node.title)) continue;
            const pad = '  '.repeat(depth);
            if (node.entity_type === 'document_group') {
              const r = await rulesFor(deps, node.uid);
              lines.push(`${pad}📁 ${node.title} (${node.uid}) — ${'problem' in r ? 'только чтение' : rulesSummary(r)}`);
              if (node.has_children) await walk(node.uid, depth + 1);
            } else if (node.entity_type === 'document') {
              lines.push(`${pad}📄 ${node.title} (${node.uid})`);
              if (node.has_children) await walk(node.uid, depth + 1);
            }
          }
        };
        await walk(space.uid, 0);
        return lines.length ? lines.join('\n') : 'В пространстве нет документов.';
      }),
  );

  server.registerTool(
    'read_doc',
    {
      title: 'Прочитать документ',
      description: 'Страница целиком (markdown): шапка, разделы, история, — и что агенту с ней можно.',
      inputSchema: { doc: docRef },
      annotations: { readOnlyHint: true },
    },
    ({ doc }) =>
      run(async () => {
        const loaded = await loadDoc(deps, doc);
        const rendered = nodesToMarkdown(loaded.nodes);
        const lines = [`# ${loaded.doc.title}`, docUrl(deps.domain, loaded.doc.uid), ''];
        if ('problem' in loaded.rules) lines.push(`Агенту: только чтение — ${loaded.rules.problem}`);
        else if (!loaded.page.header && !HUMAN_PAGES_WRITABLE) lines.push('Агенту: только чтение — страницу написал человек в Kaiten.');
        else lines.push(`Агенту: ${rulesSummary(loaded.rules)}.`);
        if (rendered.lossy) lines.push('На странице есть элементы, которых нет в markdown (чек-листы, картинки…): разделы с ними можно только дописывать.');
        lines.push('', rendered.markdown);
        return lines.join('\n');
      }),
  );

  server.registerTool(
    'search_docs',
    {
      title: 'Найти документы',
      description: 'Документы по части названия.',
      inputSchema: { query: z.string().min(2) },
      annotations: { readOnlyHint: true },
    },
    ({ query }) =>
      run(async () => {
        const found = (await deps.kaiten.searchDocuments(query)).filter((d) => !isRulesTitle(d.title) && !d.archived);
        return found.length ? found.slice(0, 30).map((d) => `📄 ${d.title} (${d.uid})`).join('\n') : 'Ничего не найдено.';
      }),
  );

  server.registerTool(
    'create_doc',
    {
      title: 'Создать страницу',
      description:
        'Создаёт страницу в папке по её правилам: название по шаблону, все обязательные разделы по порядку и непустые, связь с карточкой, если папка её требует. ' +
        'Разделы — markdown без заголовков # и ##. Шапку и историю ведёт сервер. Отказ — исправь всё из списка или спроси пользователя.',
      inputSchema: {
        folder: z.string().min(1).describe('uid папки из list_docs'),
        title: z.string().min(1),
        sections: z.record(z.string(), z.string()).describe('{"Название раздела": "текст markdown"}'),
        links: z.array(cardRef).optional().describe('карточки, с которыми связана страница'),
        user_request: userRequest,
      },
    },
    (args) =>
      run(async () => {
        const folderUid = uidOf(args.folder);
        if (!folderUid) throw new Refusal('Не понял, какая папка', ['uid папки — в list_docs']);
        const resolved = await rulesFor(deps, folderUid);
        if ('problem' in resolved) throw new Refusal('В этой папке агент не создаёт страницы', [resolved.problem]);
        const { rules } = resolved;
        const problems: string[] = [];
        const title = args.title.trim();
        if (isRulesTitle(title)) problems.push('это название служебной страницы правил — выберите другое');
        const titleIssue = titleProblem(rules.title, title);
        if (titleIssue) problems.push(titleIssue);
        const siblings = await deps.kaiten.treeChildren(folderUid);
        const twin = siblings.find((n) => n.entity_type === 'document' && normalizeTitle(n.title) === normalizeTitle(title));
        if (twin) problems.push(`в папке уже есть «${twin.title}» — ${docUrl(deps.domain, twin.uid)}; дополните её или выберите другое название`);

        const given = new Map(Object.entries(args.sections).map(([name, text]) => [normalizeTitle(name), { name: name.trim(), text }]));
        const sections: Array<{ title: string; nodes: PMNode[] }> = [];
        for (const required of rules.sections) {
          const entry = given.get(normalizeTitle(required));
          if (!entry) problems.push(`нет раздела «${required}»`);
          else sections.push({ title: required, nodes: convertSection(required, entry.text, problems) });
          given.delete(normalizeTitle(required));
        }
        for (const { name, text } of given.values()) {
          if (normalizeTitle(name) === normalizeTitle(HISTORY)) problems.push('«История изменений» ведёт сервер — уберите этот раздел');
          else sections.push({ title: name, nodes: convertSection(name, text, problems) });
        }
        if (sections.length === 0) problems.push('страница без разделов — напишите хотя бы один');

        const links = await cardLinksFor(deps, args.links ?? [], rules, problems);
        if (problems.length > 0) throw new Refusal('Страницу не создать — исправьте', problems);

        const user = await me(deps);
        const page: Page = {
          header: { owner: user.name, status: 'Черновик', links: links.map((l) => l.link), updated: `${today()}, ${user.name}` },
          preamble: [],
          sections,
        };
        addHistory(page, `${today()} — ${user.name}: создана ИИ-агентом по просьбе «${args.user_request}»`);
        const content = renderPage(page);
        const created = await deps.kaiten.createDocument({ title, parent_entity_uid: folderUid, sort_order: siblings.length + 1 });
        try {
          const failed = await commitWrite(deps, { uid: created.uid, baseUpdated: undefined, content, cardLinks: links.map((l) => ({ cardId: l.cardId, title })) }, user.name);
          return `Страница создана: «${title}» — ${docUrl(deps.domain, created.uid)}${failed.length ? `\nНе получилось: ${failed.join(', ')}.` : ''}`;
        } catch (error) {
          throw new Refusal('Страница создана пустой — текст не записался', [
            `пустая страница: ${docUrl(deps.domain, created.uid)} — удалить её может только человек в Kaiten`,
            deps.describeError(error),
          ]);
        }
      }),
  );

  server.registerTool(
    'append_to_section',
    {
      title: 'Дописать в раздел',
      description: 'Дописывает markdown в конец раздела (нет раздела — создаёт его перед историей). По правилам папки — сразу или с подтверждением человека.',
      inputSchema: { doc: docRef, section: z.string().min(1), text: z.string().min(1), user_request: userRequest },
    },
    (args) =>
      run(async () => {
        const loaded = await loadDoc(deps, args.doc);
        const { rules } = requireWritable(loaded);
        if (normalizeTitle(args.section) === normalizeTitle(HISTORY)) throw new Refusal('«История изменений» ведёт сервер', ['выберите другой раздел']);
        const problems: string[] = [];
        const nodes = convertSection(args.section, args.text, problems);
        if (problems.length) throw new Refusal('Не дописать — исправьте', problems);
        const user = await me(deps);
        const page = parsePage(loaded.nodes);
        const section = findSection(page, args.section);
        if (section) {
          // Список, дописанный к списку, продолжает его, а не начинает второй.
          const last = section.nodes[section.nodes.length - 1];
          const [first, ...rest] = nodes;
          if (last && first && last.type === first.type && (first.type === 'bullet_list' || first.type === 'ordered_list')) {
            last.content = [...(last.content ?? []), ...(first.content ?? [])];
            section.nodes.push(...rest);
          } else section.nodes.push(...nodes);
        } else page.sections.push({ title: args.section.trim(), nodes });
        if (page.header) page.header.updated = `${today()}, ${user.name}`;
        addHistory(page, `${today()} — ${user.name}: дописан раздел «${args.section.trim()}» по просьбе «${args.user_request}»`);
        const level = levelFor('append', rules, loaded.page);
        return writeOrAsk(deps, level, loaded, { uid: loaded.doc.uid, baseUpdated: loaded.doc.updated, content: renderPage(page) }, `в «${loaded.doc.title}» дописан раздел «${args.section.trim()}»`, user);
      }),
  );

  server.registerTool(
    'replace_section',
    {
      title: 'Заменить раздел',
      description: 'Заменяет содержимое раздела целиком. Обычно — с подтверждением человека. Раздел с элементами, которых нет в markdown, заменять нельзя.',
      inputSchema: { doc: docRef, section: z.string().min(1), text: z.string().min(1), user_request: userRequest },
    },
    (args) =>
      run(async () => {
        const loaded = await loadDoc(deps, args.doc);
        const { rules } = requireWritable(loaded);
        const page = parsePage(loaded.nodes);
        const section = findSection(page, args.section);
        if (!section) throw new Refusal('Нет такого раздела', [`разделы: ${page.sections.map((s) => s.title).join(', ')}`]);
        if (normalizeTitle(section.title) === normalizeTitle(HISTORY)) throw new Refusal('«История изменений» ведёт сервер', ['её не заменить']);
        if (nodesToMarkdown(section.nodes).lossy) throw new Refusal('Раздел нельзя заменить целиком', ['в нём есть элементы, которых нет в markdown (чек-листы, картинки…) — их бы потеряли; можно только дописать (append_to_section)']);
        const problems: string[] = [];
        section.nodes = convertSection(section.title, args.text, problems);
        if (problems.length) throw new Refusal('Не заменить — исправьте', problems);
        const user = await me(deps);
        if (page.header) page.header.updated = `${today()}, ${user.name}`;
        addHistory(page, `${today()} — ${user.name}: заменён раздел «${section.title}» по просьбе «${args.user_request}»`);
        return writeOrAsk(deps, levelFor('replace', rules, loaded.page), loaded, { uid: loaded.doc.uid, baseUpdated: loaded.doc.updated, content: renderPage(page) }, `в «${loaded.doc.title}» заменён раздел «${section.title}»`, user);
      }),
  );

  server.registerTool(
    'set_doc_status',
    {
      title: 'Статус документа',
      description: `Меняет статус страницы (${STATUSES.join(' → ')}). Всегда с подтверждением человека.`,
      inputSchema: { doc: docRef, status: z.enum(STATUSES), user_request: userRequest },
    },
    (args) =>
      run(async () => {
        const loaded = await loadDoc(deps, args.doc);
        const { rules } = requireWritable(loaded);
        const page = parsePage(loaded.nodes);
        if (!page.header) throw new Refusal('У страницы нет шапки', ['статус ведётся только на страницах, созданных сервером']);
        if (page.header.status === args.status) return `Статус уже «${args.status}».`;
        const user = await me(deps);
        const from: Status = page.header.status;
        page.header.status = args.status;
        page.header.updated = `${today()}, ${user.name}`;
        addHistory(page, `${today()} — ${user.name}: статус «${from}» → «${args.status}» по просьбе «${args.user_request}»`);
        return writeOrAsk(deps, levelFor('status', rules, loaded.page), loaded, { uid: loaded.doc.uid, baseUpdated: loaded.doc.updated, content: renderPage(page) }, `статус «${loaded.doc.title}»: «${from}» → «${args.status}»`, user);
      }),
  );

  server.registerTool(
    'rename_doc',
    {
      title: 'Переименовать документ',
      description: 'Новое название по шаблону папки. С подтверждением человека.',
      inputSchema: { doc: docRef, title: z.string().min(1), user_request: userRequest },
    },
    (args) =>
      run(async () => {
        const loaded = await loadDoc(deps, args.doc);
        const { rules } = requireWritable(loaded);
        const title = args.title.trim();
        const problems: string[] = [];
        if (isRulesTitle(title)) problems.push('это название служебной страницы правил');
        const issue = titleProblem(rules.title, title);
        if (issue) problems.push(issue);
        if (problems.length) throw new Refusal('Не переименовать — исправьте', problems);
        const user = await me(deps);
        const page = parsePage(loaded.nodes);
        if (page.header) page.header.updated = `${today()}, ${user.name}`;
        addHistory(page, `${today()} — ${user.name}: переименована из «${loaded.doc.title}» по просьбе «${args.user_request}»`);
        return writeOrAsk(deps, levelFor('rename', rules, loaded.page), loaded, { uid: loaded.doc.uid, baseUpdated: loaded.doc.updated, content: renderPage(page), title }, `«${loaded.doc.title}» → «${title}»`, user);
      }),
  );

  server.registerTool(
    'link_doc',
    {
      title: 'Связать документ с карточкой',
      description: 'Добавляет карточку в «Связано с» шапки и ссылку на документ — в карточку. Снять связь может только человек.',
      inputSchema: { doc: docRef, card: cardRef, user_request: userRequest },
    },
    (args) =>
      run(async () => {
        const loaded = await loadDoc(deps, args.doc);
        const { rules } = requireWritable(loaded);
        const page = parsePage(loaded.nodes);
        if (!page.header) throw new Refusal('У страницы нет шапки', ['связи ведутся только на страницах, созданных сервером']);
        const problems: string[] = [];
        const [link] = await cardLinksFor(deps, [args.card], { ...rules, link: 'none' }, problems);
        if (!link || problems.length) throw new Refusal('Не связать', problems);
        if (page.header.links.some((l) => l.url === link.link.url)) return 'Уже связано.';
        const user = await me(deps);
        page.header.links.push(link.link);
        page.header.updated = `${today()}, ${user.name}`;
        addHistory(page, `${today()} — ${user.name}: связана с ${link.link.title} по просьбе «${args.user_request}»`);
        const plan: WritePlan = { uid: loaded.doc.uid, baseUpdated: loaded.doc.updated, content: renderPage(page), cardLinks: [{ cardId: link.cardId, title: loaded.doc.title }] };
        return writeOrAsk(deps, levelFor('link', rules, loaded.page), loaded, plan, `«${loaded.doc.title}» связан с ${link.link.title}`, user);
      }),
  );

  server.registerTool(
    'doc_versions',
    {
      title: 'Версии документа',
      description: 'Копии страницы, которые сервер снял перед правками (хранятся 30 дней).',
      inputSchema: { doc: docRef },
      annotations: { readOnlyHint: true },
    },
    ({ doc }) =>
      run(async () => {
        const loaded = await loadDoc(deps, doc); // доступ проверяет сам Kaiten токеном человека
        const keys = await deps.store.list(`snap:${loaded.doc.uid}:`);
        if (keys.length === 0) return 'Копий нет: агент эту страницу не менял (или копии старше 30 дней).';
        const lines: string[] = [];
        for (const key of keys.reverse()) {
          const snap = (await openData((await deps.store.get(key)) ?? '', deps.secret)) as Snapshot | null;
          if (snap) lines.push(`${key.split(':').pop()} — ${snap.savedAt.slice(0, 16).replace('T', ' ')}, перед правкой: ${snap.by}`);
        }
        return `Версии «${loaded.doc.title}» (для rollback_doc — первое число строки):\n${lines.join('\n')}`;
      }),
  );

  server.registerTool(
    'rollback_doc',
    {
      title: 'Откатить документ',
      description: 'Возвращает страницу к копии из doc_versions. Всегда с подтверждением человека: он увидит, чьи более поздние правки пропадут.',
      inputSchema: { doc: docRef, version: z.string().regex(/^\d+$/), user_request: userRequest },
    },
    (args) =>
      run(async () => {
        const loaded = await loadDoc(deps, args.doc);
        const { rules } = requireWritable(loaded);
        const sealed = await deps.store.get(`snap:${loaded.doc.uid}:${args.version.padStart(15, '0')}`);
        const snap = sealed ? ((await openData(sealed, deps.secret)) as Snapshot | null) : null;
        if (!snap) throw new Refusal('Нет такой версии', ['список — doc_versions']);
        const user = await me(deps);
        const page = parsePage(parseDocData(snap.data));
        if (page.header) page.header.updated = `${today()}, ${user.name}`;
        addHistory(page, `${today()} — ${user.name}: откат к версии от ${snap.savedAt.slice(0, 16).replace('T', ' ')} по просьбе «${args.user_request}»`);
        return writeOrAsk(
          deps,
          levelFor('rollback', rules, loaded.page),
          loaded,
          { uid: loaded.doc.uid, baseUpdated: loaded.doc.updated, content: renderPage(page), ...(snap.title !== loaded.doc.title ? { title: snap.title } : {}) },
          `«${loaded.doc.title}» откатывается к версии от ${snap.savedAt.slice(0, 16).replace('T', ' ')}`,
          user,
        );
      }),
  );
}
