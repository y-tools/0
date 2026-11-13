const assert=require('node:assert/strict');
const {parse,saveAtomically,MAX_BYTES}=require('../anagram-backup.js');
const fixture={format:'ypp-anagram-gacha-backup',version:1,settings:{diceCharacters:['あ','い','👨‍👩‍👧‍👦',''],currentPlayerName:'参加者A',batchCount:10,batchMode:'instant',maintenance:{duplicates:'none',dupScope:'all',pity:false,pityCount:100,pityScope:'player',pityTarget:''}},players:['参加者A','参加者B'],jackpots:[{word:'あい',tier:'gold'}],history:[{name:'参加者B',word:'あい',source:'あ・い',diceSetKey:'["い","あ"]',pityForced:false,time:'2026-11-13T00:00:00.000Z'}]};
const restore=()=>structuredClone(fixture);
const parsed=parse('\ufeff'+JSON.stringify(fixture));assert.equal(parsed.history.length,1);assert.equal(parsed.settings.diceCharacters[2],'👨‍👩‍👧‍👦');assert.equal(parsed.history[0].diceSetKey,'["あ","い"]');
const legacy={format:fixture.format,version:1,settings:{diceCharacters:['か\u3099']}};assert.equal(parse(JSON.stringify(legacy)).settings.diceCharacters[0],'が');assert.equal(parse(JSON.stringify(legacy)).settings.batchMode,'instant');
for(const change of [x=>x.version=2,x=>x.format='other',x=>x.settings.diceCharacters=['あい'],x=>x.settings.batchCount=1001,x=>x.settings.batchMode='bad',x=>x.history[0].time='invalid',x=>x.history[0].diceSetKey='{}',x=>x.history[0].pityForced='true',x=>x.jackpots[0].tier='__proto__',x=>x.jackpots.push(x.jackpots[0]),x=>x.settings.maintenance.pity=true]){const bad=restore();change(bad);assert.throws(()=>parse(JSON.stringify(bad)));}
assert.throws(()=>parse('{bad'));assert.throws(()=>parse('x'.repeat(MAX_BYTES+1)));
const polluted=JSON.parse(JSON.stringify(fixture));polluted.__proto__='ignored';parse(JSON.stringify(polluted));assert.equal({}.polluted,undefined);
const data=new Map([['a','oldA'],['b','oldB'],['unrelated','untouched']]);let writes=0;
const storage={getItem:k=>data.get(k)??null,setItem(k,v){if(++writes===2)throw new Error('quota');data.set(k,v);},removeItem:k=>data.delete(k)};
assert.throws(()=>saveAtomically(storage,[['a','newA'],['b','newB'],['c','newC']]));assert.deepEqual([...data].sort(),[['a','oldA'],['b','oldB'],['unrelated','untouched']].sort());
saveAtomically(storage,[['a','newA'],['b','newB']]);assert.equal(data.get('a'),'newA');assert.equal(data.get('unrelated'),'untouched');
console.log('PASS: backup round-trip schema, legacy defaults, graphemes, invalid fields/versions/history, file limit, prototype-safe projection, quota rollback and unrelated-key isolation');
