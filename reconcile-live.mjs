import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {Transport} from './transport.mjs';
import {decimal, MICRO, requireThat, validateConfig} from './core.mjs';
import {botFills,reconcileLedger} from './live-ledger.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const dir=path.join(root,'runtime','live');
async function optional(file) {
  try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}
}
async function sync(){
  const text=await optional(path.join(dir,'orders.jsonl'));
  requireThat(!text||text.endsWith('\n'),'Live journal append is incomplete. Recheck after it finishes.');
  const journal=botFills((text??'').split('\n').filter(Boolean).map(JSON.parse));
  const costs=await optional(path.join(dir,'operating-costs.json'));
  const operatingCosts=costs===null?null:decimal(JSON.parse(costs).totalDollars)/MICRO;
  let io;
  if(journal.history.length){
    const config=validateConfig(JSON.parse(await fs.readFile(path.join(root,'config.json'),'utf8')));
    io=new Transport(config);
    await io.loadCredentials(true);
  }
  const result=await reconcileLedger(io,journal,operatingCosts);
  await fs.mkdir(dir,{recursive:true});
  const file=path.join(dir,'reconciliation.json'),tmp=file+'.'+randomUUID()+'.tmp';
  try {
    await fs.writeFile(tmp,JSON.stringify(result,null,2)+'\n',{mode:0o600});
    await fs.rename(tmp,file);
  }finally{await fs.rm(tmp,{force:true});}
  console.log(JSON.stringify({checkedAt:result.checkedAt,botOrders:journal.history.length,markets:result.markets.length,
    verifiedMarkets:result.markets.filter(r=>r.state==='Verified').length,unresolved:journal.unresolved,conflicts:journal.conflicts,
    verifiedTradingNet:result.tradingNet,reportedOperatingCosts:result.operatingCosts,pilotNet:result.pilotNet}));
}
const args=process.argv.slice(2);
requireThat(args.length===0||(args.length===1&&args[0]==='--watch'),'Use npm run reconcile, optionally with -- --watch');
do{
  try{await sync();}catch(e){
    if(!args.length)throw e;
    console.error('Account reconciliation deferred:',e.message);
  }
  if(!args.length)break;
  await sleep(300000);
}while(true);
