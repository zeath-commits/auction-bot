import {decimal, MICRO, requireThat, sha} from './core.mjs';

export function botFills(rows) {
  const intentRows = rows.filter(r=>r.type==='intent' && r.mode==='live' && r.clientOrderId && r.ticker);
  const intents = new Map(intentRows.map(r=>[r.clientOrderId,r]));
  const repeatedIntents=new Set([...Map.groupBy(intentRows,r=>r.clientOrderId)].filter(([,items])=>items.length>1).map(([id])=>id));
  const fills = rows.filter(
    (r) =>
      r.mode === 'live' &&
      r.type === 'receipt' &&
      !r.hypothetical &&
      intents.has(r.clientOrderId) &&
      typeof r.orderId === 'string' &&
      r.orderId &&
      Number.isFinite(r.costCents) &&
      r.costCents >= 0 &&
      Number.isFinite(r.filled) &&
      r.filled > 0
  );
  const grouped = Map.groupBy(fills, (r) => r.orderId);
  const clientGroups = Map.groupBy(fills, (r) => r.clientOrderId);
  const history = [];
  let conflicts = intentRows.length-intents.size;
  for (const group of grouped.values()) {
    const r = group[0],
      order = intents.get(r.clientOrderId);
    if(repeatedIntents.has(r.clientOrderId))continue;
    if (
      group.some(
        (x) =>
          x.clientOrderId !== r.clientOrderId ||
          x.costCents !== r.costCents ||
          x.filled !== r.filled ||
          (x.realizedProfit ?? null) !== (r.realizedProfit ?? null)
      ) ||
      clientGroups.get(r.clientOrderId).some((x) => x.orderId !== r.orderId)
    ) {
      conflicts++;
      continue;
    }
    history.push({
      orderId: r.orderId,
      subaccount: order.payload?.subaccount ?? 0,
      ticker: order.ticker,
      side: order.side,
      quantity: r.filled,
      cost: r.costCents / 100,
      at: r.recordedAt,
      source: 'Bot execution receipt',
      net: r.realizedProfit ?? null
    });
  }
  const acknowledged=new Set(rows.filter(r=>r.mode==='live' && r.type==='receipt' && !r.hypothetical &&
    typeof r.orderId==='string' && r.orderId && Number.isFinite(r.filled) && r.filled>=0 &&
    Number.isSafeInteger(r.costCents) && r.costCents>=0 && (r.filled>0||r.costCents===0)).map(r=>r.clientOrderId));
  return { history, conflicts, unresolved:[...intents.keys()].filter(id=>!acknowledged.has(id)).length };
}

export const ledgerFingerprint=journal=>sha([journal.history,journal.conflicts,journal.unresolved]);

// The settlement belongs to a whole ticker and subaccount. Allocate its cash
// once, after matching every exchange fill to a journaled order for that group.
export function verifySettlement(orders,fills,settlements) {
  requireThat(orders.length>0 && settlements.length===1,'Expected one account settlement');
  const s=settlements[0],{ticker,subaccount}=orders[0];
  const side=orders[0].side.toLowerCase(),other=side==='yes'?'no':'yes';
  const ids=new Map(orders.map(o=>[o.orderId,o]));
  requireThat(['yes','no'].includes(side)&&ids.size===orders.length&&orders.every(o=>o.ticker===ticker&&
    o.subaccount===subaccount&&o.side.toLowerCase()===side),'Conflicting journaled positions');
  requireThat(s.ticker===ticker&&s.exchange_index===0&&(s.subaccount_number??subaccount)===subaccount&&
    ['yes','no','scalar'].includes(s.market_result)&&Number.isFinite(Date.parse(s.settled_time)),'Invalid account settlement');
  const totals=new Map(),seen=new Map();
  let totalCount=0,principal=0,fees=0;
  for(const f of fills) {
    requireThat(f.fill_id&&ids.has(f.order_id)&&f.ticker===ticker&&(f.market_ticker??ticker)===ticker&&f.exchange_index===0&&
      (f.subaccount_number??subaccount)===subaccount&&f.outcome_side===side&&f.book_side===(side==='yes'?'bid':'ask'),
      'Account activity differs from this bot’s orders');
    const count=decimal(f.count_fp)/10000,price=decimal(f[side+'_price_dollars']),fee=decimal(f.fee_cost);
    requireThat(Number.isSafeInteger(count)&&count>0&&price>0&&price<MICRO&&price+decimal(f[other+'_price_dollars'])===MICRO,'Invalid fill values');
    const identity=JSON.stringify([f.order_id,count,price,fee]);
    if(seen.has(f.fill_id)){
      requireThat(seen.get(f.fill_id)===identity,'Conflicting duplicate exchange fill');
      continue;
    }
    seen.set(f.fill_id,identity);
    const v=totals.get(f.order_id)??{count:0,cost:0};
    v.count+=count;v.cost+=price*count+100*fee;totals.set(f.order_id,v);
    totalCount+=count;principal+=price*count;fees+=fee;
  }
  requireThat(Number.isSafeInteger(principal+fees*100),'Fill total exceeds precision');
  for(const o of orders){
    const v=totals.get(o.orderId);
    requireThat(v&&Math.abs(o.quantity*100-v.count)<1e-8,'Exchange fill count differs from receipt');
    // A receipt uses rounded average prices and rounds its total upward to cents.
    // The final cost below comes directly from the settlement and itemized fills.
    requireThat(Math.abs(o.cost*100-v.cost/1000000)<=1.000001+o.quantity*.0001,'Exchange cost differs from receipt');
  }
  const basis=decimal(s[side+'_total_cost_dollars']),settledFee=decimal(s.fee_cost);
  requireThat(decimal(s[side+'_count_fp'])===totalCount*10000&&decimal(s[other+'_count_fp'])===0&&
    decimal(s[other+'_total_cost_dollars'])===0,'Settlement position differs from bot fills');
  requireThat(principal===basis*100&&settledFee===fees,'Settlement cost or fees differ from itemized fills');
  requireThat(Number.isSafeInteger(s.revenue)&&s.revenue>=0,'Invalid settlement proceeds');
  const yesCents=s.market_result==='scalar'?s.value:s.market_result==='yes'?100:0;
  requireThat(Number.isInteger(yesCents)&&yesCents>=0&&yesCents<=100&&(s.value==null||s.value===yesCents)&&
    Math.abs(s.revenue*100-totalCount*(side==='yes'?yesCents:100-yesCents))<100,'Settlement proceeds differ from payout');
  return {settledAt:s.settled_time,quantity:totalCount/100,fillCount:seen.size,principal:basis/MICRO,fees:fees/MICRO,
    proceeds:s.revenue/100,tradingNet:(s.revenue*10000-basis-fees)/MICRO};
}

async function pages(io,route,field,ticker,subaccount) {
  const params=new URLSearchParams({ticker,subaccount:String(subaccount),limit:'100'});
  const rows=[],cursors=new Set();
  for(;;){
    const {body}=await io.get(route+'?'+params,true);
    requireThat(Array.isArray(body[field]),'Missing account '+field);
    rows.push(...body[field]);
    if(!body.cursor)return rows;
    requireThat(typeof body.cursor==='string'&&!cursors.has(body.cursor),'Repeated account cursor');
    cursors.add(body.cursor);params.set('cursor',body.cursor);
  }
}

export async function reconcileLedger(io,journal,operatingCosts) {
  const groups=Map.groupBy(journal.history,r=>JSON.stringify([r.ticker,r.subaccount]));
  const markets=[];
  for(const orders of groups.values()){
    const {ticker,subaccount}=orders[0];
    const row={ticker,subaccount,orders:orders.length};markets.push(row);
    const settlements=await pages(io,'/portfolio/settlements','settlements',ticker,subaccount);
    if(!settlements.length){row.state='Awaiting account settlement';continue;}
    const fills=await pages(io,'/portfolio/fills','fills',ticker,subaccount);
    const archived=await pages(io,'/historical/fills','fills',ticker,subaccount);
    try {Object.assign(row,verifySettlement(orders,[...fills,...archived],settlements),{state:'Verified'});}
    catch(e){row.state='Requires review';row.reason=e.message;}
  }
  const verified=markets.filter(r=>r.state==='Verified');
  const netMicros=verified.reduce((sum,r)=>sum+Math.round(r.tradingNet*MICRO),0);
  return {checkedAt:new Date().toISOString(),fingerprint:ledgerFingerprint(journal),markets,
    tradingNet:verified.length?netMicros/MICRO:null,operatingCosts,
    pilotNet:verified.length&&verified.length===markets.length&&!journal.conflicts&&!journal.unresolved&&operatingCosts!==null
      ? (netMicros-Math.round(operatingCosts*MICRO))/MICRO:null};
}
