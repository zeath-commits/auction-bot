import assert from 'node:assert/strict';
import test from 'node:test';
import { pairedLevels, remainingPairs } from '../art-record-pair.mjs';

const markets = [{ticker:'annual'}, {ticker:'lot120',floor_strike:120}, {ticker:'lot140',floor_strike:140}];
const books = [
  {ticker:'annual',orderbook_fp:{no_dollars:[['0.0500','5.00'],['0.0600','11.00']]}},
  {ticker:'lot120',orderbook_fp:{yes_dollars:[['0.9600','92.81']]}},
  {ticker:'lot140',orderbook_fp:{yes_dollars:[['0.7800','100.00']]}}
];
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
