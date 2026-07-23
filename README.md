# Editor Helper

Облегчённая десктопная программа (Electron) для установки плагинов, скриптов и
пресетов в Adobe After Effects. Это **lite-вариант**: в нём нет встроенного
редактора каталога — пользователи только устанавливают и обновляют плагины из
готового каталога. Список плагинов программа читает из `config/plugins.json`
(и/или с настроенного сервера). Каталог поддерживается вручную через файл или
сервер; для редактирования каталога в самом приложении используйте полный
вариант «Editor Helper Admin».

## Возможности

- Каталог из карточек с поиском и фильтром по типу (script / plugin / preset)
- Скачивание с **прямых ссылок** и с **Google Drive** (с обходом страницы
  подтверждения для больших файлов)
- Прогресс загрузки прямо на кнопке установки
- Автоопределение установленных версий After Effects (Program Files + AppData)
- Автоматическая установка в нужные папки:
  - `Scripts/ScriptUI Panels` → папка пользователя (без прав админа)
  - `Plug-ins` / `Presets` → Program Files (требуется запуск от администратора)
- Проверка статуса: «не установлено» / «установлено» / «доступно обновление»
- Тёмная тема, glassmorphism, плавные анимации
- Журнал (логи), тосты, обработка ошибок
- Кнопки открытия папок AE и `plugins.json`

## Запуск

### 1. Установить зависимости (один раз)
```bash
cd C:\Users\dekixh\Desktop\editor-helper-lite
npm install
```
> `npm install` скачивает бинарник Electron (~100 МБ). Нужен интернет.

### 2. Запустить
```bash
npm start
```
Для режима разработчика (с DevTools):
```bash
npm run dev
```

### Установка Plug-ins / Presets (важно)
Скрипты (`Scripts/ScriptUI Panels`) ставятся в папку пользователя — админ не нужен.
**Plug-ins и Presets** устанавливаются в `Program Files\Adobe\...` — запустите
программу **от имени администратора**, иначе будет ошибка записи. Это ограничение
ОС Windows, а не программы.

## Конфигурация `config/plugins.json`

```json
{
  "plugins": [
    {
      "id": "unique-id",
      "name": "Motion Tools Pro",
      "description": "Набор инструментов для анимации",
      "version": "1.2.0",
      "type": "script",
      "fileName": "MotionTools.jsx",
      "downloadUrl": "https://drive.google.com/file/d/FILE_ID/view?usp=sharing",
      "installPath": "Scripts/ScriptUI Panels",
      "icon": "",
      "author": "Motion Dev",
      "tags": ["animation"]
    }
  ]
}
```

### Поля
| Поле          | Обязательно | Описание |
|---------------|-------------|----------|
| `id`          | да          | Уникальный идентификатор |
| `name`        | да          | Отображаемое название |
| `description` | нет         | Описание на карточке |
| `version`     | нет         | Версия (для проверки обновлений) |
| `type`        | да          | `script` / `plugin` / `preset` |
| `fileName`    | да          | Имя файла после установки |
| `downloadUrl` | да          | Прямая ссылка или Google Drive |
| `installPath` | да          | Логический путь (см. ниже) |
| `icon`        | нет         | Зарезервировано |
| `author`      | нет         | Автор |
| `tags`        | нет         | Теги для поиска |

### Логические пути установки (`installPath`)
| `installPath`                  | Куда установится |
|--------------------------------|------------------|
| `Scripts/ScriptUI Panels`      | `%AppData%\Adobe\After Effects\<год>\Scripts\ScriptUI Panels` (без админа) |
| `Scripts`                      | `%AppData%\Adobe\After Effects\<год>\Scripts` |
| `Plug-ins`                     | `Program Files\Adobe\After Effects <год>\Support Files\Plug-ins` (админ) |
| `Plug-ins/DeepGlow`            | `…\Plug-ins\DeepGlow` (админ) |
| `Presets`                      | `…\Support Files\Presets` (админ) |

### Google Drive
Поддерживаются форматы ссылок:
- `https://drive.google.com/file/d/FILE_ID/view?usp=sharing`
- `https://drive.google.com/uc?id=FILE_ID`
- `https://drive.google.com/open?id=FILE_ID`

Файл должен быть **доступен для скачивания всем, у кого есть ссылка**
(Правый доступ → «Любой, у кого есть ссылка»). Для больших файлов программа
автоматически проходит страницу подтверждения Google.

## Архитектура

```
editor-helper-lite/
├── main.js                 # Electron main: окно, IPC, привилегированные операции
├── preload.js              # Безопасный мост window.api (contextIsolation)
├── config/
│   ├── plugins.json        # Каталог плагинов (источник истины)
│   └── installed.json      # Сохранённые статусы (создаётся автоматически)
├── core/
│   ├── config.js           # Загрузка и валидация каталога
│   ├── downloader.js       # Скачивание + поддержка Google Drive
│   ├── state.js            # Сохранение статусов установки
│   └── logger.js           # Логирование (файл + буфер для UI)
├── installer/
│   ├── aePaths.js          # Определение версий AE, разрешение путей
│   └── installer.js        # Пайплайн: resolve → download → install → verify
├── ui/
│   ├── index.html
│   ├── styles.css          # Тёмная тема, glassmorphism, анимации
│   └── renderer.js         # Логика UI (только через window.api)
└── logs/
    └── app.log             # Журнал (создаётся автоматически)
```

Разделение по слоям: `ui` (рендер) → `preload` (мост) → `main` → `core`/`installer`
(Node: диск и сеть). Рендерер изолирован и не имеет доступа к Node — только к
явному API в `preload.js`. Добавить новый тип установки или новый источник
скачивания можно, расширив `installer/aePaths.js` и `core/downloader.js` соответственно.