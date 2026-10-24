// Deterministic, synthetic fixtures. These are never represented as market prices.
export const sampleHoldings = [
  {symbol:'RELIANCE',name:'Reliance Industries',sector:'Energy',quantity:25,average_price:1378.20,exchange:'NSE',source:'demo'},
  {symbol:'TCS',name:'Tata Consultancy Services',sector:'Information technology',quantity:10,average_price:3210.00,exchange:'NSE',source:'demo'},
  {symbol:'HDFCBANK',name:'HDFC Bank',sector:'Banking',quantity:30,average_price:1640.50,exchange:'NSE',source:'demo'},
  {symbol:'INFY',name:'Infosys',sector:'Information technology',quantity:20,average_price:1555.00,exchange:'NSE',source:'demo'},
  {symbol:'BHARTIARTL',name:'Bharti Airtel',sector:'Telecommunications',quantity:15,average_price:1758.00,exchange:'NSE',source:'demo'},
  {symbol:'ITC',name:'ITC Limited',sector:'Consumer staples',quantity:60,average_price:432.80,exchange:'NSE',source:'demo'},
];
export const sampleNames = Object.fromEntries(sampleHoldings.map(h=>[h.symbol,h]));
export function makeDemoCandles(symbol) {
  const bases={RELIANCE:1512.4,TCS:3364.8,HDFCBANK:1758.6,INFY:1502.2,BHARTIARTL:1886.7,ITC:451.3};
  let seed=[...symbol].reduce((s,c)=>s+c.charCodeAt(0),0);
  const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  const out=[]; let p=(bases[symbol]||1200)*.87;
  const end=new Date('2026-10-22T10:00:00Z');
  const days=[];for(let i=0;days.length<180;i++){const d=new Date(end);d.setUTCDate(d.getUTCDate()-i);if(d.getUTCDay()!==0&&d.getUTCDay()!==6)days.unshift(d.toISOString());}
  for(let i=0;i<days.length;i++) {const open=p*(1+(rand()-.5)*.008);const trend=symbol==='INFY'?-.00013:.0011;const close=open*(1+trend+(rand()-.49)*.018);const high=Math.max(open,close)*(1+rand()*.012),low=Math.min(open,close)*(1-rand()*.012);out.push({time:days[i],open,high,low,close,volume:Math.round(1200000+rand()*2200000)});p=close;}
  const factor=(bases[symbol]||1200)/p;
  return out.map((c,i)=>({...c,open:round(c.open*factor),high:round(c.high*factor),low:round(c.low*factor),close:round(c.close*factor),volume:i>175?Math.round(c.volume*1.42):c.volume}));
}
const round=n=>Math.round(n*100)/100;
