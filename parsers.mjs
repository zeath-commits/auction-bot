function scripts(html){return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);}
export function christies(html,sale){
 const script=scripts(html).find(s=>s.includes('window.chrComponents.lots ='));
 const match=script?.match(/window\.chrComponents\.lots\s*=\s*([\s\S]*);\s*$/);if(!match)throw Error('Christies catalogue data missing');
 const obj=JSON.parse(match[1]);const lots=obj.data?.lots;if(!Array.isArray(lots))throw Error('Christies lot list missing');
 if(Number(obj.data.total_hits_filtered)!==lots.length)throw Error('Christies catalogue pagination incomplete');
 const currency=obj.labels?.currency_txt;
 return lots.map(l=>{const lot=String(l.lot_id_txt).replace(/\s/g,'');const amount=Number(l.price_realised);const identity=String(l.analytics_id).startsWith(sale+'.');const formatted=String(l.price_realised_txt||'');const displayed=Number(formatted.replace(/^USD\s*/, '').replaceAll(',',''));const hasPrice=currency==='USD'&&formatted.startsWith('USD ')&&Number.isFinite(amount)&&amount>0&&displayed===amount;
 const bidText=String(l.current_bid_txt||'').trim();
 const bid=Number(l.current_bid);
 const liveBid=identity&&currency==='USD'&&l.is_in_progress===true&&l.is_auction_over===false&&l.lot_withdrawn===false&&!hasPrice&&Number.isSafeInteger(bid)&&bid>0&&/^USD\s+[\d,]+(?:\.00)?$/.test(bidText)&&Number(bidText.replace(/^USD\s+/, '').replaceAll(',',''))===bid ? bid : null;
 return {sale,lot,id:l.object_id,artist:l.title_primary_txt,title:l.title_secondary_txt,url:l.url,currency,liveBid,amount:hasPrice?amount:null,hasExplicitPublishedPrice:hasPrice,closed:l.is_auction_over===true,inProgress:l.is_in_progress===true,withdrawn:l.lot_withdrawn===true,identityValid:identity,strictPublishedResult:identity&&hasPrice&&l.lot_withdrawn===false&&l.is_auction_over===true&&l.is_in_progress===false};});
}
export function phillips(html,auctionCode,{allowPartialCatalogue=false}={}){
 const prefix='window.__reactRouterContext.streamController.enqueue(';const script=scripts(html).find(s=>s.startsWith(prefix)&&s.includes('auctionCode'));if(!script)throw Error('Phillips catalogue stream missing');
 const pool=JSON.parse(JSON.parse(script.slice(prefix.length).replace(/\);\s*$/,'')));const routeIndex=pool.findIndex(v=>typeof v==='string'&&v.startsWith('routes/')&&v.includes('auctionCode'));if(routeIndex<0)throw Error('Phillips route missing');
 const ref=(obj,key)=>Object.entries(obj).find(([k,v])=>pool[Number(k.slice(1))]===key)?.[1];const scalar=(obj,key)=>pool[ref(obj,key)];const route=pool[routeIndex+1];const auction=pool[ref(route,'auction')];if(!auction||scalar(auction,'auctionCode')!==auctionCode)throw Error('Phillips auction mismatch');
 const lotRefs=pool[ref(auction,'lots')];const total=scalar(auction,'totalLotCount');
 if(!Array.isArray(lotRefs)||!lotRefs.length||!(total===lotRefs.length||(allowPartialCatalogue&&Number.isInteger(total)&&total>lotRefs.length)))throw Error('Phillips catalogue coverage mismatch');
 const lotNumbers=lotRefs.map(i=>scalar(pool[i],'lotNumberFull'));
 if(new Set(lotNumbers).size!==lotNumbers.length)throw Error('Duplicate Phillips lot number');
 const auctionCurrency=scalar(pool[ref(auction,'auctionCurrency')],'currencyCode');const auctionId=scalar(auction,'auctionId');
 return lotRefs.map(i=>{const row=pool[i],read=k=>scalar(row,k);const lotCurrency=scalar(pool[ref(row,'auctionCurrency')],'currencyCode');const price=read('soldPrice'),premium=read('hammerPricePlusBP'),status=read('lotStatus');const identity=read('auctionId')===auctionId;const validPrice=Number.isFinite(price)&&price>0&&price===premium&&lotCurrency==='USD'&&auctionCurrency==='USD';
 return {sale:auctionCode,lot:String(read('lotNumberFull')),id:read('objectNumber'),artist:read('makerName'),title:read('description'),url:read('detailLink'),currency:lotCurrency,amount:validPrice?price:null,hammer:read('hammerPrice'),status,explicitUnsold:identity&&status==='BoughtIn'&&read('isNoLot')===false&&[price,premium].every(v=>v==null||v===0),hasExplicitPublishedPrice:validPrice,identityValid:identity,strictPublishedResult:identity&&status==='Sold'&&read('isNoLot')===false&&read('showSoldPrice')===true&&validPrice};});
}
