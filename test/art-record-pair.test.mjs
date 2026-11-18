import assert from 'node:assert/strict';
import test from 'node:test';
import { pairedLevels, remainingPairs, recordPublishedAnnual } from '../art-record-pair.mjs';
import { DatabaseSync } from 'node:sqlite';

const markets = [{ticker:'annual'}, {ticker:'lot120',floor_strike:120}, {ticker:'lot140',floor_strike:140}];
const books = [
  {ticker:'annual',orderbook_fp:{no_dollars:[['0.0500','5.00'],['0.0600','11.00']]}},
  {ticker:'lot120',orderbook_fp:{yes_dollars:[['0.9600','92.81']]}},
  {ticker:'lot140',orderbook_fp:{yes_dollars:[['0.7800','100.00']]}}
];
test('annual sale confirmation needs both sources, distinct books and one funded paper entry',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('CREATE TABLE paper(id PRIMARY KEY,strategy,ticker,side,at,quantity,price,fees,depth,closeAt); CREATE TABLE art_published_record_evidence(ticker PRIMARY KEY,at,detail)');
    const ticker='KXAUCTIONRECORD-27-VIN-117180000',at=Date.parse('2026-11-19T01:00:00Z');
    const market={ticker,status:'active',floor_strike:117180000,close_time:'2027-01-01T15:00Z'};
    const read=(ts,n)=>({requestedAt:ts,receivedAt:ts+50,httpDate:new Date(ts).toUTCString(),
      body:{orderbooks:[{ticker,orderbook_fp:{no_dollars:[['0.0100',n]]}}]}});
    const a=read(at,'1100.00'),b=read(at+1500,'7200.00');
    const sources=[{kind:'catalog',amount:190430000,at:at-1200,fresh:true}];
    const trial=()=>recordPublishedAnnual(db,market,a,b,()=>false,sources);
    trial();assert.equal(db.prepare('SELECT COUNT(*) n FROM paper').get().n,0);
    sources.push({kind:'lot',amount:null,at:at-1100,fresh:true});
    trial();assert.equal(db.prepare('SELECT COUNT(*) n FROM paper').get().n,0);
    sources[1].amount=190430000;
    recordPublishedAnnual(db,market,a,a,()=>false,sources);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM paper').get().n,0);
    trial();trial();
    const rows=db.prepare('SELECT * FROM paper').all();
    assert.equal(rows.length,1);assert.equal(rows[0].price,.99);assert.equal(rows[0].quantity,1009);
    assert.equal(rows[0].fees,.70);assert.equal(rows[0].depth,1100);
  }finally{db.close();}
});
test('annual YES depth is shared across strikes, fee reserves and spend survive repeated scans',()=>{
  const pairs=pairedLevels(markets,books,books,new Map(),1000);
  assert.deepEqual(pairs.map(p=>[p.lot,p.n,Math.round(p.cost*100)]),
    [['lot120',11,1086],['lot120',5,499]]);
  const used=new Map([['annual/940000',11],['annual/950000',5],['lot120/40000',16]]);
  assert.deepEqual(pairedLevels(markets,books,books,used,984.15),[]);
  const changed=structuredClone(books);
  changed[0].orderbook_fp.no_dollars[1][1]='3.00';
  assert.equal(pairedLevels(markets,books,changed,new Map(),1000)[0].n,3);
  assert.deepEqual(pairedLevels(markets,books,books,new Map(),0.98),[]);
  const tied=structuredClone(books);
  tied[2].orderbook_fp.yes_dollars=[['0.9600','16.00']];
  const equal=pairedLevels(markets,tied,tied,new Map(),1000);
  assert.equal(equal.reduce((s,p)=>s+p.n,0),16);
  assert.ok(equal.every(p=>p.lot==='lot140'));
});
test('delayed pair checks conserve shared depth and exclude older simulated holdings',()=>{
  const trades=pairedLevels(markets,books,books,new Map(),1000);
  const delayed=structuredClone(books);
  delayed[0].orderbook_fp.no_dollars=[['0.0600','4.9'],['0.0500','7']];
  assert.equal(remainingPairs(trades,delayed,new Map([['annual/940000',2]])),7);
  delayed[1].orderbook_fp.yes_dollars=[['0.9600','3.50']];
  assert.equal(remainingPairs(trades,delayed,new Map()),3);
  delayed[1].orderbook_fp.yes_dollars=[];
  assert.equal(remainingPairs(trades,delayed,new Map()),0);
});
