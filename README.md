# hijama-no1-bot

Telegram-бот для автоматизации записи и предоплаты в клинике **«Хиджама №1»** (Иркутск).

## Документы

- [PROJECT_IDEA.md](./PROJECT_IDEA.md) — продуктовая идея и контекст.
- [SPECIFICATION.md](./SPECIFICATION.md) — техническая спецификация MVP.

Разработка по **Spec-First**: сначала спецификация, затем код.

## Требования

- Node.js **20+**
- Проект в [Supabase](https://supabase.com) и применённые миграции из `supabase/migrations/`
- Бот в [@BotFather](https://t.me/BotFather), магазин в [ЮKassa](https://yookassa.ru/)

## Установка и запуск

1. Скопируйте `.env.example` в `.env` и заполните переменные (секреты не коммитить).

2. В Supabase (SQL Editor): выполните миграции **по порядку** из `supabase/migrations/`:
   - `20260404120000_initial.sql` — **целиком** (не только `slots`).
   - `20260405140000_add_yookassa_confirmation_url.sql` (ссылка на оплату для повтора в `/start`)

   Если в редакторе вы уже успели создать только таблицу `slots`, выполните остаток схемы из **[`supabase/manual/continue_schema_after_slots.sql`](./supabase/manual/continue_schema_after_slots.sql)**, затем миграцию с `yookassa_confirmation_url`.

3. В личном кабинете ЮKassa укажите URL уведомлений:  
   `https://<ваш-домен>/webhooks/yookassa`  
   с тем же логином/паролем, что в `YOOKASSA_WEBHOOK_USER` / `YOOKASSA_WEBHOOK_PASSWORD`.

4. Локально (long polling + HTTP для ЮKassa через туннель вроде ngrok):

```bash
npm install
# TELEGRAM_USE_POLLING=true, PUBLIC_BASE_URL=https://....ngrok-free.app
npm run dev
```

5. **Amvera:** в корне [`amvera.yml`](./amvera.yml) — сборка `npm run build`, запуск **`npm run start`** (папка `dist/` появляется после сборки и не хранится в Git). Порт **3000**. Переменные — как в `.env`; **`PUBLIC_BASE_URL`** = внешний **https**-домен из раздела «Домены», не внутренний slug. Документация: [Node.JS Server (Amvera)](https://docs.amvera.ru/applications/environments/nodejs-server.html).

6. Другой хостинг: `npm run build`, `npm start`, переменная `PORT` — как задаёт платформа.  
   Для webhook Telegram и ЮKassa укажите `PUBLIC_BASE_URL` (https без слэша в конце), **не** включайте `TELEGRAM_USE_POLLING` (или `false`).

## HTTP-маршруты

| Метод | Путь | Назначение |
|--------|------|------------|
| GET | `/health` | Проверка живости |
| POST | `/webhooks/yookassa` | Уведомления ЮKassa |
| POST | `/webhooks/telegram` | Обновления Telegram (только в режиме webhook) |

## Админ в Telegram

Команды доступны только пользователю с `telegram_user_id = ADMIN_TELEGRAM_ID`. Список: `/admin`.

## GitHub → Amvera

### 1. Репозиторий на GitHub

1. Установите [Git for Windows](https://git-scm.com/download/win), при установке оставьте опцию **Add Git to PATH**. Перезапустите терминал.
2. На [github.com](https://github.com) создайте **новый репозиторий** (например `hijama-no1-bot`), **без** README/License/gitignore (пустой).
3. В папке проекта на ПК:

```bash
cd c:\hijama-no1-bot
git init
git branch -M main
git add .
git status
```

Убедитесь, что в списке **нет** файла `.env` (он в `.gitignore`). Если `.env` попал в `git add` — отмените: `git reset HEAD .env` и не коммитьте секреты.

```bash
git commit -m "Initial commit: hijama-no1-bot MVP"
git remote add origin https://github.com/ВАШ_ЛОГИН/hijama-no1-bot.git
git push -u origin main
```

Авторизация: [Personal Access Token](https://github.com/settings/tokens) (classic) с правом `repo`, вместо пароля при `git push`.

### 2. Проект на Amvera

1. В [консоли Amvera](https://console.amvera.ru) создайте приложение типа **Node.JS Server** из **Git**-репозитория, укажите URL репозитория и ветку `main`.
2. В корне уже лежит [`amvera.yml`](./amvera.yml): сборка `npm run build`, запуск `dist/index.js`, порт контейнера **3000**.
3. В разделе **переменных окружения** Amvera добавьте **все** ключи из вашего локального `.env` (как в [`.env.example`](./.env.example)), значения — боевые/тестовые под прод.

   **Обязательно для продакшена на Amvera:**

   - `PUBLIC_BASE_URL` — публичный **https**-URL вашего приложения на Amvera **без** слэша в конце (тот, по которому открывается сервис).
   - **Не** задавайте `TELEGRAM_USE_POLLING=true` (или явно `false`), чтобы бот работал через **webhook** Telegram на `…/webhooks/telegram`.
   - `PORT`: если Amvera подставляет свой порт — оставьте как настроит платформа; при необходимости укажите вручную тот же, что в маршрутизации на контейнер (часто совпадает с **3000** из `amvera.yml`).

4. Сохраните переменные и **пересоберите/задеплойте** приложение.

### 3. После деплоя

1. Проверка: откройте в браузере `https://ВАШ-ДОМЕН/health` — ответ `{"ok":true}`.
2. В [личном кабинете ЮKassa](https://yookassa.ru) укажите URL уведомлений:  
   `https://ВАШ-ДОМЕН/webhooks/yookassa`  
   и Basic Auth как в `YOOKASSA_WEBHOOK_USER` / `YOOKASSA_WEBHOOK_PASSWORD`.
3. В Telegram бот должен отвечать на `/start` (обновления идут на webhook, который подставляет приложение).

## Лицензия

Уточнить у владельца репозитория перед публикацией.
