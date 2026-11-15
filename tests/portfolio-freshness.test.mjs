import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nextPortfolioDeadline,portfolioFreshness} from '../lib/portfolio-freshness.mjs';
const status=(observed,published,at)=>portfolioFreshness(observed,published,{now:()=>Date.parse(at),policy:'twice_daily'});
test('SGT publication windows and 30-minute receiver grace cover boundaries and midnight',()=>{
 for(const [time,due] of[
  ['00:00','2026-11-15T12:30:00+08:00'],['06:59','2026-11-15T12:30:00+08:00'],
  ['07:00','2026-11-16T00:30:00+08:00'],['11:59','2026-11-16T00:30:00+08:00'],
  ['12:00','2026-11-16T00:30:00+08:00'],['17:59','2026-11-16T00:30:00+08:00'],
  ['18:00','2026-11-16T12:30:00+08:00'],['23:59','2026-11-16T12:30:00+08:00']]){
  assert.equal(Date.parse(nextPortfolioDeadline('2026-11-15T'+time+':00+08:00')),Date.parse(due));
 }
});
test('a scheduled snapshot is valid between daily publications, while hourly policy still expires it',()=>{
 const observed='2026-11-15T07:55:00+08:00',published='2026-11-15T08:00:00+08:00',now=()=>Date.parse('2026-11-15T22:00:00+08:00');
 assert.equal(portfolioFreshness(observed,published,{now,policy:'twice_daily'}).stale,false);assert.equal(portfolioFreshness(observed,published,{now,policy:'hourly'}).stale,true);
});
test('deadline boundaries do not silently extend after each poll',()=>{
 const a='2026-11-15T21:55:00+08:00',e='2026-11-15T22:00:00+08:00';assert.equal(status(a,e,'2026-11-16T12:30:00+08:00').stale,false);assert.equal(status(a,e,'2026-11-16T12:30:00.001+08:00').delivery_stale,true);assert.equal(status(a,e,'2026-11-16T18:00:00+08:00').next_expected_by,nextPortfolioDeadline(e));
});
test('a recent export cannot disguise source observations older than90 minutes at capture',()=>{
 const r=status('2026-11-15T18:00:00+08:00','2026-11-15T22:00:00+08:00','2026-11-15T22:01:00+08:00');assert.equal(r.capture_stale,true);assert.equal(r.stale,true);
 assert.equal(status('2026-11-15T20:30:00+08:00','2026-11-15T22:00:00+08:00','2026-11-15T22:01:00+08:00').capture_stale,false);
});
test('calendar rollover and leap days use Singapore time even with UTC input',()=>{
 assert.equal(Date.parse(nextPortfolioDeadline('2026-12-31T22:00:00+08:00')),Date.parse('2027-01-01T12:30:00+08:00'));
 assert.equal(Date.parse(nextPortfolioDeadline('2028-02-29T23:00:00+08:00')),Date.parse('2028-03-01T12:30:00+08:00'));
 assert.equal(nextPortfolioDeadline('2026-11-14T23:00:00Z'),nextPortfolioDeadline('2026-11-15T07:00:00+08:00'));
});
test('missing, impossible or future timestamps are never fresh',()=>{
 for(const [a,e]of[['bad','bad'],['2026-11-15T22:01:00+08:00','2026-11-15T22:00:00+08:00'],['2026-11-16T22:00:00+08:00','2026-11-16T22:01:00+08:00']])assert.equal(status(a,e,'2026-11-15T22:00:00+08:00').stale,true);
});
