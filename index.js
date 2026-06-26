/**
 * Wizzard Futures — HolyGrail Edition
 * Railway deployment: Express + node-cron + Binance Futures
 */

const express = require("express");
const cron = require("node-cron");
const fetch = require("node-fetch");
const FormData = require("form-data");

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHART_KEY = process.env.CHART_KEY || "RR7M88ycUv8Y2ZXVT6kmgn19DF1kCY8x4X50jQ50";
// OKX Futures API - lebih permissive dari Binance di semua region
const OKX = "https://www.okx.com";
const BATCH_SIZE = 8;
const TOTAL_SYMBOLS = 60;

const activeSignals = new Map();
let batchIndex = 0;

// ─── OKX ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function okx(path) {
  try {
    const r = await fetch(`${OKX}${path}`, { headers: { Accept: "application/json" } });
    if (!r.ok) { console.log(`OKX ${r.status} ${path}`); return null; }
    return await r.json();
  } catch(e) { console.log("okx err:", e.message); return null; }
}

async function getAllSymbols() {
  // OKX: GET /api/v5/market/tickers?instType=SWAP
  const d = await okx("/api/v5/market/tickers?instType=SWAP");
  if (!d?.data) { console.log("getAllSymbols gagal"); return []; }
  return d.data
    .filter(t => t.instId.endsWith("USDT-SWAP") && parseFloat(t.volCcy24h) > 1_000_000)
    .sort((a, b) => parseFloat(b.volCcy24h) - parseFloat(a.volCcy24h))
    .slice(0, TOTAL_SYMBOLS)
    .map(t => t.instId.replace("-SWAP", "").replace("-", "")); // "BTC-USDT" → "BTCUSDT"
}

// OKX instId format: "BTCUSDT" → "BTC-USDT-SWAP"
function toOKXId(symbol) {
  // BTCUSDT → BTC-USDT-SWAP
  const base = symbol.replace("USDT", "");
  return `${base}-USDT-SWAP`;
}

// OKX bar: "3m", "5m", "15m"
async function getKlines(symbol, interval) {
  const instId = toOKXId(symbol);
  const d = await okx(`/api/v5/market/candles?instId=${instId}&bar=${interval}m&limit=200`);
  if (!d?.data?.length) return null;
  // OKX candle: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
  return d.data
    .map(r => ({ t:+r[0], o:+r[1], h:+r[2], l:+r[3], c:+r[4], v:+r[5] }))
    .reverse(); // OKX return newest first
}

async function getFunding(symbol) {
  const instId = toOKXId(symbol);
  const d = await okx(`/api/v5/public/funding-rate?instId=${instId}`);
  if (!d?.data?.[0]) return { rate: 0, bias: "neutral" };
  const rate = parseFloat(d.data[0].fundingRate);
  return { rate, bias: rate > 0.0005 ? "bearish" : rate < -0.0005 ? "bullish" : "neutral" };
}

async function getOI(symbol) {
  return { pct: 0, trend: "flat" };
}

async function getCurrentPrice(symbol) {
  const instId = toOKXId(symbol);
  const d = await okx(`/api/v5/market/ticker?instId=${instId}`);
  return d?.data?.[0]?.last ? parseFloat(d.data[0].last) : null;
}

// ─── MATH ─────────────────────────────────────────────────────────────────────

function ema(arr, p) {
  const k = 2/(p+1), out = new Array(arr.length).fill(null);
  let s = 0;
  for (let i = 0; i < p; i++) s += (arr[i] ?? 0);
  out[p-1] = s/p;
  for (let i = p; i < arr.length; i++) out[i] = (arr[i]??0)*k + out[i-1]*(1-k);
  return out;
}
function sma(arr, p) {
  return arr.map((_, i) => i < p-1 ? null : arr.slice(i-p+1,i+1).reduce((a,b)=>a+(b??0),0)/p);
}
function last(arr) {
  for (let i = arr.length-1; i >= 0; i--) if (arr[i] !== null && !isNaN(arr[i])) return arr[i];
  return 0;
}
function atr(c, p=14) {
  const tr = c.map((x,i) => i===0 ? x.h-x.l : Math.max(x.h-x.l,Math.abs(x.h-c[i-1].c),Math.abs(x.l-c[i-1].c)));
  return sma(tr, p);
}
function calcEMA(c, p) { return ema(c.map(x=>x.c), p); }
function calcRSI(c, p=14) {
  const cl=c.map(x=>x.c);
  const g=cl.map((x,i)=>i===0?0:Math.max(0,x-cl[i-1]));
  const l=cl.map((x,i)=>i===0?0:Math.max(0,cl[i-1]-x));
  const ag=sma(g.slice(1),p), al=sma(l.slice(1),p);
  return ag.map((x,i)=>!x||!al[i]?null:100-100/(1+x/al[i]));
}
function calcStoch(c, kp=14, dp=3) {
  const k=c.map((_,i)=>{
    if(i<kp-1)return null;
    const sl=c.slice(i-kp+1,i+1);
    const hh=Math.max(...sl.map(x=>x.h)),ll=Math.min(...sl.map(x=>x.l));
    return hh===ll?50:100*(c[i].c-ll)/(hh-ll);
  });
  return { k, d: sma(k.map(v=>v??50),dp) };
}
function calcMACD(c) {
  const cl=c.map(x=>x.c), e12=ema(cl,12), e26=ema(cl,26);
  const macd=e12.map((v,i)=>v&&e26[i]?v-e26[i]:null);
  const signal=ema(macd.map(v=>v??0),9);
  return { hist: macd.map((v,i)=>v&&signal[i]?v-signal[i]:null) };
}
function calcBB(c, p=20, mult=2) {
  const cl=c.map(x=>x.c), mid=sma(cl,p);
  const std=cl.map((_,i)=>{
    if(i<p-1)return null;
    const sl=cl.slice(i-p+1,i+1), m=sl.reduce((a,b)=>a+b)/p;
    return Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/p);
  });
  return {
    upper: mid.map((m,i)=>m&&std[i]?m+mult*std[i]:null),
    lower: mid.map((m,i)=>m&&std[i]?m-mult*std[i]:null),
    mid, width: mid.map((m,i)=>m&&std[i]?(2*mult*std[i])/m*100:null),
  };
}
function calcVWAP(c) {
  let ct=0,cv=0;
  return c.map(x=>{const tp=(x.h+x.l+x.c)/3;ct+=tp*x.v;cv+=x.v;return cv?ct/cv:null;});
}
function calcOBV(c) {
  let o=0;
  return c.map((x,i)=>{if(i>0)o+=x.c>c[i-1].c?x.v:x.c<c[i-1].c?-x.v:0;return o;});
}
function calcCVD(c) {
  let d=0; return c.map(x=>{d+=x.c>=x.o?x.v:-x.v;return d;});
}

// ─── SMC ──────────────────────────────────────────────────────────────────────

function findSwings(c, w=5) {
  const highs=[],lows=[];
  for(let i=w;i<c.length-w;i++){
    const sl=c.slice(i-w,i+w+1);
    if(c[i].h===Math.max(...sl.map(x=>x.h)))highs.push({v:c[i].h});
    if(c[i].l===Math.min(...sl.map(x=>x.l)))lows.push({v:c[i].l});
  }
  return {highs,lows};
}
function detectStructure(c) {
  if(c.length<30) return {bias:"NEUTRAL",label:"Ranging",bos:false,choch:false};
  const {highs,lows}=findSwings(c);
  if(highs.length<2||lows.length<2) return {bias:"NEUTRAL",label:"Ranging",bos:false,choch:false};
  const lH=highs[highs.length-1].v,pH=highs[highs.length-2].v;
  const lL=lows[lows.length-1].v,pL=lows[lows.length-2].v;
  const rec=c.slice(-8),rH=Math.max(...rec.map(x=>x.h)),rL=Math.min(...rec.map(x=>x.l));
  if(rH>pH&&lH>pH) return {bias:"BULLISH",label:"BOS UP",bos:true,choch:false};
  if(rL<pL&&lL<pL) return {bias:"BEARISH",label:"BOS DOWN",bos:true,choch:false};
  if(lH<pH&&lL>pL) return {bias:"BULLISH",label:"CHoCH Bullish",bos:false,choch:true};
  if(lL>pL&&lH<pH) return {bias:"BEARISH",label:"CHoCH Bearish",bos:false,choch:true};
  return {bias:"NEUTRAL",label:"Ranging",bos:false,choch:false};
}
function detectOrderBlock(c) {
  const result={bull_ob:null,bear_ob:null};
  for(let i=c.length-10;i<c.length-2;i++){
    const cur=c[i],next=c[i+1],next2=c[i+2];
    if(cur.c<cur.o&&next.c>next.o&&next2.c>next2.o&&(next.c-next.o)>(cur.o-cur.c)*1.5)
      result.bull_ob={high:cur.h,low:cur.l};
    if(cur.c>cur.o&&next.c<next.o&&next2.c<next2.o&&(next.o-next.c)>(cur.c-cur.o)*1.5)
      result.bear_ob={high:cur.h,low:cur.l};
  }
  return result;
}
function detectFVG(c) {
  const gaps=[];
  for(let i=1;i<c.length-1;i++){
    const prev=c[i-1],next=c[i+1];
    if(next.l>prev.h)gaps.push({type:"bull",top:next.l,bot:prev.h});
    if(next.h<prev.l)gaps.push({type:"bear",top:prev.l,bot:next.h});
  }
  return gaps.slice(-3);
}
function findSRLevels(c, lookback=50) {
  const recent=c.slice(-lookback);
  const highs=recent.map(x=>x.h).sort((a,b)=>b-a);
  const lows=recent.map(x=>x.l).sort((a,b)=>a-b);
  const price=c[c.length-1].c;
  const resistance=highs.find(h=>h>price*1.001)||highs[0];
  const support=lows.find(l=>l<price*0.999)||lows[0];
  return {
    resistance, support,
    distToRes: resistance?+((resistance-price)/price*100).toFixed(2):999,
    distToSup: support?+((price-support)/price*100).toFixed(2):999,
  };
}
function detectCandlePattern(c) {
  if(c.length<3) return [];
  const x=c[c.length-1],p=c[c.length-2],pp=c[c.length-3];
  const body=Math.abs(x.c-x.o),upper=x.h-Math.max(x.c,x.o);
  const lower=Math.min(x.c,x.o)-x.l,range=x.h-x.l||0.001;
  const res=[];
  if(lower>body*2.5&&upper<body*0.3) res.push({name:"Hammer",bull:true});
  if(upper>body*2.5&&lower<body*0.3) res.push({name:"Shooting Star",bull:false});
  if(body<range*0.08) res.push({name:"Doji",bull:null});
  if(x.c>x.o&&p.c<p.o&&x.c>p.o&&x.o<p.c&&Math.abs(x.c-x.o)>Math.abs(p.c-p.o)*0.8)
    res.push({name:"Bullish Engulfing",bull:true});
  if(x.c<x.o&&p.c>p.o&&x.c<p.o&&x.o>p.c&&Math.abs(x.c-x.o)>Math.abs(p.c-p.o)*0.8)
    res.push({name:"Bearish Engulfing",bull:false});
  const ppB=Math.abs(pp.c-pp.o),pB=Math.abs(p.c-p.o);
  if(pp.c>pp.o&&pB<ppB*0.3&&x.c<x.o) res.push({name:"Evening Star",bull:false});
  if(pp.c<pp.o&&pB<ppB*0.3&&x.c>x.o) res.push({name:"Morning Star",bull:true});
  if(lower>range*0.6&&body<range*0.25) res.push({name:"Bullish Pin Bar",bull:true});
  if(upper>range*0.6&&body<range*0.25) res.push({name:"Bearish Pin Bar",bull:false});
  return res;
}

// ─── HOLYGRAIL ────────────────────────────────────────────────────────────────

function analyzeHolyGrail(c15, c5, c3) {
  if(!c15||!c5||!c3||c15.length<50||c5.length<50||c3.length<50) return null;
  const price=c15[c15.length-1].c;
  let score=0; const signals=[];
  const s15=detectStructure(c15),s5=detectStructure(c5),s3=detectStructure(c3);
  if(s15.bos&&s15.bias==="BULLISH"){score+=2.0;signals.push("✅ M15 BOS UP");}
  else if(s15.choch&&s15.bias==="BULLISH"){score+=1.5;signals.push("✅ M15 CHoCH Bullish");}
  else if(s15.bos&&s15.bias==="BEARISH"){score-=2.0;signals.push("🔻 M15 BOS DOWN");}
  else if(s15.choch&&s15.bias==="BEARISH"){score-=1.5;signals.push("🔻 M15 CHoCH Bearish");}
  if(s5.bias==="BULLISH"){score+=0.8;signals.push("✅ M5 bullish");}
  else if(s5.bias==="BEARISH"){score-=0.8;signals.push("🔻 M5 bearish");}
  if(s3.bias==="BULLISH")score+=0.5; else if(s3.bias==="BEARISH")score-=0.5;
  const ob15=detectOrderBlock(c15),ob5=detectOrderBlock(c5);
  if(ob15.bull_ob&&price>=ob15.bull_ob.low&&price<=ob15.bull_ob.high*1.01){score+=1.2;signals.push("✅ Bullish OB M15");}
  if(ob15.bear_ob&&price>=ob15.bear_ob.low*0.99&&price<=ob15.bear_ob.high){score-=1.2;signals.push("🔻 Bearish OB M15");}
  if(ob5.bull_ob&&price>=ob5.bull_ob.low&&price<=ob5.bull_ob.high*1.01){score+=0.7;signals.push("✅ Bullish OB M5");}
  const sr=findSRLevels(c15);
  if(sr.distToSup<0.3){score+=0.8;signals.push(`✅ Dekat Support`);}
  if(sr.distToRes<0.3){score-=0.8;signals.push(`🔻 Dekat Resistance`);}
  if(sr.distToRes>1.5&&s15.bias==="BULLISH"){score+=0.5;signals.push("✅ Room to resistance luas");}
  if(sr.distToSup>1.5&&s15.bias==="BEARISH"){score+=0.5;signals.push("✅ Room to support luas");}
  const e9=last(calcEMA(c15,9)),e21=last(calcEMA(c15,21)),e50=last(calcEMA(c15,50));
  const e9_5=last(calcEMA(c5,9)),e21_5=last(calcEMA(c5,21));
  if(price>e9&&price>e21&&price>e50){score+=1.0;signals.push("✅ Price > EMA 9/21/50");}
  else if(price<e9&&price<e21&&price<e50){score-=1.0;signals.push("🔻 Price < EMA 9/21/50");}
  else if(price>e9&&price>e21){score+=0.5;signals.push("✅ Price > EMA 9/21");}
  else if(price<e9&&price<e21){score-=0.5;signals.push("🔻 Price < EMA 9/21");}
  if(e9>e21&&e21>e50){score+=0.5;signals.push("✅ EMA bullish alignment");}
  else if(e9<e21&&e21<e50){score-=0.5;signals.push("🔻 EMA bearish alignment");}
  if(e9_5>e21_5)score+=0.3; else score-=0.3;
  const rsi15=last(calcRSI(c15)),rsi5=last(calcRSI(c5));
  if(rsi15<35){score+=0.8;signals.push(`✅ RSI oversold (${rsi15.toFixed(1)})`);}
  else if(rsi15>65){score-=0.8;signals.push(`🔻 RSI overbought (${rsi15.toFixed(1)})`);}
  else if(rsi15>50){score+=0.3;signals.push(`✅ RSI bullish (${rsi15.toFixed(1)})`);}
  else score-=0.3;
  if(rsi5<40&&s15.bias==="BULLISH"){score+=0.5;signals.push("✅ RSI M5 pullback");}
  if(rsi5>60&&s15.bias==="BEARISH"){score+=0.5;signals.push("✅ RSI M5 rally");}
  const {k:k15arr,d:d15arr}=calcStoch(c15),{k:k5arr}=calcStoch(c5);
  const k15=last(k15arr),d15=last(d15arr),k5=last(k5arr);
  if(k15<20){score+=0.7;signals.push(`✅ Stoch oversold K=${k15.toFixed(1)}`);}
  else if(k15>80){score-=0.7;signals.push(`🔻 Stoch overbought K=${k15.toFixed(1)}`);}
  if(k15>d15&&k15<50){score+=0.3;signals.push("✅ Stoch golden cross");}
  else if(k15<d15&&k15>50){score-=0.3;}
  if(k5<25)score+=0.4; else if(k5>75)score-=0.4;
  const {hist:h15}=calcMACD(c15),{hist:h5}=calcMACD(c5);
  const hist15=last(h15),prevH=h15[h15.length-2];
  if(hist15>0&&prevH<0){score+=0.8;signals.push("✅ MACD bullish cross");}
  else if(hist15<0&&prevH>0){score-=0.8;signals.push("🔻 MACD bearish cross");}
  else if(hist15>0)score+=0.3; else score-=0.3;
  if(last(h5)>0)score+=0.2; else score-=0.2;
  const bb=calcBB(c15);
  const bbL=last(bb.lower),bbU=last(bb.upper),bbM=last(bb.mid),bbW=last(bb.width);
  if(price<=bbL*1.005){score+=0.7;signals.push("✅ Lower BB bounce");}
  else if(price>=bbU*0.995){score-=0.7;signals.push("🔻 Upper BB reject");}
  if(price>bbM)score+=0.2; else score-=0.2;
  if(bbW&&bbW<2){score+=0.3;signals.push("✅ BB squeeze");}
  const vwap=last(calcVWAP(c15));
  if(price>vwap){score+=0.5;signals.push("✅ Above VWAP");}
  else{score-=0.5;signals.push("🔻 Below VWAP");}
  const obv=calcOBV(c15),cvd=calcCVD(c15);
  if(last(obv)-obv[obv.length-10]>0){score+=0.4;signals.push("✅ OBV uptrend");}
  else{score-=0.4;signals.push("🔻 OBV downtrend");}
  if(last(cvd)-cvd[cvd.length-6]>0)score+=0.3; else score-=0.3;
  const recentVol=c15.slice(-3).map(x=>x.v);
  const avgVol=c15.slice(-20).map(x=>x.v).reduce((a,b)=>a+b)/20;
  if(Math.max(...recentVol)>avgVol*1.5){signals.push("⚡ Volume spike");score+=score>0?0.4:-0.4;}
  const allPats=[...detectCandlePattern(c15),...detectCandlePattern(c5),...detectCandlePattern(c3)];
  for(const p of allPats){
    if(p.bull===true){score+=0.5;signals.push(`✅ ${p.name}`);}
    else if(p.bull===false){score-=0.5;signals.push(`🔻 ${p.name}`);}
  }
  for(const g of detectFVG(c15)){
    if(g.type==="bull"&&price>=g.bot&&price<=g.top){score+=0.6;signals.push("✅ Bullish FVG");}
    if(g.type==="bear"&&price>=g.bot&&price<=g.top){score-=0.6;signals.push("🔻 Bearish FVG");}
  }
  let direction;
  if(score>=2.5)direction="LONG";
  else if(score<=-2.5)direction="SHORT";
  else return null;
  const conviction=Math.min(10,Math.max(6,Math.abs(score)*0.85+4));
  const atrVal=last(atr(c15))||price*0.005;
  let entry=price,sl,tp1,tp2,tp3,tp4;
  if(direction==="LONG"){
    const swingLow=Math.min(...c15.slice(-8).map(x=>x.l));
    sl=Math.min(price-atrVal*1.8,swingLow*0.999);
    const risk=entry-sl;
    tp1=+(entry+risk*1).toFixed(8);tp2=+(entry+risk*2).toFixed(8);
    tp3=+(entry+risk*3).toFixed(8);tp4=+(entry+risk*4.5).toFixed(8);
  } else {
    const swingHigh=Math.max(...c15.slice(-8).map(x=>x.h));
    sl=Math.max(price+atrVal*1.8,swingHigh*1.001);
    const risk=sl-entry;
    tp1=+(entry-risk*1).toFixed(8);tp2=+(entry-risk*2).toFixed(8);
    tp3=+(entry-risk*3).toFixed(8);tp4=+(entry-risk*4.5).toFixed(8);
  }
  sl=+sl.toFixed(8);
  const risk=Math.abs(entry-sl),reward=Math.abs(tp4-entry);
  return {
    direction,conviction:+conviction.toFixed(1),entry,sl,tp1,tp2,tp3,tp4,
    rr:risk>0?`1:${(reward/risk).toFixed(1)}`:"1:0",
    pot:entry>0?(reward/entry*100).toFixed(1):"0",
    signals:signals.slice(0,6),
    struct15:s15.label,struct5:s5.label,struct3:s3.label,
    sr,rsi15:rsi15.toFixed(1),k15:k15.toFixed(1),
  };
}

// ─── CHART ────────────────────────────────────────────────────────────────────

async function fetchChart(symbol) {
  try {
    const body = {
      symbol: `OKX:${symbol.replace('USDT','')}_USDTSWAP`,
      interval: "15m", width: 800, height: 500, theme: "dark",
      studies: [{ name: "Relative Strength Index" }],
    };
    const r = await fetch("https://api.chart-img.com/v2/tradingview/advanced-chart", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": CHART_KEY },
      body: JSON.stringify(body),
    });
    if (!r.ok) { console.log(`chart-img ${r.status}`); return null; }
    return await r.buffer();
  } catch(e) { console.log("chart err:", e.message); return null; }
}

// ─── FORMAT ───────────────────────────────────────────────────────────────────

function formatMsg(symbol, r, funding) {
  const dir = r.direction==="LONG" ? "🟢 LONG" : "🔴 SHORT";
  const sym = symbol.replace("USDT","");
  const bar = "█".repeat(Math.round(r.conviction)) + "░".repeat(10-Math.round(r.conviction));
  const frStr = `${funding.rate>=0?"+":""}${(funding.rate*100).toFixed(4)}%`;
  const frE = funding.rate>0.0005?"🔴":funding.rate<-0.0005?"🟢":"⚪";
  const now = new Date().toLocaleString("id-ID",{timeZone:"Asia/Jakarta"});
  return `$${sym}  —  ${dir}

Multi-Timeframe Structure
M15: ${r.struct15}
M5:  ${r.struct5}
M3:  ${r.struct3}

Key Signals
${r.signals.map(s=>`  ${s}`).join("\n")}

Support: ${r.sr.support?.toFixed(4)??"—"}  (${r.sr.distToSup}% away)
Resistance: ${r.sr.resistance?.toFixed(4)??"—"}  (${r.sr.distToRes}% away)

RSI M15: ${r.rsi15}  |  Stoch K: ${r.k15}

Entry: ${r.entry}
SL:    ${r.sl}
RR:    ${r.rr}

TP1: ${r.tp1}
TP2: ${r.tp2}
TP3: ${r.tp3}
TP4: ${r.tp4}

Funding: ${frE} ${frStr} (${funding.bias})

Conviction ${bar}
${r.conviction}/10  |  Potensi ~${r.pot}%

Scalping M3/M5/M15 • DYOR | ${now}`;
}

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────

async function tgPhoto(imgBuffer, caption) {
  try {
    const form = new FormData();
    form.append("chat_id", CHAT_ID);
    form.append("caption", caption);
    form.append("photo", imgBuffer, { filename: "chart.png", contentType: "image/png" });
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
      method: "POST", headers: form.getHeaders(), body: form,
    });
    const d = await r.json();
    console.log("Photo:", d.ok, d.description||"");
    return d.ok;
  } catch(e) { console.log("tgPhoto err:", e.message); return false; }
}

async function tgText(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text }),
    });
  } catch(e) { console.log("tgText err:", e.message); }
}

// ─── TP/SL MONITOR ───────────────────────────────────────────────────────────

async function checkTPSL() {
  if (!activeSignals.size) return;
  console.log(`TP/SL check: ${activeSignals.size} signal(s)`);
  for (const [symbol, signal] of activeSignals) {
    try {
      const price = await getCurrentPrice(symbol);
      if (!price) continue;
      const slHit = signal.direction==="LONG" ? price<=signal.sl : price>=signal.sl;
      if (slHit) {
        const pnl = signal.direction==="LONG"
          ? ((price-signal.entry)/signal.entry*100).toFixed(2)
          : ((signal.entry-price)/signal.entry*100).toFixed(2);
        await tgText(`🛑 STOP LOSS HIT\n\n$${symbol.replace("USDT","")} ${signal.direction}\nEntry: ${signal.entry}\nSL Hit: ${price}\nPnL: ${pnl}%`);
        activeSignals.delete(symbol);
        continue;
      }
      const tps = [{label:"TP4",p:signal.tp4},{label:"TP3",p:signal.tp3},{label:"TP2",p:signal.tp2},{label:"TP1",p:signal.tp1}];
      for (const tp of tps) {
        const hit = signal.direction==="LONG" ? price>=tp.p : price<=tp.p;
        if (hit) {
          const pnl = signal.direction==="LONG"
            ? ((price-signal.entry)/signal.entry*100).toFixed(2)
            : ((signal.entry-price)/signal.entry*100).toFixed(2);
          await tgText(`✅ ${tp.label} HIT\n\n$${symbol.replace("USDT","")} ${signal.direction}\nEntry: ${signal.entry}\n${tp.label}: ${tp.p}\nPnL: +${pnl}%`);
          if (tp.label==="TP4") activeSignals.delete(symbol);
          else signal.sl = signal.entry;
          break;
        }
      }
    } catch(e) { console.log(`${symbol} TPSL err:`, e.message); }
  }
}

// ─── SCAN ─────────────────────────────────────────────────────────────────────

async function runScan() {
  console.log("Scan:", new Date().toISOString());
  const all = await getAllSymbols();
  if (!all.length) { console.log("No symbols"); return; }
  const totalBatches = Math.ceil(all.length / BATCH_SIZE);
  const batch = all.slice(batchIndex * BATCH_SIZE, (batchIndex+1) * BATCH_SIZE);
  console.log(`Batch ${batchIndex+1}/${totalBatches}: ${batch.join(", ")}`);
  batchIndex = (batchIndex + 1) % totalBatches;
  let sent = 0;
  for (const symbol of batch) {
    try {
      const [c3, c5, c15, funding] = await Promise.all([
        getKlines(symbol,3), getKlines(symbol,5), getKlines(symbol,15), getFunding(symbol),
      ]);
      if (!c3||!c5||!c15) { console.log(`${symbol}: kline gagal`); continue; }
      const result = analyzeHolyGrail(c15, c5, c3);
      if (!result || result.conviction < 6) continue;
      if (result.direction==="LONG" && funding.rate>0.001) continue;
      if (result.direction==="SHORT" && funding.rate<-0.001) continue;
      console.log(`Signal: ${symbol} ${result.direction} ${result.conviction}/10`);
      const caption = formatMsg(symbol, result, funding);
      const img = await fetchChart(symbol);
      let sent_ok = false;
      if (img) sent_ok = await tgPhoto(img, caption);
      if (!sent_ok) await tgText(caption);
      activeSignals.set(symbol, {
        direction:result.direction, entry:result.entry, sl:result.sl,
        tp1:result.tp1, tp2:result.tp2, tp3:result.tp3, tp4:result.tp4,
      });
      sent++;
      await new Promise(r => setTimeout(r, 1000));
    } catch(e) { console.log(`${symbol} err:`, e.message); }
  }
  console.log(`Done. Sent: ${sent}`);
}

// ─── CRON & SERVER ───────────────────────────────────────────────────────────

cron.schedule("*/5 * * * *", async () => {
  await checkTPSL();
  await runScan();
});

app.get("/", (_, res) => res.send("⚡ Wizzard Futures — Running!"));
app.get("/scan", async (_, res) => { res.send("Scan started"); await checkTPSL(); await runScan(); });
app.get("/signals", (_, res) => res.json(Object.fromEntries(activeSignals)));

app.listen(PORT, () => {
  console.log(`Wizzard Futures on port ${PORT}`);
  // Jalankan scan pertama saat startup
  setTimeout(async () => { await checkTPSL(); await runScan(); }, 3000);
});
