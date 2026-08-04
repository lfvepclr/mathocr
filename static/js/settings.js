/* ============================================================
   Settings — engine picker, settings modal, usage & cost display
   ============================================================ */

const Settings = {
  engines: [],
  defaultEngine: 'local',
  selected: null,
  usageScope: 'today',

  // Fallback names for the brief window before /api/engines resolves —
  // the sidebar renders batches before the engine list is available.
  ENGINE_NAMES: {
    local: '本地 PaddleOCR-VL-1.6',
    siliconflow: '硅基流动 PaddleOCR-VL',
    baidu: '百度文档解析',
  },

  async init() {
    this.bindModal();
    this.bindUsageScope();
    await this.loadEngines();
    this.refreshUsage();
  },

  // ---- Engine list & picker ----
  async loadEngines() {
    try {
      const resp = await fetch('/api/engines');
      const data = await resp.json();
      this.engines = data.engines || [];
      this.defaultEngine = data.default || 'local';
    } catch (err) {
      console.error('Failed to load engines:', err);
      this.engines = [];
    }

    // Restore the last choice, falling back to the server default when the
    // stored engine no longer exists or lost its credentials.
    const stored = localStorage.getItem('ocrEngine');
    const usable = this.engines.find(e => e.id === stored && e.configured);
    this.selected = usable ? stored : this.defaultEngine;

    this.renderPicker();
    this.renderNote();
  },

  engine(id = this.selected) {
    return this.engines.find(e => e.id === id) || null;
  },

  engineName(id) {
    const engine = this.engine(id);
    return (engine && engine.name) || this.ENGINE_NAMES[id] || id;
  },

  renderPicker() {
    const host = document.getElementById('engine-select');
    if (!host) return;
    host.innerHTML = this.engines.map(e => `
      <button class="engine-option${e.id === this.selected ? ' active' : ''}${e.configured ? '' : ' unconfigured'}"
              data-engine="${e.id}" title="${e.configured ? e.note : (e.requires_key ? '未配置 API Key' : e.note)}">
        <span class="engine-option-name">${e.name}</span>
        <span class="engine-option-tag">${this.billingLabel(e)}</span>
      </button>
    `).join('');

    host.querySelectorAll('.engine-option').forEach(btn => {
      btn.addEventListener('click', () => this.select(btn.dataset.engine));
    });
  },

  billingLabel(engine) {
    if (!engine.configured) return engine.requires_key ? '未配置' : '不可用';
    if (engine.billing === 'free') return '本地免费';
    if (engine.billing === 'token') {
      const p = engine.price || {};
      if (!p.price_in && !p.price_out) return '在线 · 免费';
      return `在线 · ¥${p.price_in}/¥${p.price_out} 每 1M tokens`;
    }
    if (engine.billing === 'page') {
      const p = engine.price || {};
      if (!p.price_per_page) return '在线 · 未配置单价';
      return `在线 · ¥${p.price_per_page}/页`;
    }
    return '在线';
  },

  select(id) {
    const engine = this.engine(id);
    if (!engine) return;
    if (!engine.configured) {
      // Key-based engines can be fixed in the settings modal; a missing
      // local runtime (no paddle) cannot — just show the note.
      if (engine.requires_key) this.open();
      return;
    }
    this.selected = id;
    localStorage.setItem('ocrEngine', id);
    this.renderPicker();
    this.renderNote();
    this.clearEstimate();
  },

  renderNote() {
    const host = document.getElementById('engine-note');
    if (!host) return;
    const engine = this.engine();
    if (!engine) { host.innerHTML = ''; return; }

    const limits = (engine.limitations || []).length
      ? `<ul class="engine-limits">${engine.limitations.map(l => `<li>${l}</li>`).join('')}</ul>`
      : '';
    const warn = engine.configured
      ? ''
      : '<p class="engine-warn">该引擎未配置 API Key，点击「配置」填写后才能使用。</p>';
    host.innerHTML = `<p class="engine-desc">${engine.note}</p>${limits}${warn}`;
  },

  // ---- Cost estimate (published once the page count is known) ----
  showEstimate(data) {
    const host = document.getElementById('cost-estimate');
    if (!host) return;
    const name = this.engineName(data.engine);
    let costText;
    if (data.estimated_cost === null || data.estimated_cost === undefined) {
      costText = data.note || '无法预估';
    } else if (data.estimated_cost === 0) {
      costText = data.note || '免费';
    } else {
      costText = `约 ¥${Number(data.estimated_cost).toFixed(4)}`;
    }
    host.innerHTML = `<span class="cost-estimate-label">${name} · ${data.pages} 页</span>
                      <span class="cost-estimate-value">${costText}</span>`;
    host.style.display = 'flex';
  },

  clearEstimate() {
    const host = document.getElementById('cost-estimate');
    if (host) host.style.display = 'none';
  },

  // ---- Usage card ----
  bindUsageScope() {
    document.querySelectorAll('.btn-scope').forEach(btn => {
      btn.addEventListener('click', () => {
        this.usageScope = btn.dataset.scope;
        document.querySelectorAll('.btn-scope').forEach(b => {
          b.classList.toggle('active', b === btn);
        });
        this.refreshUsage();
      });
    });
  },

  async refreshUsage() {
    const card = document.getElementById('usage-card');
    const body = document.getElementById('usage-card-body');
    if (!card || !body) return;
    try {
      const resp = await fetch(`/api/usage?scope=${this.usageScope}`);
      const data = await resp.json();
      const rows = data.engines || [];
      if (!rows.length) {
        // Nothing to report until an online engine has actually been used
        card.style.display = 'none';
        return;
      }
      card.style.display = 'block';
      body.innerHTML = `
        <table class="usage-table">
          <thead><tr><th>引擎</th><th>调用次数</th><th>tokens (入/出)</th><th>计费页数</th><th>费用</th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${r.name || r.engine}</td>
                <td>${r.calls}</td>
                <td>${r.prompt_tokens ? `${r.prompt_tokens} / ${r.completion_tokens}` : '—'}</td>
                <td>${r.billed_pages || '—'}</td>
                <td>${this.formatCost(r.cost)}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot><tr>
            <td>合计</td>
            <td>${data.total.calls}</td>
            <td>${data.total.prompt_tokens ? `${data.total.prompt_tokens} / ${data.total.completion_tokens}` : '—'}</td>
            <td>${data.total.billed_pages || '—'}</td>
            <td>${this.formatCost(data.total.cost)}</td>
          </tr></tfoot>
        </table>`;
    } catch (err) {
      console.error('Failed to load usage:', err);
    }
  },

  formatCost(cost) {
    const value = Number(cost || 0);
    if (value === 0) return '¥0.00';
    if (value < 0.01) return `¥${value.toFixed(6)}`;
    return `¥${value.toFixed(4)}`;
  },

  // Called from App's global SSE dispatcher
  onGlobalEvent(type, data) {
    if (type === 'cost_estimated') {
      this.showEstimate(data);
    } else if (type === 'usage_recorded') {
      // Debounce: a multi-page batch fires one event per page
      clearTimeout(this._usageTimer);
      this._usageTimer = setTimeout(() => this.refreshUsage(), 800);
    }
  },

  // ---- Settings modal ----
  bindModal() {
    const modal = document.getElementById('settings-modal');
    const openers = [
      document.getElementById('settings-btn'),
      document.getElementById('engine-settings-link'),
    ];
    openers.forEach(btn => btn && btn.addEventListener('click', (e) => {
      e.preventDefault();
      this.open();
    }));

    ['settings-close', 'settings-cancel'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', () => this.close());
    });
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) this.close();
      });
    }
    const save = document.getElementById('settings-save');
    if (save) save.addEventListener('click', () => this.save());

    // Collapsible engine config cards (AK 配置默认收起,减少干扰)
    document.querySelectorAll('.form-section-head[data-cfg-head]').forEach(head => {
      head.addEventListener('click', () => {
        const body = document.getElementById(`cfg-body-${head.dataset.cfgHead}`);
        if (body) body.classList.toggle('collapsed');
        head.classList.toggle('open');
      });
      // 「获取 Key」链接新标签打开,不触发折叠
      const link = head.querySelector('.cfg-link');
      if (link) link.addEventListener('click', (e) => e.stopPropagation());
    });
  },

  // Reflect configured state on the collapsible card badges
  refreshCfgBadges() {
    ['siliconflow', 'baidu'].forEach(id => {
      const badge = document.getElementById(`cfg-badge-${id}`);
      if (!badge) return;
      const engine = this.engine(id);
      const ok = !!(engine && engine.configured);
      badge.textContent = ok ? '已配置' : '未配置';
      badge.classList.toggle('ok', ok);
    });
  },

  async open() {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;
    this.setStatus('');
    try {
      const resp = await fetch('/api/settings');
      const s = await resp.json();
      this.fillForm(s);
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
    this.refreshCfgBadges();
    modal.style.display = 'flex';
  },

  close() {
    const modal = document.getElementById('settings-modal');
    if (modal) modal.style.display = 'none';
  },

  fillForm(s) {
    const select = document.getElementById('set-default-engine');
    if (select) {
      select.innerHTML = this.engines.map(e =>
        `<option value="${e.id}">${e.name}</option>`).join('');
      select.value = (s.global && s.global.default_engine) || 'local';
    }

    const sf = s.siliconflow || {};
    // Secrets round-trip as masks, so the input stays empty and its
    // placeholder tells the user what is currently stored.
    this.setInput('set-sf-key', '', sf.api_key_configured
      ? `已配置 ${sf.api_key}（留空表示不修改）` : '未配置');
    this.setInput('set-sf-base', sf.base_url);
    this.setInput('set-sf-model', sf.model);
    this.setInput('set-sf-concurrency', sf.max_concurrency);
    this.setInput('set-sf-price-in', sf.price_in);
    this.setInput('set-sf-price-out', sf.price_out);

    const bd = s.baidu || {};
    this.setInput('set-bd-key', '', bd.api_key_configured
      ? `已配置 ${bd.api_key}（留空表示不修改）` : '未配置');
    this.setInput('set-bd-secret', '', bd.secret_key_configured
      ? `已配置 ${bd.secret_key}（留空表示不修改）` : '未配置');
    this.setInput('set-bd-price', bd.price_per_page);
  },

  setInput(id, value, placeholder) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value === undefined || value === null ? '' : value;
    if (placeholder !== undefined) el.placeholder = placeholder;
  },

  val(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  },

  async save() {
    const payload = {
      global: { default_engine: this.val('set-default-engine') },
      siliconflow: {
        api_key: this.val('set-sf-key'),
        base_url: this.val('set-sf-base'),
        model: this.val('set-sf-model'),
        max_concurrency: this.val('set-sf-concurrency'),
        price_in: this.val('set-sf-price-in'),
        price_out: this.val('set-sf-price-out'),
      },
      baidu: {
        api_key: this.val('set-bd-key'),
        secret_key: this.val('set-bd-secret'),
        price_per_page: this.val('set-bd-price'),
      },
    };
    this.setStatus('保存中...');
    try {
      const resp = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (data.error) {
        this.setStatus(`保存失败：${data.error}`, true);
        return;
      }
      this.engines = data.engines || this.engines;
      this.defaultEngine = payload.global.default_engine || this.defaultEngine;
      // A newly configured engine may become selectable; a de-selected one
      // must not stay active.
      if (!this.engine(this.selected) || !this.engine(this.selected).configured) {
        this.selected = this.defaultEngine;
        localStorage.setItem('ocrEngine', this.selected);
      }
      this.renderPicker();
      this.renderNote();
      this.refreshCfgBadges();
      this.setStatus('已保存');
      setTimeout(() => this.close(), 600);
    } catch (err) {
      console.error('Failed to save settings:', err);
      this.setStatus('保存失败', true);
    }
  },

  setStatus(text, isError = false) {
    const el = document.getElementById('settings-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', isError);
  },
};
