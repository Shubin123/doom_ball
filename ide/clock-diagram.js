// Reads the selected board's clock setup source and renders its derived tree.
class ClockDiagram {
  constructor(root) { this.root = root; }

  number(source, pattern, label) {
    const match = source.match(pattern);
    if (!match) throw new Error(`Could not read ${label} from the board clock source.`);
    return Number(match[1]);
  }

  divider(source, field, label) {
    const match = source.match(new RegExp(`${field}\\s*=\\s*RCC_[A-Z0-9_]*DIV(\\d+)`));
    if (!match) throw new Error(`Could not read ${label} divider from the board clock source.`);
    return Number(match[1]);
  }

  async show({ target, readSource }) {
    this.root.innerHTML = '<div class="clock-loading">Reading board clock configuration…</div>';
    const path = `firmware/targets/${['bluepill', 'f401'].includes(target) ? target : 'h743'}/board.c`;
    const source = await readSource(path);
    if (typeof source !== 'string') throw new Error(`Could not load ${path}`);
    try {
      if (target === 'bluepill') this.renderBluePill(source, path);
      else if (target === 'f401') this.renderF401(source, path);
      else this.renderH743(source, path);
    } catch (error) {
      this.root.innerHTML = '';
      const message = document.createElement('p'); message.className = 'clock-error'; message.textContent = error.message;
      this.root.appendChild(message);
    }
  }

  renderH743(source, path) {
    const m = this.number(source, /osc\.PLL\.PLLM\s*=\s*(\d+)/, 'PLL M');
    const n = this.number(source, /osc\.PLL\.PLLN\s*=\s*(\d+)/, 'PLL N');
    const p = this.number(source, /osc\.PLL\.PLLP\s*=\s*(\d+)/, 'PLL P');
    const q = this.number(source, /osc\.PLL\.PLLQ\s*=\s*(\d+)/, 'PLL Q');
    const hsi = /osc\.HSIState\s*=\s*RCC_HSI_DIV1/.test(source) ? 64 : 32;
    const vco = hsi / m * n, sysclk = vco / p, hclk = sysclk / this.divider(source, 'clk\.AHBCLKDivider', 'AHB');
    const apb = ['APB3','APB1','APB2','APB4'].map((bus) => [bus, hclk / this.divider(source, `clk\\.${bus}CLKDivider`, bus)]);
    const pllq = vco / q;
    this.root.innerHTML = `<div class="clock-source mono"></div><div class="clock-tree">
      <div class="clock-node source"><small>HSI input</small><b>${hsi} MHz</b><span>internal oscillator</span></div><i class="clock-arrow">→</i>
      <div class="clock-node"><small>PLL1 M</small><b>÷ ${m}</b><span>${(hsi/m).toFixed(2)} MHz reference</span></div><i class="clock-arrow">→</i>
      <div class="clock-node"><small>PLL1 VCO</small><b>× ${n}</b><span>${vco.toFixed(2)} MHz</span></div>
      <div class="clock-branches"><div class="clock-branch"><i class="clock-arrow">↓</i><div class="clock-node primary"><small>PLL1 P · SYSCLK</small><b>÷ ${p} · ${sysclk.toFixed(2)} MHz</b><span>core clock</span></div><i class="clock-arrow">↓</i>
      <div class="clock-node"><small>AHB prescaler</small><b>÷ ${sysclk/hclk}</b><span>HCLK ${hclk.toFixed(2)} MHz</span></div>
      <div class="clock-buses">${apb.map(([bus, hz]) => `<div class="clock-node"><small>${bus} prescaler</small><b>PCLK ${hz.toFixed(2)} MHz</b><span>from HCLK</span></div>`).join('')}</div></div>
      <div class="clock-branch aux"><i class="clock-arrow">↓</i><div class="clock-node"><small>PLL1 Q</small><b>÷ ${q} · ${pllq.toFixed(2)} MHz</b><span>peripheral kernel clock</span></div></div></div>
      </div><p class="clock-note">Values are calculated from the current C source. Edit <code>${path}</code> and reopen the diagram to refresh.</p>`;
    this.root.querySelector('.clock-source').textContent = path;
  }

  renderBluePill(source, path) {
    const hseMult = this.number(source, /RCC_CFGR_PLLMULL(\d+)/, 'HSE PLL multiplier');
    const hse = this.number(source, /(\d+)\s*MHz HSE x/, 'external oscillator frequency');
    const hsiMult = [...source.matchAll(/RCC_CFGR_PLLMULL(\d+)/g)].map((match) => Number(match[1])).find((value) => value !== hseMult);
    if (!hsiMult) throw new Error('Could not read HSI fallback multiplier from the board clock source.');
    const hseSys = hse * hseMult, hsiSys = (hse / 2) * hsiMult;
    this.root.innerHTML = `<div class="clock-source mono"></div><div class="clock-tree f1-tree">
      <div class="clock-branch"><div class="clock-node source"><small>HSE crystal</small><b>${hse} MHz</b><span>normal startup path</span></div><i class="clock-arrow">→</i><div class="clock-node"><small>PLL × ${hseMult}</small><b>SYSCLK ${hseSys} MHz</b><span>maximum HCLK</span></div><i class="clock-arrow">→</i><div class="clock-node"><small>APB1 ÷ 2</small><b>${hseSys/2} MHz</b><span>peripheral bus</span></div></div>
      <div class="clock-branch"><div class="clock-node source"><small>HSI fallback</small><b>${hse/2} MHz</b><span>internal / 2</span></div><i class="clock-arrow">→</i><div class="clock-node"><small>PLL × ${hsiMult}</small><b>SYSCLK ${hsiSys} MHz</b><span>when HSE is absent</span></div><i class="clock-arrow">→</i><div class="clock-node"><small>APB1 ÷ 2</small><b>${hsiSys/2} MHz</b><span>peripheral bus</span></div></div>
      </div><p class="clock-note">Branches are derived from <code>${path}</code>; runtime selects HSE when ready, otherwise HSI.</p>`;
    this.root.querySelector('.clock-source').textContent = path;
  }

  renderF401(source, path) {
    const hseM = this.number(source, /uint32_t pllm = (\d+);/, 'PLL M for HSE');
    const hsiM = this.number(source, /pllm = (\d+);\s*\/\* 16 MHz HSI/, 'PLL M for HSI');
    const n = this.number(source, /\((\d+)u << RCC_PLLCFGR_PLLN_Pos\)/, 'PLL N');
    const q = this.number(source, /\((\d+)u << RCC_PLLCFGR_PLLQ_Pos\)/, 'PLL Q');
    const pllcfgr = source.match(/RCC->PLLCFGR\s*=([^;]*);/)?.[1] || '';
    const p = 2 + 2 * ((/PLLP_0/.test(pllcfgr) ? 1 : 0) + (/PLLP_1/.test(pllcfgr) ? 2 : 0));
    const apb1 = this.divider(source, 'RCC->CFGR', 'APB1');
    const branch = (label, mhz, note, m) => {
      const vco = mhz / m * n, sys = vco / p;
      return `<div class="clock-branch"><div class="clock-node source"><small>${label}</small><b>${mhz} MHz</b><span>${note}</span></div><i class="clock-arrow">→</i><div class="clock-node"><small>PLL ÷ ${m} × ${n}</small><b>VCO ${vco} MHz</b><span>${mhz / m} MHz reference</span></div><i class="clock-arrow">→</i><div class="clock-node primary"><small>PLL P ÷ ${p}</small><b>SYSCLK ${sys} MHz</b><span>USB ÷ ${q}: ${(vco / q).toFixed(0)} MHz</span></div><i class="clock-arrow">→</i><div class="clock-node"><small>APB1 ÷ ${apb1}</small><b>${sys / apb1} MHz</b><span>USART2 console</span></div></div>`;
    };
    this.root.innerHTML = `<div class="clock-source mono"></div><div class="clock-tree f1-tree">
      ${branch('HSE bypass', 8, 'ST-Link MCO clock', hseM)}
      ${branch('HSI fallback', 16, 'internal RC', hsiM)}
      </div><p class="clock-note">Branches are derived from <code>${path}</code>; runtime uses the ST-Link clock when it starts, otherwise HSI.</p>`;
    this.root.querySelector('.clock-source').textContent = path;
  }
}
