import objectiveValue from '../planning/backend/objectiveValue.js';
import { createDashboardCache } from '../server/dashboardCache.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSaleName, completeRosterRows } from '../server/nameMatching.js';
import { createDashboardService, withLiveDashboardSettings } from '../server/dashboardService.js';
import { buildSourceSnapshot } from '../server/sourceSnapshot.js';
import { buildReportHtml } from '../server/reportHtml.js';
import registerFinanceRoutes from '../planning/backend/financeRoutes.js';

const roster = [
  {display:'Thomas Durand',last:'durand'},
  {display:'Alice Durand',last:'durand'},
  {display:'Noémie Streith',last:'streith',aliases:['streight']},
];
test('un nom complet inversé ou accentué conserve la bonne identité malgré un homonyme', () => {
  assert.equal(resolveSaleName('DURAND, Thomas',roster),'Thomas Durand');
  assert.equal(resolveSaleName('STREITH Noemie',roster),'Noémie Streith');
  assert.equal(resolveSaleName('Noemie Streight',roster),'Noémie Streith');
});
test('un nom ambigu ou une sous-chaîne ne rattache jamais au premier commercial', () => {
  assert.equal(resolveSaleName('Durand',roster),'Durand');
  assert.equal(resolveSaleName('Durandot',roster),'Durandot');
  assert.equal(resolveSaleName('',roster),null);
});
test('les montants sans rattachement restent dans le détail du total global', () => {
  const rows=completeRosterRows(new Map([['Thomas Durand',{count:1,amount:500}],['Durand',{count:2,amount:1200}]]),roster,true);
  assert.equal(rows.reduce((s,r)=>s+r.amount,0),1700);
  assert.equal(rows.find(r=>r.name==='Durand').unmatched,true);
  assert.equal(rows.find(r=>r.name==='Alice Durand').amount,0);
});
const range={start:new Date('2026-09-17T00:00:00Z'),end:new Date('2026-09-17T23:59:59Z'),label:'Aujourd’hui'};
const month={start:new Date('2026-09-01T00:00:00Z'),end:range.end,label:'Ce mois'};
function sources(overrides={}) {
  const metric=async()=>({total:0,totalAmount:0,detail:[]});
  return {getCalls:metric,getRdvInRange:metric,getRdvBookedInRange:metric,getPropals:metric,getSignatures:metric,getRevenue:metric,getSalesforgeRdv:metric,getBdc:metric,getPropalsComptes:metric,resolveRange:()=>month,comparisonRange:()=>range,getReportSettings:()=>({monthlyRevenueObjective:0}),...overrides};
}
test('une panne du mois ne réutilise pas le CA du jour comme CA mensuel', async () => {
  const service=createDashboardService(sources({getRevenue:async r=>{if(+r.start===+month.start)throw Error('panne');return {totalAmount:450,detail:[]};}}));
  const data=await service.collectData('today',range);
  assert.equal(data.revenue.totalAmount,450);
  assert.equal(data.monthRevenue.totalAmount,0);
  assert.ok(data.errors.monthRevenue);
  assert.equal(data.errors.revenue,undefined);
});
test('un zéro valide se distingue explicitement d’une comparaison indisponible',async()=>{
  const valid=await createDashboardService(sources()).collectCompareData(range);
  assert.equal(valid.calls.total,0);assert.equal(valid.errors,null);
  const failed=await createDashboardService(sources({getCalls:async()=>{throw Error('panne');}})).collectCompareData(range);
  assert.ok(failed.errors.calls);assert.equal(failed.errors.revenue,undefined);
});
test('une panne du mois sélectionné marque aussi le repère mensuel',async()=>{
  const data=await createDashboardService(sources({getRevenue:async()=>{throw Error('panne');}})).collectData('this_month',month);
  assert.ok(data.errors.revenue);assert.ok(data.errors.monthRevenue);
});
test('la fraîcheur conserve une date absolue et ne transforme pas une date absente en collecte récente',()=>{
  const now=Date.parse('2026-09-17T12:00:00Z');
  const snapshots=buildSourceSnapshot({salesforce:{won:{ageMs:120000},leads:{ageMs:60000}},aircall:{calls:{ageMs:null,truncated:true}}},now);
  assert.equal(snapshots.find(s=>s.id==='salesforce').oldestCacheAt,'2026-09-17T11:58:00.000Z');
  assert.equal(snapshots.find(s=>s.id==='aircall').oldestCacheAt,null);
  assert.equal(snapshots.find(s=>s.id==='aircall').incomplete,true);
});

test('le rapport global conserve un commercial auparavant masqué et échappe les noms des sources',()=>{
  const metric={total:1,totalAmount:1200,detail:[{name:'Donatien LEFEBURE',count:1,amount:1200},{name:'<script>fictif</script>',count:1,amount:10}]};
  const html=buildReportHtml({data:{calls:metric,revenue:metric,signatures:metric,errors:null},monthRevenue:metric,monthLabel:'septembre'});
  assert.ok(html.includes('Donatien LEFEBURE'));
  assert.ok(html.includes('CA gagné'));
  assert.ok(!html.includes('<script>fictif</script>'));
});

test('le rapport n’annonce pas une baisse ou zéro vente quand Salesforce est indisponible',()=>{
  const data={errors:{revenue:'panne',signatures:'panne',monthRevenue:'panne'},revenue:{totalAmount:0,detail:[]},signatures:{total:0,detail:[]}};
  const html=buildReportHtml({data,monthRevenue:{totalAmount:0,detail:[]},monthLabel:'septembre',compare:{signatures:{total:20},revenue:{totalAmount:20000}}});
  assert.ok(html.includes('Certaines sources sont indisponibles'));
  assert.ok(!html.includes('Aucun CA ce mois-ci'));
  assert.ok(!html.includes('-100%'));
});

test('les routes finance extraites conservent leur contrôle d’accès avant chaque handler',()=>{
  const registered=[];
  const app=Object.fromEntries(['get','post','patch','delete'].map(method=>[method,(url,...handlers)=>registered.push({method,url,handlers})]));
  const guard=()=>{};
  registerFinanceRoutes(app,{db:{},pennylane:{},requireFinance:guard,FINANCE_INTERNAL_STATUSES:[]});
  assert.equal(registered.length,17);
  for(const route of registered){assert.equal(route.handlers[0],guard);assert.ok(route.url.startsWith('/api/finance/'));}
  assert.ok(registered.some(r=>r.method==='post'&&r.url==='/api/finance/sync'));
  assert.ok(registered.some(r=>r.method==='get'&&r.url==='/api/finance/invoices/:id/pdf'));
  // Statuts d'échéance personnalisables (Paramètres > Recouvrement) — les 4
  // routes CRUD ajoutées avec les échéances 2/3/4, sous le même contrôle
  // d'accès que le reste (vérifié par la boucle ci-dessus).
  assert.ok(registered.some(r=>r.method==='get'&&r.url==='/api/finance/installment-statuses'));
  assert.ok(registered.some(r=>r.method==='post'&&r.url==='/api/finance/installment-statuses'));
  assert.ok(registered.some(r=>r.method==='patch'&&r.url==='/api/finance/installment-statuses/:statusId'));
  assert.ok(registered.some(r=>r.method==='delete'&&r.url==='/api/finance/installment-statuses/:statusId'));
});

test('un objectif modifié est visible immédiatement même lorsque les chiffres restent en cache',async()=>{
  let computes=0;
  const cache=createDashboardCache({compute:async()=>{computes++;return {revenue:{totalAmount:400},settings:{monthlyRevenueObjective:1000}};},resolveRange:()=>range});
  const first=withLiveDashboardSettings(await cache.get('today',range),{monthlyRevenueObjective:1000});
  const after=withLiveDashboardSettings(await cache.get('today',range),{monthlyRevenueObjective:2500});
  assert.equal(first.settings.monthlyRevenueObjective,1000);assert.equal(after.settings.monthlyRevenueObjective,2500);
  assert.equal(after.revenue.totalAmount,400);assert.equal(computes,1);
});
test('un montant invalide n’est ni converti en zéro ni multiplié silencieusement',()=>{
  assert.equal(objectiveValue.parseMonthlyObjective(0),0);
  assert.equal(objectiveValue.parseMonthlyObjective('25000'),25000);
  for(const value of [-1,1.5,'','10 000','10000,50',null,true,Infinity]) assert.throws(()=>objectiveValue.parseMonthlyObjective(value),RangeError);
});
