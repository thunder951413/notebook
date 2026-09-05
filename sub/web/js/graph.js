// Force-directed page graph rendered as SVG.
export function renderGraph(svg, nodes, links, opts = {}) {
  const { onSelect, onBack } = opts;
  const W = svg.clientWidth || 900;
  const H = svg.clientHeight || 600;
  svg.innerHTML = '';
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.style.width = W + 'px';
  svg.style.height = H + 'px';

  if (!nodes.length) {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', W / 2); t.setAttribute('y', H / 2);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', 'graph-empty');
    t.textContent = '暂无页面 — 创建一些笔记和 [[链接]] 后这里会出现图谱';
    svg.appendChild(t);
    return;
  }

  const pos = new Map();
  const R = 14;
  // initial positions on a circle
  nodes.forEach((n, i) => {
    const ang = (i / nodes.length) * Math.PI * 2;
    pos.set(n.id, { x: W / 2 + Math.cos(ang) * Math.min(W, H) * 0.35, y: H / 2 + Math.sin(ang) * Math.min(W, H) * 0.35, vx: 0, vy: 0 });
  });

  const linkSet = new Set();
  const linkMap = new Map(); // "a|b" -> count
  for (const l of links) {
    const key = [l.source, l.target].sort().join('|');
    linkSet.add(key);
    linkMap.set(key, (linkMap.get(key) || 0) + 1);
  }
  const uniqueLinks = [...linkSet].map(k => {
    const [a, b] = k.split('|');
    return { source: a, target: b, weight: linkMap.get(k) };
  }).filter(l => pos.has(l.source) && pos.has(l.target));

  // simulation
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (let iter = 0; iter < 300; iter++) {
    // repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i].id), b = pos.get(nodes[j].id);
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const d = Math.sqrt(d2);
        const f = 1200 / d2;
        const fx = dx / d * f, fy = dy / d * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }
    // attraction along links
    for (const l of uniqueLinks) {
      const a = pos.get(l.source), b = pos.get(l.target);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = 90;
      const f = (d - target) * 0.02 * l.weight;
      const fx = dx / d * f, fy = dy / d * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    // center gravity + damping
    for (const n of nodes) {
      const p = pos.get(n.id);
      p.vx += (W / 2 - p.x) * 0.005;
      p.vy += (H / 2 - p.y) * 0.005;
      p.x += p.vx * 0.12;
      p.y += p.vy * 0.12;
      p.vx *= 0.55;
      p.vy *= 0.55;
      p.x = Math.max(R + 10, Math.min(W - R - 10, p.x));
      p.y = Math.max(R + 10, Math.min(H - R - 10, p.y));
    }
  }

  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  // links
  for (const l of uniqueLinks) {
    const a = pos.get(l.source), b = pos.get(l.target);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    line.setAttribute('class', 'graph-link');
    line.setAttribute('stroke-width', Math.min(4, 0.8 + l.weight * 0.8));
    g.appendChild(line);
  }
  // nodes
  for (const n of nodes) {
    const p = pos.get(n.id);
    const gNode = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    gNode.setAttribute('class', 'graph-node');
    gNode.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', R);
    circle.setAttribute('class', n.kind === 'task' ? 'graph-circle graph-circle-task' : 'graph-circle');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    title.setAttribute('y', -R - 6);
    title.setAttribute('text-anchor', 'middle');
    title.setAttribute('class', 'graph-label');
    title.textContent = n.title.length > 18 ? n.title.slice(0, 18) + '…' : n.title;
    const emoji = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    emoji.setAttribute('y', 5);
    emoji.setAttribute('text-anchor', 'middle');
    emoji.setAttribute('class', 'graph-emoji');
    emoji.textContent = n.icon || (n.kind === 'task' ? '✅' : '📄');
    gNode.appendChild(circle);
    gNode.appendChild(title);
    gNode.appendChild(emoji);
    gNode.addEventListener('click', () => onSelect && onSelect(n.id));
    g.appendChild(gNode);
  }
  svg.appendChild(g);
}

window.renderGraph = renderGraph;
