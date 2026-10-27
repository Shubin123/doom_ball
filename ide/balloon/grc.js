// Reads a GNU Radio Companion 3.10 flowgraph (.grc, YAML) far enough to list
// its variables, blocks with parameters and enabled state, and connections,
// and to follow the signal path from each enabled source.

function scalar(text) {
  const t = text.trim();
  if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  if (/^".*"$/.test(t)) return t.slice(1, -1);
  return t;
}

export function parseGrc(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  const connections = [];
  let section = null, block = null, sub = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^[A-Za-z_]\w*:/.test(line)) { section = line.replace(/:.*$/, ''); block = null; continue; }
    if (section === 'connections') {
      const m = line.match(/^-\s*\[(.*)\]\s*$/);
      if (m) {
        const [from, fromPort, to, toPort] = m[1].split(',').map(scalar);
        connections.push({ from, fromPort, to, toPort });
      }
      continue;
    }
    if (section !== 'blocks') continue;
    let m;
    if ((m = line.match(/^- name:\s*(.+)$/))) { block = { name: scalar(m[1]), id: '', parameters: {}, state: 'enabled' }; blocks.push(block); sub = null; continue; }
    if (!block) continue;
    if ((m = line.match(/^ {2}id:\s*(.+)$/))) { block.id = scalar(m[1]); continue; }
    if ((m = line.match(/^ {2}(parameters|states):\s*$/))) { sub = m[1]; continue; }
    if ((m = line.match(/^ {4}([A-Za-z_][\w]*):\s?(.*)$/))) {
      let value = m[2];
      // Multi-line quoted scalars (embedded Python source) continue on
      // deeper-indented lines; keep only the first line's text.
      if (/^"/.test(value) && !/[^\\]"\s*$/.test(value)) {
        while (i + 1 < lines.length && /^ {6}/.test(lines[i + 1])) value += ` ${lines[++i].trim()}`;
      }
      if (sub === 'parameters') block.parameters[m[1]] = scalar(value);
      else if (sub === 'states' && m[1] === 'state') block.state = scalar(value);
    }
  }
  const variables = {};
  for (const b of blocks) if (b.id === 'variable') variables[b.name] = b.parameters.value;
  return { blocks: blocks.filter((b) => b.id !== 'variable'), variables, connections };
}

// Evaluates simple variable expressions such as 'samp_rate/(2*math.pi*fsk_deviation_hz)'.
export function evaluate(expr, variables, depth = 0) {
  if (expr == null || depth > 8) return NaN;
  const source = String(expr).replace(/math\.pi/g, 'PI').replace(/[A-Za-z_]\w*/g, (name) => {
    if (name === 'PI') return String(Math.PI);
    if (name in variables) return `(${evaluate(variables[name], variables, depth + 1)})`;
    return name;
  });
  if (!/^[\d\s.eE+\-*/()]+$/.test(source)) return NaN;
  try { return Function(`"use strict"; return (${source});`)(); } catch { return NaN; }
}

// For each enabled source block: the longest path through the enabled blocks
// (the signal chain) and the blocks that branch off it (GUI sinks, taps).
export function signalChains(graph) {
  const enabled = new Set(graph.blocks.filter((b) => b.state !== 'disabled').map((b) => b.name));
  const edges = graph.connections.filter((c) => enabled.has(c.from) && enabled.has(c.to));
  const next = (name) => edges.filter((e) => e.from === name).map((e) => e.to);
  const byName = new Map(graph.blocks.map((b) => [b.name, b]));
  const longest = (name, seen = new Set()) => {
    let best = [];
    for (const to of next(name)) if (!seen.has(to)) {
      const path = longest(to, new Set([...seen, to]));
      if (path.length > best.length) best = path;
    }
    return [name, ...best];
  };
  const sources = [...enabled].filter((name) => !edges.some((c) => c.to === name));
  return sources.map((source) => {
    const main = longest(source);
    const taps = main.flatMap((name) => next(name).filter((to) => !main.includes(to)).map((to) => ({ from: name, block: byName.get(to) })));
    return { main: main.map((name) => byName.get(name)), taps };
  });
}
