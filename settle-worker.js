class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  less(a, b) { return a.f === b.f ? a.g > b.g : a.f < b.f; }
  push(node) {
    this.items.push(node);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(this.items[i], this.items[p])) break;
      [this.items[i], this.items[p]] = [this.items[p], this.items[i]];
      i = p;
    }
  }
  pop() {
    if (!this.items.length) return undefined;
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let best = i;
        if (l < this.items.length && this.less(this.items[l], this.items[best])) best = l;
        if (r < this.items.length && this.less(this.items[r], this.items[best])) best = r;
        if (best === i) break;
        [this.items[i], this.items[best]] = [this.items[best], this.items[i]];
        i = best;
      }
    }
    return top;
  }
}
function greedy(balances) {
  const debtors = balances.filter(b => b.amount < 0).map(b => ({...b}));
  const creditors = balances.filter(b => b.amount > 0).map(b => ({...b}));
  const transfers = [];
  while (debtors.length && creditors.length) {
    debtors.sort((a,b) => a.amount - b.amount);
    creditors.sort((a,b) => b.amount - a.amount);
    const d = debtors[0], c = creditors[0], amount = Math.min(-d.amount, c.amount);
    transfers.push({from:d.id,to:c.id,amount}); d.amount += amount; c.amount -= amount;
    if (!d.amount) debtors.shift(); if (!c.amount) creditors.shift();
  }
  return transfers;
}
function heuristic(state) { return Math.ceil(state.filter(value => value !== 0).length / 2); }
function keyOf(state) { return [...state].sort((a,b) => a-b).join(','); }
function settle(balances) {
  const active = balances.filter(b => b.amount !== 0);
  if (!active.length) return {transfers:[], optimal:true};
  const ids = active.map(b => b.id), start = active.map(b => b.amount), started = performance.now();
  const open = new MinHeap(), visited = new Set([keyOf(start)]);
  open.push({state:start,g:0,f:heuristic(start),path:[]});
  let expanded = 0;
  while (open.size) {
    const node = open.pop();
    if (node.state.every(value => value === 0)) return {transfers:node.path, optimal:true};
    expanded += 1;
    if (expanded > 200000 || performance.now() - started > 5000) break;
    for (let i=0;i<node.state.length;i++) {
      const si = node.state[i]; if (si >= 0) continue;
      for (let j=0;j<node.state.length;j++) {
        const sj = node.state[j]; if (sj <= 0) continue;
        const amount = Math.min(-si,sj), next = node.state.slice();
        next[i] = si + amount; next[j] = sj - amount;
        const key = keyOf(next); if (visited.has(key)) continue;
        visited.add(key); const g = node.g + 1;
        open.push({state:next,g,f:g+heuristic(next),path:[...node.path,{from:ids[i],to:ids[j],amount}]});
      }
    }
  }
  return {transfers:greedy(active),optimal:false};
}
self.onmessage = event => self.postMessage(settle(event.data));
