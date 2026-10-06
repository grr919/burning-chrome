import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/components/buildingModelMix.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020}}).outputText;
const {assessBuildingComplexity: assess, allocateBuildingModels: allocate, BUILDING_MODEL_MIX: models, isBuildingModelTestEnabled} = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const cell = (index, record) => ({index, ipAddress: `10.0.0.${index}`, complexity: assess(record)});
const count = (map, id) => [...map.values()].filter(value => value === id).length;

test('absence, failures, missing provider records and malformed evidence remain unknown', () => {
  for (const input of [undefined, null, {}, {error:'timeout',openPortCount:20}, {warning:'No public exposure data found',openPortCount:0}, {observationAvailable:false,openPortCount:0}, {openPortCount:NaN}, {openPortCount:-1}, {openPortCount:1.5}, {openPortCount:null}, {serviceNames:['cpe:/a:vendor:product','constructor','__proto__']}, {topPorts:['bad','0','65536','80x'],serviceNames:[]}]) {
    assert.equal(assess(input).tier, 'unknown');
    assert.equal(assess(input).score, null);
  }
});
test('a successful explicit zero is known low exposure, not inactivity', () => {
  const result=assess({openPortCount:0,topPorts:[],serviceNames:[]});
  assert.equal(result.tier,'low');assert.equal(result.score,0);
  assert.match(result.explanation,/does not prove inactivity/);
});
test('overlapping ports and aliases do not inflate the count', () => {
  const base={openPortCount:2,topPorts:['80/tcp','443/tcp','443/tcp'],serviceNames:['http','https','https']};
  assert.equal(assess(base).score,2);
  assert.deepEqual(assess({...base,serviceCount:1000,hostnames:Array(1000).fill('alias.example'),serviceNames:[...base.serviceNames,...Array(1000).fill('cpe:/a:vendor:product'),'cloud']}),assess(base));
  assert.equal(assess({topPorts:['443/tcp','443/udp','443/tcp']}).observedCount,1);
});
test('distinct categories add bounded diversity, not a second copy of the service count', () => {
  const result=assess({openPortCount:4,topPorts:['443/tcp','22/tcp','25/tcp','53/tcp']});
  assert.equal(result.observedCount,4);assert.equal(result.categoryCount,4);assert.equal(result.score,7);
  assert.equal(assess({openPortCount:6,topPorts:['80','22','25','53','3306','445']}).score,9);
  assert.equal(assess({serviceNames:['SMTP','smtp','imap','SSH']}).score,3);
});
test('full counts survive truncated port lists and absolute thresholds do not depend on neighbors', () => {
  assert.equal(assess({openPortCount:30,topPorts:['443/tcp']}).score,30);
  for(const [score,tier] of [[0,'low'],[2,'low'],[3,'moderate'],[5,'moderate'],[6,'complex'],[9,'complex'],[10,'high'],[15,'high'],[16,'exceptional']]) assert.equal(assess({openPortCount:score}).tier,tier);
});
test('unknown and quiet levels never get towers to meet a quota', () => {
  assert.equal(allocate('unknown',Array.from({length:256},(_,i)=>cell(i,undefined))).size,0);
  const map=allocate('quiet',Array.from({length:256},(_,i)=>cell(i,{openPortCount:0})));
  assert.equal(map.size,72);
  assert.ok([...map.values()].every(id=>id==='row-house-01'||id==='brick-house-01'));
});
test('one landmark goes to the strongest qualifying address; capped overflow is not downgraded', () => {
  const cells=Array.from({length:256},(_,i)=>cell(i,{openPortCount:16+i}));
  const map=allocate('busy',cells);
  assert.equal(map.get(255),'futuristic-towers-01');
  assert.equal(count(map,'futuristic-towers-01'),1);assert.equal(count(map,'office-tower-01'),4);
  assert.equal(map.size,5);
  assert.deepEqual([...map.keys()].sort((a,b)=>a-b),[251,252,253,254,255]);
});
test('caps, tier compatibility and order independence hold across 128 mixed levels', () => {
  for(let level=0;level<128;level++){
    const cells=Array.from({length:256},(_,i)=>cell(i,(i+level)%7===0?undefined:{openPortCount:(i*17+level)%24}));
    const map=allocate(`level-${level}`,cells);
    assert.ok(map.size<=97);
    assert.deepEqual([...map],[...allocate(`level-${level}`,[...cells].reverse())]);
    assert.deepEqual([...map],[...allocate(`level-${level}`,cells)]);
    for(const model of models)assert.ok(count(map,model.id)<=model.maxPerLevel);
    for(const [index,id] of map)assert.ok(models.find(model=>model.id===id).tiers.includes(cells[index].complexity.tier));
  }
});
test('new evidence can promote a cell, without freezing its initial unknown state', () => {
  assert.equal(allocate('updates',[cell(0,undefined)]).size,0);
  assert.ok(['row-house-01','brick-house-01'].includes(allocate('updates',[cell(0,{openPortCount:1})]).get(0)));
  assert.equal(allocate('updates',[cell(0,{openPortCount:12})]).get(0),'office-tower-01');
});
test('future registry entries work without changing scoring', () => {
  models.push({id:'test-future-model',name:'Test only',tiers:['complex'],maxPerLevel:3,weight:1,footprint:1});
  try {assert.equal(count(allocate('extension',Array.from({length:30},(_,i)=>cell(i,{openPortCount:7}))),'test-future-model'),3);}
  finally {models.pop();}
});
test('normal URL stays unchanged and the mixed URL enables the integration', () => {
  assert.equal(isBuildingModelTestEnabled(''),false);
  assert.equal(isBuildingModelTestEnabled('?buildingModels=mixed'),true);
});
