#!/usr/bin/env python3
# Зеркало релизов Franke для пользователей, у которых github.com заблокирован
# (SNI-фильтрация у провайдеров: браузеры с ECH проходят, апдейтер и curl — нет).
#
# Тянет ПОСЛЕДНИЙ релиз с GitHub (историю не храним — апдейтеру нужна только
# свежая версия, ~115 МБ на диске) и подменяет в latest.json ссылки на адрес
# зеркала. Папку отдаёт Caddy на /updates/* (см. Caddyfile).
#
# Запуск кроном на VPS: см. /etc/cron.d/franke-mirror. Стандартная библиотека,
# зависимостей нет. Настройка через env: MIRROR_DEST, MIRROR_BASE.
import json
import os
import pathlib
import shutil
import sys
import urllib.request

REPO = os.environ.get('MIRROR_REPO', 'Escape64/Franke')
BASE = os.environ.get('MIRROR_BASE', 'https://franke-relay.duckdns.org/updates')
DEST = pathlib.Path(os.environ.get('MIRROR_DEST', '/opt/franke/mirror'))

DEST.mkdir(parents=True, exist_ok=True)

rel = json.load(
    urllib.request.urlopen(f'https://api.github.com/repos/{REPO}/releases/latest', timeout=30)
)
tag = rel['tag_name']

marker = DEST / '.synced-tag'
if marker.exists() and marker.read_text().strip() == tag:
    sys.exit(0)  # уже актуально — молча выходим (кроновый запуск)

# Качаем во временную подпапку ВНУТРИ зеркала (тот же fs → атомарный rename;
# саму папку зеркала не переименовываем — на неё смотрит bind-mount докера).
tmp = DEST / '.tmp'
if tmp.exists():
    shutil.rmtree(tmp)
tmp.mkdir()

names = []
for asset in rel['assets']:
    name = asset['name']
    names.append(name)
    with urllib.request.urlopen(asset['browser_download_url'], timeout=600) as r:
        with open(tmp / name, 'wb') as f:
            shutil.copyfileobj(r, f)

lj = tmp / 'latest.json'
if lj.exists():
    data = json.loads(lj.read_text())
    for platform in data.get('platforms', {}).values():
        platform['url'] = f'{BASE}/' + platform['url'].rsplit('/', 1)[-1]
    lj.write_text(json.dumps(data, ensure_ascii=False, indent=2))

# Переносим файлы на место (rename в пределах fs), затем чистим устаревшие.
for name in names:
    (tmp / name).replace(DEST / name)
tmp.rmdir()
for f in DEST.iterdir():
    if f.name not in names and f.name != '.synced-tag' and f.is_file():
        f.unlink()
marker.write_text(tag + '\n')
print(f'зеркало обновлено до {tag}: {len(names)} файлов')
