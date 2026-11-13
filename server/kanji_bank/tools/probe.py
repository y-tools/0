import csv, gzip, json, re, sys, unicodedata
from collections import defaultdict, Counter
from pathlib import Path
from xml.etree import ElementTree as ET
sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).parent
RAW=ROOT/'raw'
ORDER=['10級','9級','8級','7級','6級','5級','4級','3級','準2級','2級','準1級','1級']
levels={r['漢字テキスト']:ORDER.index(r['漢検級']) for r in csv.DictReader((RAW/'levels.csv').open(encoding='utf-8-sig')) if r['字体']=='親字' and r['漢検級'] in ORDER and len(r['漢字テキスト'])==1}
all_readings=defaultdict(set)
candidates={}
def hira(value):
    return ''.join(chr(ord(c)-96) if 'ァ'<=c<='ヶ' else c for c in unicodedata.normalize('NFKC',value))
for _, e in ET.iterparse(gzip.open(RAW/'JMdict_e.gz','rb'),events=('end',)):
    if e.tag!='entry':continue
    for spelling_index,k in enumerate(e.findall('k_ele')):
        word=k.findtext('keb')
        if not re.fullmatch(r'[一-龯]{2,4}',word or '') or any(c not in levels for c in word):continue
        readings=[]
        for r in e.findall('r_ele'):
            restrictions=r.findall('re_restr')
            if r.find('re_nokanji') is not None or (restrictions and word not in [x.text for x in restrictions]):continue
            reading=hira(r.findtext('reb') or '')
            all_readings[word].add(reading)
            if r.find('re_inf') is None and re.fullmatch(r'[ぁ-ゖー]{2,16}',reading):readings.append(reading)
        flags=[x.text.lower() for x in e.findall('.//misc')+e.findall('.//dial')]
        blocked=bool(e.findall('.//dial')) or any(any(tag in flag for tag in ('archai','obsolete','rare','obscure','vulgar','derog','slang','historical','sensitive','offensive')) for flag in flags)
        if len(readings)!=1 or k.find('ke_inf') is not None or blocked:continue
        tags=[x.text for x in k.findall('ke_pri')]
        candidates[word]={'word':word,'reading':readings[0],'level':max(levels[c] for c in word),'id':e.findtext('ent_seq'),'common':bool(tags),'preferred':spelling_index==0}
    e.clear()
candidates={w:r for w,r in candidates.items() if len(all_readings[w])==1}
print('Strict single-reading candidates by maximum character level:',Counter(ORDER[r['level']] for r in candidates.values()))
print('Cumulative:',{ORDER[i]:sum(r['level']<=i for r in candidates.values()) for i in (5,6,7,9,10,11)})
(ROOT/'candidates.json').write_text(json.dumps(list(candidates.values()),ensure_ascii=False),encoding='utf-8')
print('CSV counts:',Counter(ORDER[i] for i in levels.values()))
