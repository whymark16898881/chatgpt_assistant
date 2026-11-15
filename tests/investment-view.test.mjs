import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summarizeInvestmentView} from '../lib/investment-view.mjs';
test('CFO account summary sums NAV once, excludes securities and keeps missing profit unknown',()=>{
 const overview={connected:true,reported_net_assets_cny:null,sources:[{source:'fixture',accounts:[{account_id:'one',valuation_currency:'USD',net_liquidation_value:'100.01',cash_balances:[{currency:'USD',amount:'-20'}],positions_complete:false,positions:[{symbol:'PRIVATE_SECURITY',market_value:'120.01'}]},{account_id:'two',valuation_currency:'USD',net_liquidation_value:'50.02',positions:[]},{account_id:'three',valuation_currency:'HKD',net_liquidation_value:'10',positions:[]}]}]};
 const v=summarizeInvestmentView(overview,{connected:true,metadata:{aggregate_positions:[{symbol:'PRIVATE_SECURITY'}],cash_candidates:[{amount:'1'}],risk_as_of:'fixture'}});
 assert.deepEqual(v.sources[0].net_assets_by_currency,[{currency:'USD',amount:'150.03'},{currency:'HKD',amount:'10.00'}]);assert.deepEqual(v.sources[0].accounts[0].negative_cash_balances,[{currency:'USD',amount:'20.00'}]);assert.equal(v.investment_profit.amount,null);assert.equal(v.sources[0].accounts[0].positions,undefined);assert.equal(v.source_status.metadata.aggregate_positions,undefined);assert.equal(v.source_status.metadata.cash_candidates,undefined);assert.ok(!JSON.stringify(v).includes('PRIVATE_SECURITY'));assert.equal(overview.sources[0].accounts[0].positions.length,1);
});

test('missing account NAV prevents a partial currency subtotal being presented as a complete total',()=>{
 const v=summarizeInvestmentView({sources:[{accounts:[{valuation_currency:'USD',net_liquidation_value:'100',cash_balances:[]},{valuation_currency:'USD',cash_balances:[]}]}]},null);
 assert.deepEqual(v.sources[0].net_assets_by_currency,[{currency:'USD',amount:null}]);
});
