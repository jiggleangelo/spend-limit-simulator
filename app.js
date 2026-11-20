'use strict';
const PRESETS=[
  {
    "name": "Daily hard stop",
    "policy": {
      "daily": 1000,
      "weekly": 3000,
      "monthly": 6000,
      "rpm": 3,
      "maxAgeMs": 60000
    },
    "events": [
      {
        "type": "reserve",
        "id": "call1",
        "at": 100000,
        "observedAt": 100000,
        "amount": 600
      },
      {
        "type": "settle",
        "id": "call1",
        "at": 100010,
        "observedAt": 100010,
        "actual": 600
      },
      {
        "type": "reserve",
        "id": "call2",
        "at": 100020,
        "observedAt": 100020,
        "amount": 500
      }
    ]
  },
  {
    "name": "Reservation drift",
    "policy": {
      "daily": 1000,
      "weekly": 3000,
      "monthly": 6000,
      "rpm": 3,
      "maxAgeMs": 60000
    },
    "events": [
      {
        "type": "reserve",
        "id": "call1",
        "at": 100000,
        "observedAt": 100000,
        "amount": 800
      },
      {
        "type": "settle",
        "id": "call1",
        "at": 100010,
        "observedAt": 100010,
        "actual": 1200
      },
      {
        "type": "reserve",
        "id": "call2",
        "at": 100020,
        "observedAt": 100020,
        "amount": 1
      }
    ]
  },
  {
    "name": "Rate cap",
    "policy": {
      "daily": 1000,
      "weekly": 3000,
      "monthly": 6000,
      "rpm": 1,
      "maxAgeMs": 60000
    },
    "events": [
      {
        "type": "reserve",
        "id": "call1",
        "at": 100000,
        "observedAt": 100000,
        "amount": 1
      },
      {
        "type": "reserve",
        "id": "call2",
        "at": 100001,
        "observedAt": 100001,
        "amount": 1
      },
      {
        "type": "reserve",
        "id": "call3",
        "at": 200000,
        "observedAt": 200000,
        "amount": 1
      }
    ]
  },
  {
    "name": "Stale clock",
    "policy": {
      "daily": 1000,
      "weekly": 3000,
      "monthly": 6000,
      "rpm": 3,
      "maxAgeMs": 60000
    },
    "events": [
      {
        "type": "reserve",
        "id": "call1",
        "at": 100000,
        "observedAt": 1,
        "amount": 1
      }
    ]
  }
];
const byId=id=>document.getElementById(id);
const output=byId('result'), status=byId('status');
function clearResult() {output.textContent='';output.hidden=true;}
function show(value) {output.textContent=JSON.stringify(value,null,2);output.hidden=false;}
function read(id) {const text=byId(id).value;if (!text.trim()) throw Error('Missing '+id+' input.');if(text.length>100000) throw Error('Input exceeds 100000 characters; nothing was checked.');return JSON.parse(text);}
function clearTable(){byId('rows').replaceChildren();byId('steps').hidden=true;}
function load(p) {byId('policy').value=JSON.stringify(p.policy,null,2);byId('events').value=JSON.stringify(p.events,null,2);clearResult();clearTable();status.textContent='Made-up example loaded. Click Simulate.';}
byId('run').addEventListener('click',()=>{clearResult();clearTable();try {
 const value=LimitLatch.simulate(read('policy'),read('events'));
 for(const r of value.rows){const tr=document.createElement('tr');for(const cell of [r.type+' '+r.id,r.ack?'Yes (simulation only)':'No',r.reason,Object.values(r.projection.usage).join(' / '),r.latch || 'Open']){const td=document.createElement('td');td.textContent=String(cell);tr.appendChild(td);}byId('rows').appendChild(tr);}
 byId('steps').hidden=false;show(value.state);status.textContent=value.state.latch?'STOP LATCHED: '+value.state.latch:'Simulation complete; this controls no real API.';
}catch(e){status.textContent='BLOCKED: '+e.message;}});
byId('clear').addEventListener('click',()=>{byId('policy').value='';byId('events').value='';clearResult();clearTable();status.textContent='Cleared; no saved history.';});
for(const p of PRESETS){const button=document.createElement('button');button.type='button';button.textContent='Made-up example: '+p.name;button.addEventListener('click',()=>load(p));byId('examples').appendChild(button);}
