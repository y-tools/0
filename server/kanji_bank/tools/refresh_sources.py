from urllib.request import urlopen
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import gzip, hashlib, json
root=Path(__file__).parent
def get(name):
    url='http://ftp.edrdg.org/pub/Nihongo/'+name
    try:
        with urlopen(url,timeout=25) as response:content=response.read()
        gzip.decompress(content)
        (root/'raw'/name).write_bytes(content)
        return name,url,content
    except Exception as error:
        print(name,'primary download unavailable:',type(error).__name__)
        return None
with ThreadPoolExecutor(max_workers=2) as pool:result=list(pool.map(get,['JMdict_e.gz','kanjidic2.xml.gz']))
records=json.loads((root/'sources-downloaded.json').read_text())
for item in result:
    if item:
        name,url,content=item
        for record in records:
            if record['file']==name:record.update(url=url,sha256=hashlib.sha256(content).hexdigest(),bytes=len(content))
        print(name,'updated from EDRDG')
(root/'sources-downloaded.json').write_text(json.dumps(records,indent=2),encoding='utf-8')
