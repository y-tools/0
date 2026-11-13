"""Reproducible dictionary-backed reading bank; never invent readings or level labels."""
import csv, gzip, hashlib, json, os, re, sys, unicodedata
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET
sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).parent
RAW=ROOT/'raw'
OUT=Path(os.getenv('KANJI_BANK_OUTPUT', str(ROOT.parent/'quiz/server/kanji_bank')))
ORDER=['10級','9級','8級','7級','6級','5級','4級','3級','準2級','2級','準1級','1級']
TARGETS={'5':5,'4':6,'3':7,'2':9,'pre1':10,'1':11}
def hira(value):
    return ''.join(chr(ord(c)-96) if 'ァ'<=c<='ヶ' else c for c in unicodedata.normalize('NFKC',value))
rows=list(csv.DictReader((RAW/'levels.csv').open(encoding='utf-8-sig')))
levels={r['漢字テキスト']:ORDER.index(r['漢検級']) for r in rows if r['字体']=='親字' and r['漢検級'] in ORDER and len(r['漢字テキスト'])==1}
joyo=json.loads((RAW/'joyo.json').read_text(encoding='utf-8'))
standard={item['漢字']['通用字体'] for item in joyo}
aliases={'叱':'𠮟','頬':'頰','剥':'剝','填':'塡'}
assert set(aliases.values()) <= standard
# Cross-check two independently maintained machine-readable allocations.
extra=json.loads((ROOT/'reference_levels.json').read_text(encoding='utf-8'))
for level,characters in extra.items():
    expected={aliases.get(c,c) for c in characters}
    label={'pre2':'準2級'}.get(level,level+'級')
    actual={char for char,rank in levels.items() if ORDER[rank]==label}
    if expected!=actual:print('Allocation difference',label,'reference only',expected-actual,'mapping only',actual-expected)
    assert expected==actual, 'Allocation mismatch '+label
readings={item['漢字']['通用字体']:{hira(r['読み']) for r in item['音訓']} for item in joyo}
for _,e in ET.iterparse(gzip.open(RAW/'kanjidic2.xml.gz','rb'),events=('end',)):
    if e.tag!='character':continue
    char=e.findtext('literal')
    if char not in readings:
        readings[char]={hira(r.text.split('.')[0]).replace('-','') for r in e.findall('reading_meaning/rmgroup/reading') if r.attrib.get('r_type') in ('ja_on','ja_kun') and r.text}
    e.clear()
def match_reading(word, reading):
    positions={0}
    for char in word:
        possible=set(readings.get(char,()))
        for sound in list(possible):
            if sound and sound[0] in 'かきくけこさしすせそたちつてとはひふへほ':
                possible.add(unicodedata.normalize('NFC',sound[0]+'\u3099')+sound[1:])
            if sound.endswith(('く','き','つ','ち')):
                possible.add(sound[:-1]+'っ')
        positions={pos+len(sound) for pos in positions for sound in possible if sound and reading.startswith(sound,pos)}
        if not positions:return False
    return len(reading) in positions
candidates=json.loads((ROOT/'candidates.json').read_text(encoding='utf-8'))
accepted=[r for r in candidates if match_reading(r['word'],r['reading'])]
print('After character-reading cross-check:',Counter(ORDER[r['level']] for r in accepted))
if '--probe' in sys.argv:raise SystemExit()
OUT.mkdir(exist_ok=True)
files=[]
all_words=set()
for code,rank in TARGETS.items():
    pool=[r for r in accepted if r['level']==rank]
    pool.sort(key=lambda r:(not r['preferred'],not r['common'],len(r['word']),hashlib.sha256(('kanji-v1:'+r['word']).encode()).hexdigest()))
    assert len(pool)>=2000,(code,len(pool))
    chosen=pool[:2000]
    assert not (all_words & {r['word'] for r in chosen})
    all_words.update(r['word'] for r in chosen)
    for part in range(4):
        name=f'level-{code}-{part+1}.json'
        records=[[r['word'],r['reading'],r['id']] for r in chosen[part*500:(part+1)*500]]
        content=json.dumps(records,ensure_ascii=False,separators=(',',':'))+'\n'
        (OUT/name).write_bytes(content.encode('utf-8'))
        files.append({'file':name,'level':code,'count':len(records),'sha256':hashlib.sha256(content.encode()).hexdigest()})
    print(code, 'selected 2000', 'common',sum(r['common'] for r in chosen), 'sample',[(r['word'],r['reading']) for r in chosen[:12]])
dictionary_date=re.search(r'JMdict created: ([0-9-]+)',gzip.open(RAW/'JMdict_e.gz','rt',encoding='utf-8').read(50000)).group(1)
release=dictionary_date+'-'+hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest()[:10]
manifest={'version':release,'dictionaryDate':dictionary_date,'total':12000,'perLevel':2000,'files':files,
 'license':'CC BY-SA 4.0','licenseUrl':'https://creativecommons.org/licenses/by-sa/4.0/',
 'attribution':'Reading data: JMdict and KANJIDIC2, Electronic Dictionary Research and Development Group (EDRDG). Character-level mapping: mimneko/kanji-data (CC0). Selection and validation are adaptations by Y++STADIO.',
 'sources':json.loads((ROOT/'sources-downloaded.json').read_text(encoding='utf-8')),
 'classification':'Independent reading exercises classified by the highest allocated character level; not official exam questions or official vocabulary difficulty ratings.',
 'validation':['Single unambiguous JMdict reading per written form; reading/spelling restrictions honored','Rare/obsolete/irregular spellings and archaic/slang/offensive senses excluded','Every reading matched to constituent character readings; 2–5 levels use standard Joyo readings; upper levels use KANJIDIC2','Exact 2000 distinct words per level; 12000 distinct written forms overall; SHA256 integrity for every data file'],
 'limitations':'Dictionary and rule cross-checks do not constitute a human proofread of every question or a guarantee that no dictionary error exists. Game master must confirm before presenting.'}
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
