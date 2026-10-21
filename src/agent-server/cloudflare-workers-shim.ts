/**
 * `cloudflare:workers` вне Workers (свой сервер, тесты): библиотека OAuth
 * берёт оттуда только класс для проверки `instanceof` — наши обработчики —
 * обычные объекты, так что хватает пустого класса.
 */
export class WorkerEntrypoint {}
