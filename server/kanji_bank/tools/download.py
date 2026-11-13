from pathlib import Path
from urllib.request import urlopen
from urllib.parse import quote
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json

root = Path(__file__).parent / 'raw'
root.mkdir(parents=True,exist_ok=True)
sources = {
    'JMdict_e.gz': 'https://raw.githubusercontent.com/kyoh86/kanken/main/data/raw/JMdict_e.gz',
    'kanjidic2.xml.gz': 'https://raw.githubusercontent.com/kyoh86/kanken/main/data/raw/kanjidic2.xml.gz',
    'levels.csv': 'https://raw.githubusercontent.com/mimneko/kanji-data/main/' + quote('漢検漢字辞典漢字.csv'),
    'joyo.json': 'https://raw.githubusercontent.com/mimneko/kanji-data/main/' + quote('常用漢字表本表.json'),
    'official-levels.pdf': 'https://www.kanken.or.jp/kanken/outline/data/outline_degree_national_list20200217.pdf',
    'cc0.txt': 'https://raw.githubusercontent.com/mimneko/kanji-data/main/LICENSE',
}
def get(item):
    name, url = item
    path = root / name
    if not path.exists():
        with urlopen(url, timeout=45) as response:
            path.write_bytes(response.read())
    return {'file': name, 'url': url, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size}
with ThreadPoolExecutor(max_workers=4) as pool:
    records = list(pool.map(get, sources.items()))
(root.parent / 'sources-downloaded.json').write_text(json.dumps(records, indent=2), encoding='utf-8')
print(json.dumps([{k:r[k] for k in ('file','bytes')} for r in records]))
