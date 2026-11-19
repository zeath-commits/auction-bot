// Caller supplies seller-initiated executions strictly after simulated order arrival.
export function measureSales(sales,limitDollars,until){
  const qualifying=sales.filter(t=>Date.parse(t.at)<until && t.price<limitDollars);
  const volume=qualifying.reduce((n,t)=>n+Math.round(t.qty*100),0)/100;
  return {volume,shares:Math.min(100,Math.floor(volume))};
}

export async function windowTrades(io,trial,side,taker){
  const cutoff=Date.parse((await io.get('/historical/cutoff')).body.trades_created_ts);
  if(!Number.isFinite(cutoff))throw Error('Missing trade archive cutoff');
  const trades=new Map();
  if(trial.untilAt>trial.arrival){
    const routes=[trial.arrival<cutoff&&'/historical/trades',trial.untilAt>=cutoff&&'/markets/trades'].filter(Boolean);
    for(const route of routes){
      for(const trade of await readTrades(io,trial,side,taker,route))trades.set(trade.id,trade);
    }
  }
  return [...trades.values()];
}

async function readTrades(io,trial,side,taker,route) {
  const params=new URLSearchParams({ticker:trial.ticker,min_ts:String(Math.floor(trial.arrival/1000)),
    max_ts:String(Math.ceil(trial.untilAt/1000)),is_block_trade:'false',limit:'1000'});
  const trades=[];
  const cursors=new Set(),ids=new Set();
  do {
    const {body}=await io.get(route+'?'+params);
    for(const t of body.trades) {
      if(t.ticker!==trial.ticker||!t.trade_id||ids.has(t.trade_id))throw Error('Unexpected public trade identity');
      ids.add(t.trade_id);
      const at=Date.parse(t.created_time),price=Number(t[side+'_price_dollars']),qty=Number(t.count_fp);
      if(!Number.isFinite(at+price+qty)||qty<=0||price<=0||price>=1)throw Error('Invalid public trade');
      if(at<=trial.arrival||at>=trial.untilAt||t.is_block_trade!==false||t.taker_outcome_side!==taker||
        t.taker_book_side!==(taker==='yes'?'bid':'ask'))continue;
      trades.push({id:t.trade_id,at:t.created_time,price,qty});
    }
    if(!body.cursor)break;
    if(cursors.has(body.cursor))throw Error('Repeated public trades cursor');
    cursors.add(body.cursor);params.set('cursor',body.cursor);
  }while(true);
  return trades;
}
