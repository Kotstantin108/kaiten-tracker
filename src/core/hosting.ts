/**
 * Хостинг репозитория: GitHub или GitLab. Хостинг — свойство репозитория, а
 * не проекта: задачи могут лежать на одном, код — на другом.
 *
 * От хостинга зависят три вещи: вид ссылки на файл (в карточках Kaiten),
 * совет, как git войти на сервер (сообщения об отказе), и слова правила про
 * ветку (PR или merge request). Всё остальное — обычный git.
 *
 * `github.com` и `gitlab.com` узнаются по адресу. Свой сервер по адресу не
 * узнать — его хостинг называет владелец: `tasksRepo.hosting` в `kaiten.json`
 * для репозитория задач, `--hosting` у `connect-repo` для репозитория кода.
 * Узнанный по адресу хостинг сильнее названного.
 */

export const HOSTINGS = ['github', 'gitlab'] as const;
export type Hosting = (typeof HOSTINGS)[number];

export const HOSTING_TITLE: Record<Hosting, string> = { github: 'GitHub', gitlab: 'GitLab' };

const KNOWN_HOSTS: Readonly<Record<string, Hosting>> = { 'github.com': 'github', 'gitlab.com': 'gitlab' };

export interface RepoAddress {
  /** Домен без порта, строчными: `gitlab.example.com`. */
  host: string;
  /** Адрес сайта: `https://gitlab.example.com`. Порт — только из адреса HTTP(S): порт SSH сайту чужой. */
  origin: string;
  /** Путь репозитория без `.git`: `group/sub/repo`. */
  path: string;
}

/**
 * Адрес репозитория на сервере → домен и путь. Понимает
 * `git@host:group/repo.git`, `https://host/group/repo(.git)` и
 * `ssh://git@host:2222/group/repo.git`; путь — любой глубины (вложенные
 * группы GitLab). Локальный путь — `null`: у него нет ни домена, ни ссылок.
 */
export function parseRepoAddress(url: string | undefined): RepoAddress | null {
  const value = url?.trim();
  if (!value) return null;
  const clean = (path: string): string => path.replace(/\/+$/, '').replace(/\.git$/, '');
  const web = /^(https?):\/\/(?:[^@/]+@)?([^/:]+)(:\d+)?\/(.+)$/i.exec(value);
  if (web) {
    const host = web[2].toLowerCase();
    return { host, origin: `${web[1].toLowerCase()}://${host}${web[3] ?? ''}`, path: clean(web[4]) };
  }
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(value);
  if (ssh) return { host: ssh[1].toLowerCase(), origin: `https://${ssh[1].toLowerCase()}`, path: clean(ssh[2]) };
  // `git@host:путь`. Без `user@` не берём: `C:/tmp/tasks.git` — папка на диске, а не сервер «C».
  const scp = /^[^@/\s]+@([^/:\s]+):\/?(.+)$/.exec(value);
  if (scp) return { host: scp[1].toLowerCase(), origin: `https://${scp[1].toLowerCase()}`, path: clean(scp[2]) };
  return null;
}

/** Хостинг репозитория: по домену, а для своего сервера — названный владельцем. */
export function hostingOf(address: RepoAddress, declared?: Hosting): Hosting | null {
  return KNOWN_HOSTS[address.host] ?? declared ?? null;
}

/**
 * Домен, хостинг которого не узнать: адрес на сервере, домен незнакомый, а
 * владелец хостинг не назвал. Локальный путь и пустой адрес — не тот случай:
 * там ссылок нет вовсе.
 */
export function unknownHost(url: string | undefined, declared?: Hosting): string | null {
  const address = parseRepoAddress(url);
  return address && !hostingOf(address, declared) ? address.host : null;
}

/**
 * Что исправить владельцу, если хостинг репозитория задач не узнать; `null` —
 * всё в порядке. Молчать нельзя: без хостинга карточки остаются без ссылок на
 * задачи и журнал, а заметят это уже в Kaiten.
 */
export function hostingProblem(repo: RepoWhere | undefined): string | null {
  const host = unknownHost(repo?.url, repo?.hosting);
  return host ? `Репозиторий задач лежит на ${host} — по адресу не понять, GitHub это или GitLab. Укажите в kaiten.json: "tasksRepo": { …, "hosting": "${HOSTINGS.join('" | "')}" }` : null;
}

/**
 * База ссылок на файлы репозитория: ссылка — `<база>/blob/<ветка>/<путь>`.
 * У GitHub это адрес репозитория на сайте (`https://github.com/org/repo`), у
 * GitLab — он же с `/-`: файл там открывается по `…/repo/-/blob/…`.
 *
 * `null` — ссылок не будет: локальный путь, адрес без владельца (`host/repo`)
 * или домен, хостинг которого неизвестен (`unknownHost`).
 *
 * База входит в хеш «что получила карточка»: для адресов GitHub она должна
 * оставаться прежней буква в букву, иначе карточки перерисуются.
 */
export function repoWebBase(url: string | undefined, declared?: Hosting): string | null {
  const address = parseRepoAddress(url);
  if (!address || !address.path.includes('/')) return null;
  const hosting = hostingOf(address, declared);
  if (!hosting) return null;
  const repo = `${address.origin}/${address.path}`;
  return hosting === 'gitlab' ? `${repo}/-` : repo;
}

/** Где лежит репозиторий — для сообщений об отказе: адрес и хостинг, если владелец его назвал. */
export interface RepoWhere {
  url?: string;
  hosting?: Hosting;
}

/** Домен в сообщении нужен там, где его не угадать: у GitHub на github.com он и так в названии. */
function hostNote(hosting: Hosting, host: string): string {
  return hosting === 'github' && host === 'github.com' ? '' : ` (${host})`;
}

/**
 * Сервер не пускает к репозиторию задач: человека нет в проекте. Что просить
 * у владельца — словами хостинга. Называем только домен: путь репозитория —
 * не дело сообщений `kaiten`.
 */
export function noAccessMessage(where: RepoWhere = {}): string {
  const address = parseRepoAddress(where.url);
  const hosting = address ? hostingOf(address, where.hosting) : null;
  const ask = !address
    ? 'дать вам доступ к задачам'
    : hosting === 'github'
      ? `добавить вас в команду проекта на GitHub${hostNote(hosting, address.host)}`
      : hosting === 'gitlab'
        ? `добавить вас в проект на GitLab${hostNote(hosting, address.host)}`
        : `дать вам доступ к задачам на ${address.host}`;
  return `Нет доступа к задачам проекта. Попросите владельца проекта ${ask}.`;
}

/**
 * Git на машине не вошёл на сервер: нет логина для HTTPS или ключа для SSH.
 * Совет — командой хостинга и с настоящим доменом: на своём сервере
 * `gh auth login` без домена вошёл бы не туда.
 */
export function noLoginMessage(where: RepoWhere = {}): string {
  const address = parseRepoAddress(where.url);
  const cause = 'для адреса задач нет логина или ключа. Это настройка машины, а не доступ к проекту.';
  if (!address) return `Git на этой машине не может войти в хранилище задач: ${cause} Настройте вход git (логин и токен доступа или SSH-ключ) и повторите команду.`;
  const { host, origin } = address;
  const redirect = `если у вас настроен SSH-ключ, перенаправьте HTTPS на SSH: git config --global url."git@${host}:".insteadOf "${origin}/". Затем повторите команду.`;
  const hosting = hostingOf(address, where.hosting);
  if (!hosting) return `Git на этой машине не может войти на ${host}: ${cause} Настройте вход для HTTPS (логин и токен доступа) или, ${redirect}`;
  const title = HOSTING_TITLE[hosting];
  const hostname = host === 'github.com' || host === 'gitlab.com' ? '' : ` --hostname ${host}`;
  const login = hosting === 'github' ? `например, gh auth login${hostname}` : `например, glab auth login${hostname}; подойдёт и токен доступа вместо пароля`;
  return `Git на этой машине не может войти в ${title}${hostNote(hosting, host)}: ${cause} Войдите в ${title} для HTTPS (${login}) или, ${redirect}`;
}
