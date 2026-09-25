// A small cooperative C interpreter for the app-level C subset used by these
// STM32 examples. It executes main.c and routes Cube HAL calls to virtual GPIO,
// UART, clock, and LCD peripherals. It is a board model, not a Thumb emulator.
const TYPE_WORDS = new Set([
  'void','char','short','int','long','float','double','signed','unsigned','const','volatile','static',
  'uint8_t','uint16_t','uint32_t','uint64_t','int8_t','int16_t','int32_t','int64_t','size_t',
  'GPIO_PinState','HAL_StatusTypeDef','TaskHandle_t','TickType_t','BaseType_t','UBaseType_t',
]);
const OPERATORS = ['++','--','+=','-=','*=','/=','%=','==','!=','<=','>=','&&','||','<<','>>'];

function unescapeC(value) {
  return value.replace(/\\(x[\da-fA-F]+|[0-7]{1,3}|.)/g, (_, escape) => {
    if (escape[0] === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16));
    if (/^[0-7]/.test(escape)) return String.fromCharCode(parseInt(escape, 8));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', '"': '"', "'": "'" })[escape] ?? escape;
  });
}

function tokenizeC(source, target) {
  const active = [];
  let enabled = true;
  const macros = new Map();
  if (target !== 'bluepill') macros.set('USE_HAL_DRIVER',1);
  const condition = (expression) => {
    const defined = expression.match(/defined\s*(?:\(\s*(\w+)\s*\)|(\w+))/);
    if (defined) return macros.has(defined[1] || defined[2]) !== /^\s*!/.test(expression);
    const number = expression.match(/^\s*[!(]?\s*(0x[\da-f]+|\d+)\s*[uUlL)]*\s*$/i);
    if (number) return Number.parseInt(number[1], number[1].toLowerCase().startsWith('0x') ? 16 : 10) !== 0;
    const name = expression.trim();
    return macros.has(name) ? Boolean(macros.get(name)) : true;
  };
  const processed = String(source).split(/\r?\n/).map((line) => {
    const directive = line.match(/^\s*#\s*(if|ifdef|ifndef|elif|else|endif|define|undef)\b(.*)$/);
    if (!directive) return enabled && !/^\s*#/.test(line) ? line : '';
    const [kind, tail] = [directive[1], directive[2].trim()];
    if (kind === 'define' && enabled) {
      const match = tail.match(/^([A-Za-z_]\w*)(.*)$/);
      if (match && !match[2].startsWith('(')) {
        const raw = match[2].trim();
        const string = raw.match(/^"((?:\\.|[^"\\])*)"$/);
        const number = raw.match(/^\(?\s*(0x[\da-f]+|\d+)\s*[uUlL]*\s*\)?$/i);
        const val = string ? unescapeC(string[1]) : number ? Number.parseInt(number[1], number[1].toLowerCase().startsWith('0x') ? 16 : 10) : raw;
        macros.set(match[1], val);
      }
    } else if (kind === 'undef' && enabled) macros.delete(tail);
    else if (kind === 'if' || kind === 'ifdef' || kind === 'ifndef') {
      const conditionValue = kind === 'ifdef' ? macros.has(tail) : kind === 'ifndef' ? !macros.has(tail) : condition(tail);
      active.push({ parent: enabled, condition: conditionValue, taken: conditionValue }); enabled = enabled && conditionValue;
    } else if (kind === 'elif' && active.length) {
      const state = active.at(-1); const next = !state.taken && condition(tail); state.taken ||= next; enabled = state.parent && next;
    } else if (directive[1] === 'else' && active.length) {
      const state = active.at(-1); enabled = state.parent && !state.taken; state.taken = true;
    } else if (kind === 'endif' && active.length) {
      const state = active.pop(); enabled = state.parent;
    }
    return '';
  }).join('\n');
  const clean = processed.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const tokens = [];
  const re = /\s+|(?:u8|u|U|L)?"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?)(?:[uUlLfF]+)?|[A-Za-z_$][\w$]*|\+\+|--|\+=|-=|\*=|\/=|%=|==|!=|<=|>=|&&|\|\||<<|>>|[^\s]/gy;
  let match;
  while ((match = re.exec(clean))) {
    const raw = match[0];
    if (/^\s/.test(raw)) continue;
    if (/^(u8|u|U|L)?"/.test(raw)) tokens.push({ kind: 'string', value: unescapeC(raw.slice(raw.indexOf('"') + 1, -1)) });
    else if (raw[0] === "'") tokens.push({ kind: 'number', value: unescapeC(raw.slice(1, -1)).charCodeAt(0) || 0 });
    else if (/^(?:0[xX]|\d)/.test(raw)) tokens.push({ kind: 'number', value: Number.parseInt(raw.replace(/[uUlLfF]+$/, ''), raw.startsWith('0x') || raw.startsWith('0X') ? 16 : 10) || 0 });
    else tokens.push({ kind: 'id', value: raw });
  }
  const values = Object.fromEntries(macros);
  for (let pass = 0; pass < 3; pass++) for (const [key,value] of Object.entries(values)) {
    if (typeof value === 'string' && Object.hasOwn(values,value)) values[key] = values[value];
  }
  tokens.macros = values;
  return tokens;
}

const PRECEDENCE = { '=':1, '+=':1, '-=':1, '*=':1, '/=':1, '%=':1, '||':2, '&&':3, '|':4, '^':5, '&':6,
  '==':7, '!=':7, '<':8, '<=':8, '>':8, '>=':8, '<<':9, '>>':9, '+':10, '-':10, '*':11, '/':11, '%':11 };

class CParser {
  constructor(tokens) { this.t = tokens; this.i = 0; }
  peek(n = 0) { return this.t[this.i + n]?.value; }
  take() { return this.t[this.i++]; }
  eat(value) { if (this.peek() === value) { this.i++; return true; } return false; }
  need(value) { if (!this.eat(value)) throw new Error(`Expected '${value}', found '${this.peek() ?? 'end of file'}'`); }
  matching(open, close, at = this.i) {
    let depth = 0;
    for (let i = at; i < this.t.length; i++) {
      if (this.t[i].value === open) depth++;
      if (this.t[i].value === close && --depth === 0) return i;
    }
    return -1;
  }
  functionTable() {
    const functions = new Map();
    for (let i = 0; i < this.t.length - 2;) {
      if (this.t[i].kind !== 'id' || this.t[i + 1]?.value !== '(' || ['if','while','for','switch','sizeof'].includes(this.t[i].value)) { i++; continue; }
      const close = this.matching('(', ')', i + 1);
      if (close < 0) break;
      let body = close + 1;
      while (this.t[body]?.value === '__attribute__') body++;
      if (this.t[body]?.value !== '{') { i = close + 1; continue; }
      const name = this.t[i].value;
      const params = this.t.slice(i + 2, close).filter((token) => token.kind === 'id' && !TYPE_WORDS.has(token.value)).map((token) => token.value);
      this.i = body;
      const ast = this.block();
      functions.set(name, { params, ast });
      i = this.i;
    }
    return functions;
  }
  block() {
    this.need('{'); const body = [];
    while (this.peek() !== '}' && this.i < this.t.length) body.push(this.statement());
    this.need('}');
    return { type: 'block', body };
  }
  statement() {
    if (this.peek() === '{') return this.block();
    if (this.eat('if')) {
      this.need('('); const test = this.expression(); this.need(')');
      const yes = this.statement(); const no = this.eat('else') ? this.statement() : null;
      return { type: 'if', test, yes, no };
    }
    if (this.eat('while')) { this.need('('); const test = this.expression(); this.need(')'); return { type: 'while', test, body: this.statement() }; }
    if (this.eat('for')) {
      this.need('(');
      const init = this.peek() === ';' ? null : this.declarationOrExpression(true);
      this.need(';');
      const test = this.peek() === ';' ? null : this.expression(); this.need(';');
      const step = this.peek() === ')' ? null : this.expression(); this.need(')');
      return { type: 'for', init, test, step, body: this.statement() };
    }
    if (this.eat('return')) { const value = this.peek() === ';' ? null : this.expression(); this.need(';'); return { type: 'return', value }; }
    if (this.eat('break')) { this.need(';'); return { type: 'break' }; }
    if (this.eat('continue')) { this.need(';'); return { type: 'continue' }; }
    return this.declarationOrExpression(false);
  }
  declarationOrExpression(inFor) {
    if (TYPE_WORDS.has(this.peek())) {
      while (TYPE_WORDS.has(this.peek())) this.take();
      while (this.eat('*')) {}
      const decls = [];
      do {
        const name = this.take()?.value;
        if (!name) throw new Error('Expected a variable name');
        let array = false;
        if (this.eat('[')) { array = true; if (this.peek() !== ']') this.expression(); this.need(']'); }
        let init = null;
        if (this.eat('=')) {
          if (array && this.eat('{')) {
            init = [];
            while (this.peek() !== '}') {
              init.push(this.expression());
              if (!this.eat(',')) break;
            }
            this.need('}');
          } else init = this.expression();
        }
        decls.push({ name, init, array });
      } while (this.eat(','));
      if (!inFor) this.need(';');
      return { type: 'declare', decls };
    }
    const expr = this.expression();
    if (!inFor) this.need(';');
    return { type: 'expr', expr };
  }
  expression(min = 1) {
    let left = this.prefix();
    for (;;) {
      if (this.peek() === '?' && min <= 2) {
        this.take(); const yes = this.expression(); this.need(':'); const no = this.expression(2);
        left = { type: 'conditional', test: left, yes, no }; continue;
      }
      const op = this.peek(), prec = PRECEDENCE[op];
      if (!prec || prec < min) break;
      this.take(); const right = this.expression(prec + (prec === 1 ? 0 : 1));
      left = { type: 'binary', op, left, right };
    }
    return left;
  }
  prefix() {
    const op = this.peek();
    if (['!','-','+','~','&','*','++','--'].includes(op)) { this.take(); return { type: 'unary', op, value: this.prefix() }; }
    if (op === 'sizeof') { this.take(); return { type: 'sizeof', value: this.prefix() }; }
    let node;
    if (this.eat('(')) {
      const save = this.i;
      while (TYPE_WORDS.has(this.peek()) || this.peek() === '*') this.take();
      if (this.eat(')') && save !== this.i - 1) node = { type: 'cast', value: this.prefix() };
      else { this.i = save; node = this.expression(); this.need(')'); }
    } else {
      const token = this.take();
      if (!token) throw new Error('Unexpected end of expression');
      if (token.kind === 'number' || token.kind === 'string') node = { type: 'literal', value: token.value };
      else if (this.eat('(')) {
        const args = [];
        if (this.peek() !== ')') do { args.push(this.expression()); } while (this.eat(','));
        this.need(')'); node = { type: 'call', name: token.value, args };
      } else node = { type: 'identifier', name: token.value };
    }
    for (;;) {
      if (this.eat('[')) { const index = this.expression(); this.need(']'); node = { type: 'index', target: node, index }; }
      else if (this.eat('++')) node = { type: 'postfix', op: '++', value: node };
      else if (this.eat('--')) node = { type: 'postfix', op: '--', value: node };
      else break;
    }
    return node;
  }
}

class Scope {
  constructor(parent = null) { this.parent = parent; this.values = new Map(); this.task = parent?.task || null; }
  has(name) { return this.values.has(name) || Boolean(this.parent?.has(name)); }
  get(name) { return this.values.has(name) ? this.values.get(name) : this.parent?.get(name); }
  set(name, value) { if (this.values.has(name)) this.values.set(name, value); else if (this.parent?.has(name)) this.parent.set(name, value); else this.values.set(name, value); return value; }
  declare(name, value) { this.values.set(name, value); }
}

const pointer = (scope, name) => ({ __pointer: true, scope, name });
const truth = (value) => Boolean(value);

export class CBoardSimulation {
  constructor(source, { target = 'h743', definitions = [], onOutput = () => {}, onLed = () => {}, onLcd = () => {}, onStatus = () => {}, onHostTx = () => {}, onRtos = () => {}, speed = 1 } = {}) {
    this.source = source; this.target = target; this.definitions = definitions; this.cb = { onOutput, onLed, onLcd, onStatus, onHostTx, onRtos };
    this.speed = speed; this.running = false; this.paused = false; this.led = false; this.lcdColor = 0;
    this.buttonDown = false; this.input = []; this.waitingRx = []; this.delayWaiters = new Map(); this.epoch = 0; this.tickEpoch = 0; this.steps = 0;
    this.rtosTasks = []; this.schedulerStarted = false; this.schedulerWaiter = null;
    this.macros = { GPIO_PIN_RESET:0, GPIO_PIN_SET:1, HAL_OK:0, HAL_ERROR:1, HAL_MAX_DELAY:0xffffffff,
      LED_PORT:'GPIOC', LED_PIN:0x2000, BUTTONS_PORT:'GPIOE', BTN_FIRE_PIN:0x10,
      BOARD_NAME:target === 'bluepill' ? 'STM32F103C8T6 Blue Pill' : 'STM32H743IITx',
      SystemCoreClock:target === 'bluepill' ? 72000000 : 400000000, huart1:'USART1', GPIOA:'GPIOA', GPIOB:'GPIOB', GPIOC:'GPIOC', GPIOE:'GPIOE', NULL:0, pdTRUE:1, pdFALSE:0, pdPASS:1 };
  }
  async start() {
    const parser = new CParser(tokenizeC(this.source,this.target));
    Object.assign(this.macros, parser.t.macros);
    for (const header of this.definitions) Object.assign(this.macros, tokenizeC(header,this.target).macros);
    this.functions = parser.functionTable();
    if (!this.functions.has('main')) throw new Error('No main() function found in the selected C source.');
    this.running = true; this.paused = false; this.epoch++; this.tickEpoch = performance.now(); this.scope = new Scope();
    this.cb.onStatus('Running main.c');
    try { await this.callFunction('main', []); }
    catch (error) { if (this.running) this.cb.onStatus(`Simulation stopped: ${error.message}`); }
    if (this.running && this.schedulerStarted) this.cb.onStatus('FreeRTOS scheduler running');
    else if (this.running) { this.running = false; this.cb.onStatus('main() returned'); }
  }
  stop() {
    this.running = false;
    this.schedulerWaiter?.(); this.schedulerWaiter = null;
    for (const resolve of this.waitingRx.splice(0)) resolve(null);
    for (const [timer, resolve] of this.delayWaiters) { clearTimeout(timer); resolve(); }
    this.delayWaiters.clear();
    this.cb.onStatus('Stopped');
  }
  setSpeed(speed) { this.speed = Math.max(0.25, Math.min(4, Number(speed) || 1)); }
  tick() { return Math.floor((performance.now() - this.tickEpoch) * this.speed); }
  pressButton(down) { this.buttonDown = down; }
  sendSerial(text) {
    const bytes = new TextEncoder().encode(text);
    this.cb.onHostTx(text);
    for (const byte of bytes) this.enqueueByte(byte);
  }
  enqueueByte(byte) {
    const waiting = this.waitingRx.shift();
    if (waiting) waiting(byte); else this.input.push(byte);
  }
  async cooperate() {
    if (++this.steps % 160 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    if (!this.running) throw new Error('stopped');
  }
  async callFunction(name, args, callerScope = this.scope) {
    const fn = this.functions.get(name);
    if (!fn) return this.builtin(name, args, callerScope);
    const scope = new Scope(callerScope);
    scope.task = callerScope?.task || null;
    fn.params.forEach((param, i) => scope.declare(param, args[i]));
    const prior = this.scope; this.scope = scope;
    const signal = await this.execute(fn.ast);
    this.scope = prior;
    return signal?.type === 'return' ? signal.value : undefined;
  }
  async execute(stmt, scope = this.scope) {
    if (!stmt) return;
    await this.cooperate();
    if (stmt.type === 'block') {
      const local = new Scope(scope);
      for (const child of stmt.body) { const signal = await this.execute(child, local); if (signal) return signal; }
    } else if (stmt.type === 'declare') {
      for (const decl of stmt.decls) {
        let value = decl.init ? await this.evaluateInitializer(decl.init, scope) : 0;
        scope.declare(decl.name, value);
      }
    } else if (stmt.type === 'expr') await this.evalExpr(stmt.expr, scope);
    else if (stmt.type === 'if') return truth(await this.evalExpr(stmt.test, scope)) ? this.execute(stmt.yes, scope) : this.execute(stmt.no, scope);
    else if (stmt.type === 'while') {
      while (truth(await this.evalExpr(stmt.test, scope))) { const signal = await this.execute(stmt.body, scope); if (signal?.type === 'break') break; if (signal?.type === 'return') return signal; }
    } else if (stmt.type === 'for') {
      const local = new Scope(scope);
      if (stmt.init) await this.execute(stmt.init, local);
      while (!stmt.test || truth(await this.evalExpr(stmt.test, local))) {
        const signal = await this.execute(stmt.body, local);
        if (signal?.type === 'break') break;
        if (signal?.type === 'return') return signal;
        if (stmt.step) await this.evalExpr(stmt.step, local);
      }
    } else if (stmt.type === 'return') return { type:'return', value:stmt.value ? await this.evalExpr(stmt.value, scope) : undefined };
    else if (stmt.type === 'break' || stmt.type === 'continue') return { type:stmt.type };
  }
  async evaluateInitializer(node, scope) {
    if (Array.isArray(node)) { const out=[]; for (const v of node) out.push(await this.evalExpr(v,scope)); return out; }
    return this.evalExpr(node, scope);
  }
  async evalExpr(node, scope) {
    if (!node) return 0;
    if (node.type === 'literal') return node.value;
    if (node.type === 'cast') return this.evalExpr(node.value, scope);
    if (node.type === 'identifier') return scope.has(node.name) ? scope.get(node.name) : (this.macros[node.name] ?? node.name);
    if (node.type === 'sizeof') { const value = await this.evalExpr(node.value, scope); return typeof value === 'string' ? new TextEncoder().encode(value).length + 1 : Array.isArray(value) ? value.length * 4 : 4; }
    if (node.type === 'conditional') return truth(await this.evalExpr(node.test, scope)) ? this.evalExpr(node.yes, scope) : this.evalExpr(node.no, scope);
    if (node.type === 'index') { const target = await this.evalExpr(node.target, scope); const index = await this.evalExpr(node.index, scope); return target?.[index] ?? 0; }
    if (node.type === 'unary') {
      if (node.op === '&' && node.value.type === 'identifier') return pointer(scope, node.value.name);
      const v = await this.evalExpr(node.value, scope);
      if (node.op === '!') return !truth(v) ? 1 : 0;
      if (node.op === '-') return -Number(v); if (node.op === '+') return Number(v); if (node.op === '~') return ~Number(v);
      if (node.op === '++' || node.op === '--') return this.assign(node.value, scope, Number(v) + (node.op === '++' ? 1 : -1));
      if (node.op === '*') return v?.__pointer ? v.scope.get(v.name) : v;
    }
    if (node.type === 'postfix') {
      const old = await this.evalExpr(node.value, scope);
      this.assign(node.value, scope, Number(old) + (node.op === '++' ? 1 : -1)); return old;
    }
    if (node.type === 'call') {
      const args=[]; for (const arg of node.args) args.push(await this.evalExpr(arg, scope));
      return this.callFunction(node.name, args, scope);
    }
    if (node.type === 'binary') {
      if (node.op === '=') return this.assign(node.left, scope, await this.evalExpr(node.right, scope));
      if (['+=','-=','*=','/=','%='].includes(node.op)) {
        const left = await this.evalExpr(node.left, scope), right = await this.evalExpr(node.right, scope);
        const op = node.op[0]; return this.assign(node.left, scope, this.binary(op,left,right));
      }
      const left = await this.evalExpr(node.left, scope);
      if (node.op === '&&' && !truth(left)) return 0;
      if (node.op === '||' && truth(left)) return 1;
      return this.binary(node.op,left,await this.evalExpr(node.right,scope));
    }
    return 0;
  }
  assign(node, scope, value) {
    if (node.type === 'identifier') return scope.set(node.name,value);
    if (node.type === 'unary' && node.op === '*') { const ptr=node.value; if (ptr.__pointer) return ptr.scope.set(ptr.name,value); }
    if (node.type === 'index') { const target=this.readLvalue(node.target,scope), index=node.index.value; target[index]=value; return value; }
    throw new Error('Unsupported C assignment target');
  }
  readLvalue(node, scope) { return node.type === 'identifier' ? scope.get(node.name) : null; }
  binary(op,a,b) {
    switch(op) {
      case '+': return typeof a === 'string' ? a + b : Number(a)+Number(b); case '-': return Number(a)-Number(b); case '*': return Number(a)*Number(b);
      case '/': return Math.trunc(Number(a)/Number(b)); case '%': return Number(a)%Number(b); case '==': return a===b || Number(a)===Number(b) ? 1:0;
      case '!=': return a!==b && Number(a)!==Number(b) ? 1:0; case '<': return Number(a)<Number(b)?1:0; case '<=': return Number(a)<=Number(b)?1:0;
      case '>': return Number(a)>Number(b)?1:0; case '>=': return Number(a)>=Number(b)?1:0; case '&&': return truth(a)&&truth(b)?1:0; case '||': return truth(a)||truth(b)?1:0;
      case '&': return Number(a)&Number(b); case '|': return Number(a)|Number(b); case '^': return Number(a)^Number(b); case '<<': return Number(a)<<Number(b); case '>>': return Number(a)>>Number(b);
      default: return 0;
    }
  }
  format(format, values) {
    let i=0;
    return String(format).replace(/%%|%[-+#0 ]*\d*(?:\.\d+)?(?:hh|h|ll|l|z)?[diuoxXfFeEgGaAcsp]/g, (spec) => {
      if (spec === '%%') return '%';
      const value=values[i++]; const conv=spec.at(-1);
      if (conv==='s') return String(value);
      if (conv==='c') return String.fromCharCode(Number(value));
      if (conv==='x' || conv==='X') return Number(value).toString(16)[conv==='X'?'toUpperCase':'toLowerCase']();
      if ('diu'.includes(conv)) return String(Number(value));
      return String(value);
    });
  }
  async receiveByte() {
    if (this.input.length) return this.input.shift();
    return new Promise((resolve) => this.waitingRx.push(resolve));
  }
  emit(text) { this.cb.onOutput(String(text)); }
  async builtin(name, a, scope = this.scope) {
    switch(name) {
      case 'HAL_Init': case 'SystemClock_Config': case 'MX_GPIO_Init': case 'MX_USART1_UART_Init': case 'board_init': case 'MX_SPI1_Init': case 'lcd_init': return 0;
      case 'HAL_GetTick': case 'millis': return this.tick();
      case 'HAL_Delay': case 'delay_ms': {
        const ms=Math.max(0,Number(a[0])||0), epoch=this.epoch;
        if (this.speed > 0 && ms) await new Promise((resolve)=>{
          const timer=setTimeout(()=>{this.delayWaiters.delete(timer);resolve();},Math.max(0,ms/this.speed));
          this.delayWaiters.set(timer,resolve);
        });
        if (!this.running || epoch!==this.epoch) throw new Error('stopped');
        return 0;
      }
      case 'xTaskCreate': {
        const task = { function: String(a[0]), name: String(a[1]), argument: a[3], priority: Number(a[4]) || 0, state: 'Ready' };
        this.rtosTasks.push(task);
        this.cb.onRtos({ type: 'create', task: { name: task.name, priority: task.priority, state: task.state } });
        if (a[5]?.__pointer) a[5].scope.set(a[5].name, task.name);
        return 1;
      }
      case 'vTaskStartScheduler': {
        this.schedulerStarted = true;
        this.cb.onRtos({ type: 'scheduler', state: 'Running' });
        for (const task of this.rtosTasks) {
          task.state = 'Running';
          const taskScope = new Scope(scope); taskScope.task = task;
          this.cb.onRtos({ type: 'state', name: task.name, state: task.state });
          void this.callFunction(task.function, [task.argument], taskScope).catch((error) => {
            if (this.running) this.cb.onStatus(`RTOS task ${task.name}: ${error.message}`);
          });
        }
        return new Promise((resolve) => { this.schedulerWaiter = resolve; });
      }
      case 'vTaskDelay': {
        const task = scope?.task;
        if (task) { task.state = 'Blocked'; this.cb.onRtos({ type: 'state', name: task.name, state: task.state }); }
        const result = await this.builtin('HAL_Delay', [Number(a[0])], scope);
        if (task && this.running) { task.state = 'Running'; this.cb.onRtos({ type: 'state', name: task.name, state: task.state }); }
        return result;
      }
      case 'xTaskGetTickCount': return this.tick();
      case 'HAL_GPIO_TogglePin': case 'led_toggle': this.led=!this.led; this.cb.onLed(this.led); return 0;
      case 'HAL_GPIO_WritePin': this.led=Number(a[2])===0; this.cb.onLed(this.led); return 0;
      case 'HAL_GPIO_ReadPin': case 'buttons_read': return this.buttonDown ? 0 : 1;
      case 'printf': this.emit(this.format(a[0]??'',a.slice(1)).replace(/\n/g,'\r\n')); return 0;
      case 'puts': this.emit(`${a[0]??''}\r\n`); return 0;
      case 'HAL_UART_Transmit': {
        const data=a[1], length=Number(a[2])||0;
        let text='';
        if (typeof data==='string') text=new TextDecoder().decode(new TextEncoder().encode(data).subarray(0,length));
        else if (Array.isArray(data)) text=String.fromCharCode(...data.slice(0,length).map(Number));
        else if (data?.__pointer) text=String.fromCharCode(Number(data.scope.get(data.name))||0);
        this.emit(text); return 0;
      }
      case 'HAL_UART_Receive': {
        const byte=await this.receiveByte(); if (byte==null) return 1;
        const data=a[1];
        if (data?.__pointer) data.scope.set(data.name,byte);
        else if (Array.isArray(data)) data[0]=byte;
        return 0;
      }
      case 'console_write': {
        const data=a[0]; const len=Number(a[1])||0;
        this.emit(typeof data==='string'?data.slice(0,len):String(data)); return 0;
      }
      case 'console_getc': return this.input.length ? this.input.shift() : -1;
      case 'HAL_Delay_ms': return this.builtin('HAL_Delay',a);
      case 'lcd_fill': this.lcdColor=Number(a[0])&0xffff; this.cb.onLcd(this.lcdColor); return 0;
      case 'board_panic': throw new Error(`board panic: ${a[0]}`);
      default: throw new Error(`Unsupported C/HAL function: ${name}`);
    }
  }
}
