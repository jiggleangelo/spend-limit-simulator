/* Original MIT implementation. Integer minor units; no provider integration. */
(function(root, factory) {
  'use strict'; const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LimitLatch = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const WINDOWS = Object.freeze({daily:86400000, weekly:604800000, monthly:2592000000});
  const MAX_EVENTS = 500;
  const copy = x => JSON.parse(JSON.stringify(x));
  const integer = x => Number.isSafeInteger(x) && x >= 0;
  function checkPolicy(p) {
    if (!p || !['daily','weekly','monthly','rpm','maxAgeMs'].every(k => integer(p[k]))) throw Error('Missing or invalid policy: use non-negative safe integers.');
    return Object.fromEntries(['daily','weekly','monthly','rpm','maxAgeMs'].map(k => [k,p[k]]));
  }
  function create(policy) { return {version:1, policy:checkPolicy(policy), lastAt:null, latch:null, records:[]}; }
  function validate(s) {
    if (!s || s.version !== 1 || !Array.isArray(s.records) || s.records.length > MAX_EVENTS || !(s.lastAt === null || integer(s.lastAt)) || !(s.latch === null || typeof s.latch === 'string')) throw Error('Invalid state.');
    checkPolicy(s.policy); const ids = new Set();
    for (const r of s.records) {
      if (!r || typeof r.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(r.id) || ids.has(r.id) || !integer(r.at) || !integer(r.reserved) || r.at > s.lastAt || !(r.actual === null || integer(r.actual)) || !(r.settledAt === null || integer(r.settledAt)) || ((r.actual === null) !== (r.settledAt === null)) || (r.settledAt !== null && (r.settledAt < r.at || r.settledAt > s.lastAt))) throw Error('Invalid ledger record.');
      ids.add(r.id);
    }
  }
  function project(state, now) {
    validate(state);
    if (!integer(now) || (state.lastAt !== null && now < state.lastAt)) throw Error('Invalid projection clock.');
    const usage = {}, remaining = {}; let pending = 0, drift = 0;
    const sum = values => values.reduce((a,b) => { const n=a+b; if (!Number.isSafeInteger(n)) throw Error('Ledger overflow.'); return n; },0);
    for (const key of Object.keys(WINDOWS)) {
      usage[key] = sum(state.records.filter(r => r.actual === null || r.settledAt > now-WINDOWS[key]).map(r => r.actual === null ? r.reserved : r.actual));
      remaining[key] = Math.max(0, state.policy[key]-usage[key]);
    }
    pending = sum(state.records.filter(r => r.actual === null).map(r => r.reserved));
    drift = sum(state.records.filter(r => r.actual !== null && r.actual > r.reserved).map(r => r.actual-r.reserved));
    const calls = state.records.filter(r => r.at > now-60000).length;
    return {source:'computed simulation; unverified input', usage, remaining, pending, positiveDrift:drift, calls, latched:state.latch !== null, reason:state.latch};
  }
  function apply(state, event, clock) {
    validate(state); const s = copy(state);
    function stop(reason) { s.latch = s.latch || reason; return {state:s, ack:false, reason}; }
    if (!clock || !integer(clock.now) || !integer(clock.observedAt) || clock.observedAt > clock.now || clock.now-clock.observedAt > s.policy.maxAgeMs || (s.lastAt !== null && clock.now < s.lastAt)) return stop('invalid_or_stale_clock');
    const now = clock.now;
    if (!event || !['reserve','settle'].includes(event.type) || typeof event.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(event.id)) return stop('invalid_event');
    if (event.type === 'reserve') {
      if (s.latch) return stop('latched');
      if (!integer(event.amount)) return stop('invalid_amount');
      if (s.records.some(r => r.id === event.id)) return stop('duplicate_id');
      if (s.records.length >= MAX_EVENTS) return stop('record_limit');
      let p; try { p = project(s,now); } catch { return stop('ledger_overflow'); }
      for (const key of Object.keys(WINDOWS)) if (event.amount > s.policy[key]-p.usage[key]) return stop(key+'_cap');
      if (p.calls >= s.policy.rpm) return stop('rate_cap');
      s.lastAt = now;
      s.records.push({id:event.id, at:now, reserved:event.amount, actual:null, settledAt:null});
    } else {
      // Reconciliation remains available while latched; an overrun must never disappear.
      if (!integer(event.actual)) return stop('invalid_actual');
      const r = s.records.find(r => r.id === event.id);
      if (!r || r.actual !== null) return stop('unknown_or_settled_id');
      r.actual = event.actual; r.settledAt = now; s.lastAt = now;
      let p; try { p=project(s,now); } catch { s.latch = s.latch || 'ledger_overflow'; return {state:s,ack:true,reason:'settled_overflow_latched'}; }
      if (Object.keys(WINDOWS).some(k => p.usage[k] > s.policy[k])) s.latch = s.latch || 'actual_over_cap';
    }
    return {state:s, ack:true, reason:s.latch ? 'recorded_while_latched' : 'recorded'};
  }
  function simulate(policy, events) {
    let state=create(policy);
    if (!Array.isArray(events) || events.length > MAX_EVENTS) throw Error('Use an event array of at most 500 entries.');
    const rows=[];
    for (const event of events) {
      const r=apply(state,event,{now:event?.at,observedAt:event?.observedAt}); state=r.state;
      rows.push({id:event?.id ?? '(missing)', type:event?.type ?? '(missing)', ack:r.ack, reason:r.reason, latch:state.latch, projection:project(state,state.lastAt ?? 0)});
    }
    return {rows,state};
  }
  function createSession(policy, adapter) {
    // An adapter contract for tests/integration experiments. The page uses no adapter/storage.
    if (!adapter || typeof adapter.write !== 'function' || typeof adapter.read !== 'function') throw Error('Persistence adapter required.');
    let state=create(policy), queue=Promise.resolve();
    function dispatch(event, clock) {
      // Capture caller data now, preventing mutation while queued.
      let captured; try { captured=structuredClone({event,clock}); } catch { captured={event:null,clock:null}; }
      const job=queue.then(async () => {
        const result=apply(state,captured.event,captured.clock);
        const serialized=JSON.stringify(result.state);
        try {
          await adapter.write(serialized);
          if (await adapter.read() !== serialized) throw Error('Read-back mismatch.');
          state=result.state; return {ack:result.ack,reason:result.reason,state:copy(state)};
        } catch {
          // An uncertain write still consumes its reservation in this process.
          state=result.state; state.latch=state.latch || 'persistence_uncertain';
          return {ack:false,reason:'persistence_uncertain',state:copy(state)};
        }
      });
      queue=job.catch(() => {}); return job;
    }
    return Object.freeze({dispatch, inspect:() => copy(state)});
  }
  return Object.freeze({WINDOWS,MAX_EVENTS,checkPolicy,create,project,apply,simulate,createSession});
}));
