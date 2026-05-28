# Netronic — Fullstack тестовое: план и архитектура

> Тон: я смотрю на это как ко-фаундер, который нанимает на синьорскую роль. Задача проста на вид и подло сложна на деле — почти всё, что отличает мидла от синьора, спрятано в трёх местах: модель данных, race conditions и индексы при 200M+ строк. Всё остальное (UI, CRUD, валидация) — гигиена. Если ты завалишь гигиену — отвал. Если не покажешь, что понимаешь эти три места — тоже отвал.

---

## 1. Что на самом деле просят (и где спрятаны грабли)

Тех. задание сформулировано аккуратно, но в нём четыре фразы, которые делают всю задачу:

1. **«Не более 5 сессий одновременно»** — это не COUNT(*), это интервальная аналитика. В любой момент времени по арене должно быть ≤ 5 пересекающихся интервалов.
2. **«Сессии могут касаться границами — это не пересечение»** — half-open интервалы `[start, end)`. Если ты используешь closed-closed `[start, end]` — ты проиграл на первом же кейсе из примера (11:00 одни кончаются, 11:00 другие начинаются).
3. **«Произвольное время начала, может пересекать полночь»** — не храни `date + time + duration`. Это distrastrous decision. Храни `tstzrange`/`timestamptz` пару.
4. **«1000 арен × 5 лет плотных бронирований»** — это ~150–250M строк. Без партиционирования и/или GiST индекса по `(arena_id, during)` ты упрёшься.

И ещё одна, между строк: **«race conditions»** — это не «оберни в транзакцию». Это «докажи, что 10 одновременных запросов на лимит-граничный слот дадут ровно 5 успехов и 5 отказов». Должен быть конкурентный тест в репозитории.

---

## 2. Стек

ТЗ фиксирует Node.js / React / GraphQL / PostgreSQL — это не обсуждаемо. Но внутри есть выбор, и тут я делаю жёсткие решения, а не «поставлю что популярно».

**Backend:**
- **TypeScript strict.** JS на синьорской позиции — красный флаг. `"strict": true`, `noUncheckedIndexedAccess: true`.
- **Fastify** как HTTP, не Express. Меньше middleware-хаоса, быстрее, нативная поддержка schema validation. Это не обязательно, но я бы взял.
- **GraphQL: Apollo Server 4 + Pothos (code-first schema builder).** Не SDL-first. Code-first даёт тайп-сейфти от схемы до резолверов без кодгена. Альтернатива — Mercurius, но он тащит за собой Fastify-специфику и хуже знаком ревьюеру.
- **БД-слой: Drizzle ORM или Kysely.** **НЕ Prisma.**
  - Prisma не умеет в `tstzrange`, не умеет в `EXCLUDE` constraints, не умеет в GiST индексы, не умеет в advisory locks без сырого SQL. Использовать Prisma на этой задаче — расписаться, что не понимаешь, зачем тебе вообще Postgres.
  - Drizzle — типизированный query builder, raw SQL когда надо, миграции в твоих руках.
- **Миграции: drizzle-kit или node-pg-migrate.** SQL-файлы под контролем версий, никаких «push-driven» миграций.
- **Валидация: Zod.** Один источник правды для input типов, переиспользуется на фронте.
- **Логи: pino** (structured JSON). Не console.log в продовом коде.
- **Тесты: Vitest + testcontainers-node** для интеграции с реальным Postgres. Юнит-тесты на оверлап-логику, интеграционные на race conditions.

**Frontend:**
- **Vite + React 19 + TypeScript.** CRA мёртв.
- **Apollo Client** для GraphQL — кэш из коробки, оптимистичные апдейты, нормализация. **Не tanstack-query** — у тебя GraphQL, используй то, что для него сделано.
- **React Hook Form + Zod resolver.** Не Formik (мёртв), не самопис.
- **shadcn/ui + Tailwind** для UI. Не Material UI (overkill, лежачий runtime), не самописные стили.
- **date-fns + date-fns-tz.** **НЕ moment.js** (deprecated, mutable). **НЕ dayjs** для production без серьёзной причины — date-fns честнее по таймзонам.

**Инфра для test task:**
- `docker-compose.yml` с Postgres 16, единая команда `make dev` или `pnpm dev`.
- Seed-скрипт, который через `COPY` (не INSERT) генерирует 1000 арен × 5 лет данных меньше чем за минуту.
- README с одной командой запуска и одной командой запуска тестов. Если ревьюер не сможет запустить за 2 минуты — он не запустит вообще.

---

## 3. Модель данных — самое важное решение

```sql
CREATE TABLE arenas (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          BIGSERIAL PRIMARY KEY,
  arena_id    BIGINT NOT NULL REFERENCES arenas(id),
  during      TSTZRANGE NOT NULL,           -- [start, end), half-open
  player_name TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- бизнес-правила на уровне БД, а не «надеюсь приложение проверит»
  CONSTRAINT during_not_empty CHECK (NOT isempty(during)),
  CONSTRAINT during_min_5min  CHECK (upper(during) - lower(during) >= interval '5 minutes'),
  CONSTRAINT during_max_24h   CHECK (upper(during) - lower(during) <= interval '24 hours'),
  CONSTRAINT during_bounds    CHECK (lower_inc(during) AND NOT upper_inc(during))
);

-- KILLER индекс. GiST поддерживает && (overlap) и фильтрацию по arena_id одновременно.
-- btree_gist расширение для смешивания типов в одном индексе.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE INDEX sessions_arena_during_gist ON sessions USING GIST (arena_id, during);

-- Для типичных запросов «сессии арены X за дату Y» этого достаточно.
-- Для дополнительной скорости — индекс на arena_id, lower(during)
CREATE INDEX sessions_arena_start ON sessions (arena_id, lower(during));
```

**Почему именно так:**

- `TSTZRANGE` с `[)` нотацией — кейс «11:00 кончилось / 11:00 началось» работает из коробки. Оператор `&&` (overlap) корректно возвращает false для соприкасающихся интервалов.
- `CHECK`-констрейнты в БД — потому что синьор не доверяет приложению. Если ты завтра напишешь ещё один скрипт миграции данных — БД не даст создать невалидную сессию.
- GiST по `(arena_id, during)` — единственный индекс, который реально ускоряет «найти пересекающиеся интервалы для арены X». Btree тут не помогает, потому что интервалы.

**Почему НЕ хранить `start_time` + `end_time` отдельно:** для overlap-запроса всё равно надо `WHERE NOT (end <= $start OR start >= $end)`, и индекс по этому работает плохо. Range type решает обе проблемы сразу.

**Партиционирование — нужно или нет?**
- 200M строк в одной таблице с GiST индексом — в принципе живо, но прицельно тяжело на VACUUM и при удалении старых данных.
- Для test task я бы НЕ делал партиционирование (overengineering для оценки), но в README в разделе «Production next steps» написал: «при росте — RANGE-партиционирование по `lower(during)` помесячно, плюс архивация партиций старше N лет в холодный стораж».
- Это покажет, что ты думаешь о масштабе, но не теряешь время.

---

## 4. Race conditions — главный технический челлендж

Это место, где отсеивают мидлов. Перечислю варианты честно, потом скажу, что брать.

**Вариант A — наивный (НЕ ДЕЛАТЬ):**
```
SELECT COUNT(*) WHERE arena_id = X AND during && new_range;  -- < 5?
INSERT INTO sessions ...;
```
Между SELECT и INSERT — окно для race condition. Два конкурентных запроса увидят count=4 и оба вставят. Лимит в 5 нарушен.

**Вариант B — `SELECT FOR UPDATE` на строке арены:**
Работает, но сериализует ВСЕ записи по арене в один поток. На горячих аренах — bottleneck. И требует, чтобы был «локкабельный» объект (строка арены).

**Вариант C — `SERIALIZABLE` isolation + retry:**
Postgres обнаружит конфликт через SSI и откатит одну из транзакций. Работает, но при высокой контенции — много откатов, нужен retry loop в приложении. Усложняет код мутаций.

**Вариант D — `pg_advisory_xact_lock(arena_id)`:**
Дешёвый advisory lock, держится до конца транзакции, сериализует только записи по конкретной арене. Это мой выбор.

**Вариант E — EXCLUDE constraint с «номером слота»:**
Элегантно. Добавляешь колонку `slot_index INT CHECK (slot_index BETWEEN 1 AND 5)`, и `EXCLUDE USING GIST (arena_id WITH =, slot_index WITH =, during WITH &&)`. БД сама гарантирует, что в одном слоте нет пересечений. На вставке алгоритм: найти первый свободный `slot_index` в нужном времени, попробовать INSERT, при `unique_violation`/`exclusion_violation` — попробовать следующий слот. После 5 неудач — отказ.

**Что я бы выбрал и почему:**

Для **этого теста** — **Вариант D (advisory lock)**. Простой, очевидный, легко объяснить в README, легко тестировать. Код мутации:

```typescript
await db.transaction(async (tx) => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'arena:' + arenaId}))`);

  const overlapCount = await tx.execute(sql`
    SELECT COUNT(*)::int AS c FROM sessions
    WHERE arena_id = ${arenaId}
      AND status = 'active'
      AND during && tstzrange(${start}, ${end}, '[)')
  `);

  if (overlapCount[0].c >= 5) throw new SlotFullError();

  await tx.insert(sessions).values({ arenaId, during: ... });
});
```

В README добавляю секцию **«Альтернативы и почему я выбрал advisory lock»** — там описываю Варианты C и E. Это сигнал ревьюеру: «я знаю про SSI, я знаю про EXCLUDE constraints, я сделал осознанный выбор».

**Конкурентный тест — обязательно:**
```typescript
it('does not allow more than 5 sessions under concurrent load', async () => {
  const tries = Array.from({ length: 20 }, () => createSession({...same slot...}));
  const results = await Promise.allSettled(tries);
  const ok = results.filter(r => r.status === 'fulfilled').length;
  expect(ok).toBe(5);
});
```
Этот тест — пожалуй, самый важный артефакт в репозитории. Без него ревьюеру нечем верить твоим словам про race conditions.

---

## 5. GraphQL дизайн

**Schema (Pothos, code-first, но привожу как SDL для читаемости):**

```graphql
type Arena {
  id: ID!
  name: String!
  sessions(from: DateTime!, to: DateTime!): [Session!]!  # DataLoader
}

type Session {
  id: ID!
  arena: Arena!
  startTime: DateTime!
  endTime: DateTime!
  playerName: String
  status: SessionStatus!
}

type Query {
  arenas(limit: Int = 50, offset: Int = 0): [Arena!]!
  arena(id: ID!): Arena
  sessionsByArena(arenaId: ID!, from: DateTime!, to: DateTime!): [Session!]!
  checkAvailability(arenaId: ID!, startTime: DateTime!, durationMinutes: Int!): AvailabilityResult!
  suggestSlots(arenaId: ID!, preferredStart: DateTime!, durationMinutes: Int!, withinDays: Int = 14): [Slot!]!
}

type Mutation {
  createSession(input: CreateSessionInput!): CreateSessionResult!
  updateSession(id: ID!, input: UpdateSessionInput!): UpdateSessionResult!
  deleteSession(id: ID!): DeleteSessionResult!
}

# Discriminated unions для ошибок — НЕ throw exceptions.
union CreateSessionResult = SessionCreated | SlotUnavailable | ValidationFailed
type SessionCreated { session: Session! }
type SlotUnavailable { conflictingCount: Int!  nearestSlots: [Slot!]! }
type ValidationFailed { issues: [ValidationIssue!]! }
```

**Что тут синьорского:**
- **Union types для результатов мутаций** вместо exceptions. Это паттерн от Shopify/GitHub GraphQL. Клиент явно обрабатывает каждый кейс — никаких `errors[0].extensions.code === 'SLOT_FULL'` хаков.
- **DataLoader для `arena.sessions`** — иначе N+1 на списке арен. Если этого нет — синьор-балл минус.
- **Никаких подписок (Subscriptions)**. ТЗ их не требует. Соблазн добавить «потому что круто» — слабая идея. YAGNI.
- **Никаких связей с auth/users.** Не в ТЗ. В README одной строкой: «auth не реализован — за рамками ТЗ, в production добавил бы X».

**Что НЕ делать:**
- ❌ Не возвращать `Session` напрямую из мутаций без union — теряется обработка ошибок.
- ❌ Не делать `error: String` поле в payload-типе — это анти-паттерн.
- ❌ Не делать `availability: Boolean` — это слишком тонкая инфа, верни структуру со счётчиком и предложениями.

---

## 6. Опциональная задача — suggest slots (14 дней)

Заманчиво нагородить дерево интервалов. **Не надо.** Решение в одном SQL:

1. Берём все сессии арены в окне `[preferredStart, preferredStart + 14d]`.
2. Превращаем в event stream: `(start, +1), (end, -1)`, сортируем.
3. Sweep line: проходим, считаем активные интервалы. Между событиями, где `active < 5`, есть «свободное окно». Из окон фильтруем те, где `width >= duration`.
4. Возвращаем 5 ближайших к `preferredStart`.

Это **O(N log N)** где N = сессий за 14 дней, реально ~5K записей в worst case. Делается на бэке за десятки миллисекунд. На стороне Postgres можно даже одним рекурсивным CTE — но проще и читаемее в Node.

В README — отдельная секция «Slot suggestion algorithm» с диаграммой sweep line. Это копеечная работа, которая показывает CS-фундамент.

---

## 7. Frontend — где не нужно умничать

UI — это гигиена. Если ты тут пытаешься впечатлить — теряешь время.

**Структура:**
- Левая колонка: список арен (виртуализированный, потому что 1000 — `react-window` или `tanstack-virtual`).
- Правая колонка: timeline view выбранной арены на выбранный день (24 строки по часам, сессии — блоки). Простой CSS grid, никакого React DnD.
- Кнопка «New session» → модал с формой (React Hook Form + Zod).
- Inline-edit на блоке сессии → тот же модал, prefilled.
- Удаление с оптимистическим апдейтом и rollback на ошибке.

**Что обязательно показать:**
- **Понятные ошибки.** Не «Error: validation failed», а «Слот занят: в это время уже 5 активных сессий. Ближайшие свободные: 12:30, 13:45, 15:00…» (с кнопкой «Подставить»).
- **Loading states** — skeleton, не spinner на весь экран.
- **Empty states.**
- **Адаптив на десктоп достаточен.** Мобайл — не в ТЗ. Не теряй на нём день.

**Что НЕ делать:**
- ❌ Календарь FullCalendar.io / react-big-calendar. Тащить 200KB зависимости ради одной timeline view — слабое решение. Самописная timeline на CSS grid — 50 строк.
- ❌ Redux. Apollo cache + URL state (search params для выбранной арены/даты) хватит.
- ❌ Темы / dark mode / i18n. Не в ТЗ.

---

## 8. Что я НЕ буду делать (push back на собственные соблазны и на потенциальные «улучшения»)

| Соблазн | Решение | Почему |
|---|---|---|
| Микросервисы | Монорепо, один backend | На тесте отвлекает от сути |
| Redis для кэша/локов | Только Postgres | Лишний компонент, advisory lock делает то же |
| Event sourcing для сессий | Нет | Overkill |
| Подписки на изменения | Нет | Не в ТЗ |
| Auth | Нет, упомянуть в README | Не в ТЗ |
| Soft delete | Нет, есть status | `status: 'cancelled'` решает то же |
| Прайс / биллинг / игроки | Нет, только `player_name TEXT?` | Не в ТЗ |
| Календарная либа | Самописная timeline | Меньше weight, больше контроля |
| OpenAPI / REST | Нет, только GraphQL | ТЗ явно требует GraphQL |
| K8s / CI/CD | Только docker-compose | Не в ТЗ |
| Storybook | Нет | Не в ТЗ, теряет день |

---

## 9. План по дням (4 рабочих дня)

**День 1 — фундамент:**
- Repo, docker-compose (Postgres 16), TS workspace, drizzle, GraphQL bootstrap.
- Schema + миграция + GiST индекс.
- Seed-скрипт через COPY, 1000 арен × 5 лет, < 60 сек.
- Юнит-тесты на overlap-логику.

**День 2 — backend и race conditions:**
- GraphQL queries / mutations с Pothos.
- Advisory lock, валидация, union error types.
- Конкурентный интеграционный тест (testcontainers).
- DataLoader для arena.sessions.

**День 3 — frontend:**
- Vite + Apollo Client + RHF + Tailwind + shadcn.
- Список арен (виртуализирован), timeline view.
- Create / edit / delete с оптимистикой.
- Inline error rendering.

**День 4 — опциональное + полировка:**
- Suggest slots (sweep line + UI «подставить ближайший»).
- README с архитектурными решениями.
- EXPLAIN ANALYZE прогоны типовых запросов, скриншоты в README.
- Финальный pass по edge cases (пересечение полуночи, 5-минутка, 24 часа, удалённая сессия).

---

## 10. README — половина оценки

Серьёзно. Синьорский README — это не «как запустить». Это design doc. Структура:

1. **Quickstart** — одна команда, всё работает.
2. **Architecture overview** — диаграмма, 3 абзаца.
3. **Data model** — почему `tstzrange`, почему `[)`, почему GiST.
4. **Concurrency** — почему advisory lock, какие альтернативы рассмотрел и отверг.
5. **Performance** — какие индексы, какие EXPLAIN-ы, где боттлнеки при росте.
6. **Tradeoffs and what I'd do in production** — партиционирование, архивация, мониторинг, авторизация, rate limiting.
7. **Tests** — что и как покрыто.

Если ревьюер откроет README и за 5 минут поймёт, как ты думаешь — оффер. Если откроет код и будет искать в нём ответы на «почему так» — нет.

---

## 11. Главные сигналы для ревьюера (чеклист)

Пройдись по нему перед отправкой:

- [ ] `tstzrange` с `[)`, не отдельные start/end.
- [ ] GiST индекс по `(arena_id, during)` + extension `btree_gist`.
- [ ] CHECK-констрейнты на минимум/максимум длительность в БД.
- [ ] `pg_advisory_xact_lock` (или эквивалент) внутри транзакции на запись.
- [ ] **Конкурентный тест**, который ловит race conditions.
- [ ] Union-типы для результатов мутаций.
- [ ] DataLoader.
- [ ] EXPLAIN ANALYZE на типовом запросе (в README).
- [ ] Seed через COPY, не INSERT.
- [ ] Половина типовых ошибок — проверена и показана в UI с понятным текстом.
- [ ] README объясняет «почему», не только «как».

Если все галочки стоят — это синьорский тест.
