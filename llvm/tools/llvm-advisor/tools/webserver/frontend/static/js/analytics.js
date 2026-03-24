// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception

// analytics.js-advanced analytics tab for LLVM Advisor

const Analytics = (() => {


  const RTYPE_LABEL = { 0: "Passed", 1: "Missed", 2: "Analysis" };
  const RTYPE_CLASS = { 0: "rtype-passed", 1: "rtype-missed", 2: "rtype-analysis" };

  const ROW_HEIGHT  = 36;   // px — height of each remark row
  const BUFFER_ROWS = 5;    // extra rows rendered above/below viewport

  let state = {
    // raw data from API
    dictionary:   { files: [], passes: [], functions: [] },
    remarks:      [],
    clusters:     [],
    diffData:     null,

    // grid view state
    filteredRows: [],
    filterPass:   "",
    filterFunc:   "",
    filterRtype:  "",
    filterText:   "",

    // virtualizer state
    scrollTop:    0,
    viewportH:    0,

    // ui
    activeView:   "grid",
    currentUnit:  null,
    loading:      false,
    error:        null,
  };

  const el  = id  => document.getElementById(id);
  const qs  = sel => document.querySelector(sel);
  const qsa = sel => [...document.querySelectorAll(sel)];

  function html(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "className") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) {
      if (typeof c === "string") e.appendChild(document.createTextNode(c));
      else if (c) e.appendChild(c);
    }
    return e;
  }

  async function fetchRelational(unit) {
    const url = unit
      ? `/api/remarks/relational?unit=${encodeURIComponent(unit)}`
      : `/api/remarks/relational`;
    const res  = await fetch(url);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "API error");
    return json.data;
  }

  async function fetchClusters(unit) {
    const url = unit
      ? `/api/remarks/loop-clusters?unit=${encodeURIComponent(unit)}`
      : `/api/remarks/loop-clusters`;
    const res  = await fetch(url);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "API error");
    return json.data;
  }

  async function fetchDiff(baseline, target) {
    const url = `/api/remarks/diff?baseline=${encodeURIComponent(baseline)}&target=${encodeURIComponent(target)}`;
    const res  = await fetch(url);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "API error");
    return json.data;
  }

  function decodeRow(row) {
    const [fid, pid, funcid, line, col, hotness, rtype, name, message, args] = row;
    return {
      file:     state.dictionary.files[fid]     || "unknown",
      pass:     state.dictionary.passes[pid]    || "unknown",
      func:     state.dictionary.functions[funcid] || "unknown",
      line, col, hotness, rtype, name, message, args,
    };
  }

  function applyFilters() {
    const { filterPass, filterFunc, filterRtype, filterText, dictionary, remarks } = state;
    const fp   = filterPass.toLowerCase();
    const ff   = filterFunc.toLowerCase();
    const text = filterText.toLowerCase();

    state.filteredRows = remarks.filter(row => {
      const [fid, pid, funcid, , , , rtype, , message] = row;
      if (fp   && !(dictionary.passes[pid]    || "").toLowerCase().includes(fp))   return false;
      if (ff   && !(dictionary.functions[funcid] || "").toLowerCase().includes(ff)) return false;
      if (filterRtype !== "" && String(rtype) !== filterRtype)                      return false;
      if (text && !(message || "").toLowerCase().includes(text))                    return false;
      return true;
    });
  }

  function getVirtualWindow() {
    const total      = state.filteredRows.length;
    const totalH     = total * ROW_HEIGHT;
    const startIndex = Math.max(0, Math.floor(state.scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
    const visible    = Math.ceil(state.viewportH / ROW_HEIGHT) + BUFFER_ROWS * 2;
    const endIndex   = Math.min(total, startIndex + visible);
    return { startIndex, endIndex, totalH, offsetTop: startIndex * ROW_HEIGHT };
  }

  function renderVirtualRows(tbody, startIndex, endIndex, offsetTop) {
    tbody.innerHTML = "";

    if (offsetTop > 0) {
      const spacer = document.createElement("tr");
      spacer.style.height = offsetTop + "px";
      tbody.appendChild(spacer);
    }

    for (let i = startIndex; i < endIndex; i++) {
      const row = state.filteredRows[i];
      const d   = decodeRow(row);
      const tr  = document.createElement("tr");
      tr.className = "analytics-row " + (RTYPE_CLASS[d.rtype] || "");

      tr.innerHTML = `
        <td class="col-num">${i + 1}</td>
        <td><span class="badge badge-rtype badge-${RTYPE_CLASS[d.rtype]}">${RTYPE_LABEL[d.rtype] || d.rtype}</span></td>
        <td><span class="badge badge-pass">${escHtml(d.pass)}</span></td>
        <td class="col-func" title="${escHtml(d.func)}">${escHtml(shortFuncName(d.func))}</td>
        <td class="col-loc">${escHtml(baseName(d.file))}:${d.line}</td>
        <td class="col-msg">${escHtml(d.message)}</td>
        <td class="col-hotness">${d.hotness || ""}</td>
      `;

      tr.addEventListener("click", () => showHintCard(d, tr));
      tbody.appendChild(tr);
    }

    const total  = state.filteredRows.length;
    const belowH = (total - endIndex) * ROW_HEIGHT;
    if (belowH > 0) {
      const spacer = document.createElement("tr");
      spacer.style.height = belowH + "px";
      tbody.appendChild(spacer);
    }
  }

  const HINT_RULES = [
    {
      match: r => r.pass === "loop-vectorize" && /unsafe dependent memory/i.test(r.message),
      hint:  "Loop has memory aliasing. Try: #pragma clang loop distribute(enable)",
      docs:  "https://llvm.org/docs/Vectorizers.html#loop-distributor",
    },
    {
      match: r => r.pass === "loop-vectorize" && /cannot prove.*safe to reorder floating-point/i.test(r.message),
      hint:  "FP reassociation blocked vectorization. Try: -ffast-math or #pragma clang loop vectorize(enable)",
      docs:  "https://llvm.org/docs/Vectorizers.html",
    },
    {
      match: r => r.pass === "loop-vectorize" && /could not determine number of loop iterations/i.test(r.message),
      hint:  "Unknown trip count prevents vectorization. Ensure loop bounds are compile-time visible or use __builtin_assume.",
      docs:  "https://llvm.org/docs/Vectorizers.html",
    },
    {
      match: r => r.pass === "loop-vectorize" && /cannot identify array bounds/i.test(r.message),
      hint:  "Array bounds unknown. Use __restrict__ or -fno-strict-aliasing with care.",
      docs:  "https://llvm.org/docs/Vectorizers.html",
    },
    {
      match: r => r.pass === "regalloc" && /spill/i.test(r.message),
      hint:  "Register spills detected. Consider reducing local variable count or splitting the function.",
      docs:  "https://llvm.org/docs/CodeGenerator.html#register-allocator",
    },
    {
      match: r => r.pass === "inline" && /cost.*threshold/i.test(r.message),
      hint:  "Inlining cost exceeded threshold. Try: __attribute__((always_inline)) for hot paths.",
      docs:  "https://llvm.org/docs/InliningPolicies.html",
    },
    {
      match: r => r.pass === "slp-vectorizer" && /not beneficial/i.test(r.message),
      hint:  "SLP vectorization not beneficial at current cost model. Try restructuring to AoS→SoA layout.",
      docs:  "https://llvm.org/docs/Vectorizers.html#the-slp-vectorizer",
    },
  ];

  function getHint(d) {
    for (const rule of HINT_RULES) {
      if (rule.match(d)) return rule;
    }
    return null;
  }

  function showHintCard(d, tr) {
    const existing = qs(".hint-row");
    if (existing) existing.remove();

    const hint = getHint(d);
    const hintHtml = hint
      ? `<div class="hint-box">
           <span class="hint-icon">💡</span>
           <div>
             <strong>Suggestion:</strong> ${escHtml(hint.hint)}
             <a href="${hint.docs}" target="_blank" class="hint-docs">Docs →</a>
           </div>
         </div>`
      : `<div class="hint-box hint-none">No automated suggestion available for this remark.</div>`;

    const expandRow = document.createElement("tr");
    expandRow.className = "hint-row";
    expandRow.innerHTML = `
      <td colspan="7">
        <div class="hint-card">
          <div class="hint-header">
            <span class="badge badge-pass">${escHtml(d.pass)}</span>
            <span class="badge badge-rtype badge-${RTYPE_CLASS[d.rtype]}">${RTYPE_LABEL[d.rtype]}</span>
            <span class="hint-func">${escHtml(d.func)}</span>
            <span class="hint-loc">${escHtml(baseName(d.file))}:${d.line}</span>
          </div>
          <pre class="hint-message">${escHtml(d.message)}</pre>
          ${hintHtml}
        </div>
      </td>
    `;

    tr.insertAdjacentElement("afterend", expandRow);
    expandRow.scrollIntoView({ block: "nearest" });
  }

  // Grid view

  function buildGridView(container) {
    container.innerHTML = `
      <div class="analytics-toolbar">
        <input id="an-filter-text"  class="an-input" placeholder="Search message…" type="text">
        <input id="an-filter-pass"  class="an-input" placeholder="Filter pass…"    type="text">
        <input id="an-filter-func"  class="an-input" placeholder="Filter function…" type="text">
        <select id="an-filter-rtype" class="an-input">
          <option value="">All types</option>
          <option value="0">Passed</option>
          <option value="1">Missed</option>
          <option value="2">Analysis</option>
        </select>
        <span id="an-row-count" class="an-row-count"></span>
      </div>
      <div class="an-grid-wrapper" id="an-grid-wrapper">
        <table class="an-table" id="an-table">
          <thead>
            <tr>
              <th class="col-num">#</th>
              <th>Type</th>
              <th>Pass</th>
              <th>Function</th>
              <th>Location</th>
              <th>Message</th>
              <th>Hotness</th>
            </tr>
          </thead>
          <tbody id="an-tbody"></tbody>
        </table>
      </div>
    `;

    const wrapper = el("an-grid-wrapper");
    const tbody   = el("an-tbody");

    state.viewportH = wrapper.clientHeight || 600;

    function refresh() {
      applyFilters();
      const { startIndex, endIndex, totalH, offsetTop } = getVirtualWindow();
      const rowCount = el("an-row-count");
      if (rowCount) {
        rowCount.textContent =
          `${state.filteredRows.length} / ${state.remarks.length} remarks`;
      }
      renderVirtualRows(tbody, startIndex, endIndex, offsetTop);
    }

    wrapper.addEventListener("scroll", () => {
      state.scrollTop = wrapper.scrollTop;
      const { startIndex, endIndex, offsetTop } = getVirtualWindow();
      renderVirtualRows(tbody, startIndex, endIndex, offsetTop);
    });

    new ResizeObserver(() => {
      state.viewportH = wrapper.clientHeight;
      refresh();
    }).observe(wrapper);

    el("an-filter-text") .addEventListener("input",  e => { state.filterText  = e.target.value; state.scrollTop = 0; refresh(); });
    el("an-filter-pass") .addEventListener("input",  e => { state.filterPass  = e.target.value; state.scrollTop = 0; refresh(); });
    el("an-filter-func") .addEventListener("input",  e => { state.filterFunc  = e.target.value; state.scrollTop = 0; refresh(); });
    el("an-filter-rtype").addEventListener("change", e => { state.filterRtype = e.target.value; state.scrollTop = 0; refresh(); });

    refresh();
  }

  // Heatmap view

  function buildHeatmapView(container) {
    const { clusters } = state;

    if (!clusters.length) {
      container.innerHTML = `<div class="an-empty">No loop clusters found.</div>`;
      return;
    }

    const maxScore = clusters[0].heat_score || 1;
    const tier     = clusters[0].has_pgo ? "PGO" : "Static Heuristic";

    container.innerHTML = `
      <div class="heatmap-header">
        <h3>Loop Heatmap <span class="tier-badge">${tier} Tier</span></h3>
        <p>Remarks grouped by function + ${5}-line proximity radius. Sorted by heat score.</p>
      </div>
      <div class="heatmap-list" id="heatmap-list"></div>
    `;

    const list = el("heatmap-list");

    clusters.forEach((c, i) => {
      const pct   = Math.round((c.heat_score / maxScore) * 100);
      const short = shortFuncName(c.function);
      const file  = baseName(c.file);

      const card = document.createElement("div");
      card.className = "heatmap-card";
      card.innerHTML = `
        <div class="heatmap-rank">#${i + 1}</div>
        <div class="heatmap-body">
          <div class="heatmap-title">
            <span class="heatmap-func" title="${escHtml(c.function)}">${escHtml(short)}</span>
            <span class="heatmap-loc">${escHtml(file)}:${c.line_min}–${c.line_max}</span>
          </div>
          <div class="heatmap-bar-wrap">
            <div class="heatmap-bar" style="width:${pct}%"></div>
            <span class="heatmap-score">${c.heat_score}</span>
          </div>
          <div class="heatmap-passes">
            ${c.top_missed.map(p =>
              `<span class="badge badge-pass">${escHtml(p.pass)} ×${p.count}</span>`
            ).join(" ")}
          </div>
        </div>
        <div class="heatmap-meta">
          <span>${c.remark_count} remarks</span>
          <span>${c.missed_count} missed</span>
        </div>
      `;

      card.addEventListener("click", () => {
        state.filterFunc = c.function;
        state.activeView = "grid";
        render();
        const inp = el("an-filter-func");
        if (inp) inp.value = c.function;
      });

      list.appendChild(card);
    });
  }

  // Diff view

  function buildDiffView(container) {
    container.innerHTML = `
      <div class="diff-controls">
        <label>Baseline unit: <input id="diff-baseline" class="an-input" placeholder="unit name" type="text"></label>
        <label>Target unit:   <input id="diff-target"   class="an-input" placeholder="unit name" type="text"></label>
        <button id="diff-run" class="an-btn">Compare</button>
      </div>
      <div id="diff-results"></div>
    `;

    el("diff-run").addEventListener("click", async () => {
      const baseline = el("diff-baseline").value.trim();
      const target   = el("diff-target").value.trim();
      if (!baseline || !target) {
        el("diff-results").innerHTML = `<div class="an-error">Enter both unit names.</div>`;
        return;
      }
      el("diff-results").innerHTML = `<div class="an-loading">Comparing…</div>`;
      try {
        const data = await fetchDiff(baseline, target);
        renderDiffResults(el("diff-results"), data);
      } catch (e) {
        el("diff-results").innerHTML = `<div class="an-error">${escHtml(e.message)}</div>`;
      }
    });

    if (state.diffData) {
      renderDiffResults(el("diff-results"), state.diffData);
    }
  }

  function renderDiffResults(container, data) {
    const { summary, resolved, regressed, mutated } = data;

    container.innerHTML = `
      <div class="diff-summary">
        <div class="diff-stat diff-resolved">Resolved <strong>${summary.resolved}</strong></div>
        <div class="diff-stat diff-regressed">Regressed <strong>${summary.regressed}</strong></div>
        <div class="diff-stat diff-mutated">Mutated <strong>${summary.mutated}</strong></div>
        <div class="diff-stat">Unchanged <strong>${summary.unchanged}</strong></div>
      </div>
      <div id="diff-tabs" class="diff-tabs">
        <button class="diff-tab active" data-section="regressed">Regressions</button>
        <button class="diff-tab" data-section="resolved">Resolved</button>
        <button class="diff-tab" data-section="mutated">Mutated</button>
      </div>
      <div id="diff-section"></div>
    `;

    function showSection(name) {
      qsa(".diff-tab").forEach(b => b.classList.toggle("active", b.dataset.section === name));
      const items = data[name] || [];
      const sec   = el("diff-section");
      if (!items.length) {
        sec.innerHTML = `<div class="an-empty">None.</div>`;
        return;
      }
      sec.innerHTML = items.map(item => {
        const k = item.key;
        const b = item.baseline;
        const t = item.target;
        return `
          <div class="diff-item diff-${name}">
            <div class="diff-key">
              <span class="badge badge-pass">${escHtml(k.pass)}</span>
              <span class="diff-remark">${escHtml(k.remark)}</span>
              <span class="diff-func">${escHtml(shortFuncName(k.function))}</span>
              <span class="diff-loc">~line ${k.line_bucket}</span>
            </div>
            ${b ? `<div class="diff-msg diff-before">− ${escHtml(b.message || "")}</div>` : ""}
            ${t ? `<div class="diff-msg diff-after">+ ${escHtml(t.message || "")}</div>`  : ""}
          </div>
        `;
      }).join("");
    }

    qsa(".diff-tab").forEach(btn => {
      btn.addEventListener("click", () => showSection(btn.dataset.section));
    });

    showSection("regressed");
  }

  // Main render

  function render() {
    const root = el("analytics-root");
    if (!root) return;

    if (state.loading) {
      root.innerHTML = `<div class="an-loading">Loading analytics data…</div>`;
      return;
    }
    if (state.error) {
      root.innerHTML = `<div class="an-error">Error: ${escHtml(state.error)}</div>`;
      return;
    }

    root.innerHTML = `
      <div class="analytics-nav">
        <button class="an-nav-btn ${state.activeView === "grid"     ? "active" : ""}" data-view="grid">
        Remarks Grid
        </button>
        <button class="an-nav-btn ${state.activeView === "heatmap"  ? "active" : ""}" data-view="heatmap">
        Loop Heatmap
        </button>
        <button class="an-nav-btn ${state.activeView === "diff"     ? "active" : ""}" data-view="diff">
        Logic Diff
        </button>
        <span class="an-total">${state.remarks.length} total remarks</span>
      </div>
      <div id="analytics-view" class="analytics-view"></div>
    `;

    qsa(".an-nav-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        state.activeView = btn.dataset.view;
        render();
      });
    });

    const view = el("analytics-view");
    if      (state.activeView === "grid")    buildGridView(view);
    else if (state.activeView === "heatmap") buildHeatmapView(view);
    else if (state.activeView === "diff")    buildDiffView(view);
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  async function load(unit) {
    state.loading = true;
    state.error   = null;
    state.currentUnit = unit || null;
    render();

    try {
      const [relData, clusterData] = await Promise.all([
        fetchRelational(unit),
        fetchClusters(unit),
      ]);

      state.dictionary = relData.dictionary;
      state.remarks    = relData.remarks;
      state.clusters   = clusterData.clusters;

      applyFilters();
    } catch (e) {
      state.error = e.message;
    }

    state.loading = false;
    render();
  }

  function getSelectedUnit() {
    const unitSel = el("unit-selector");
    return unitSel ? unitSel.value || null : null;
  }

  function init() {
    injectStyles();

    const analyticsContent = el("analytics-content");

    // 1. Auto-load when Analytics tab becomes visible via MutationObserver
    if (analyticsContent) {
      const observer = new MutationObserver(() => {
        if (!analyticsContent.classList.contains("hidden") && state.remarks.length === 0 && !state.loading) {
          load(getSelectedUnit());
        }
      });
      observer.observe(analyticsContent, { attributes: true, attributeFilter: ["class"] });
    }

    // 2. Hook into the Analytics tab button directly for a reliable trigger
    const tabBtn = el("tab-analytics");
    if (tabBtn) {
      tabBtn.addEventListener("click", () => {
        // Small delay to let TabManager toggle the hidden class first
        setTimeout(() => {
          if (analyticsContent && !analyticsContent.classList.contains("hidden") && state.remarks.length === 0 && !state.loading) {
            load(getSelectedUnit());
          }
        }, 50);
      });
    }

    // 3. Reload data when user switches compilation unit (if Analytics is active)
    const unitSel = el("unit-selector");
    if (unitSel) {
      unitSel.addEventListener("change", () => {
        if (analyticsContent && !analyticsContent.classList.contains("hidden")) {
          // Reset state and reload with new unit
          state.remarks = [];
          state.clusters = [];
          state.filteredRows = [];
          state.filterPass = "";
          state.filterFunc = "";
          state.filterRtype = "";
          state.filterText = "";
          load(getSelectedUnit());
        }
      });
    }

    console.log("Analytics module initialized");
  }

  // Utility

  function escHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function baseName(path) {
    return path ? path.split("/").pop() : "";
  }

  function shortFuncName(mangled) {
    if (!mangled) return "";
    if (mangled.startsWith("_Z")) {
      return mangled.length > 30 ? mangled.slice(0, 30) + "…" : mangled;
    }
    return mangled.length > 40 ? mangled.slice(0, 40) + "…" : mangled;
  }

  // Styles

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      /* Layout */
      #analytics-root { height: 100%; display: flex; flex-direction: column; font-family: inherit; }
      .analytics-nav  { display: flex; align-items: center; gap: 8px; padding: 8px 16px;
                        border-bottom: 1px solid var(--border, #e2e8f0); background: var(--bg-secondary, #f8fafc); }
      .an-nav-btn     { padding: 6px 14px; border: 1px solid var(--border, #cbd5e1); border-radius: 6px;
                        background: var(--bg, #fff); cursor: pointer; font-size: 13px; }
      .an-nav-btn.active { background: var(--accent, #3b82f6); color: #fff; border-color: var(--accent, #3b82f6); }
      .an-total       { margin-left: auto; font-size: 12px; color: var(--text-muted, #64748b); }
      .analytics-view { flex: 1; overflow: hidden; display: flex; flex-direction: column; }

      /* ── Toolbar ── */
      .analytics-toolbar { display: flex; gap: 8px; padding: 8px 16px; flex-wrap: wrap;
                           border-bottom: 1px solid var(--border, #e2e8f0); }
      .an-input  { padding: 5px 10px; border: 1px solid var(--border, #cbd5e1); border-radius: 6px;
                   font-size: 13px; outline: none; }
      .an-input:focus { border-color: var(--accent, #3b82f6); }
      .an-row-count { margin-left: auto; font-size: 12px; color: var(--text-muted, #64748b); align-self: center; }

      /* ── Grid ── */
      .an-grid-wrapper { flex: 1; overflow-y: auto; overflow-x: auto; }
      .an-table  { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
      .an-table thead th { position: sticky; top: 0; background: var(--bg-secondary, #f1f5f9);
                           padding: 8px 12px; text-align: left; font-weight: 600;
                           border-bottom: 2px solid var(--border, #e2e8f0); white-space: nowrap; }
      .an-table tbody tr { border-bottom: 1px solid var(--border-light, #f1f5f9); cursor: pointer; }
      .an-table tbody tr:hover { background: var(--hover, #f8fafc); }
      .analytics-row td { padding: 6px 12px; vertical-align: middle; }
      .col-num  { width: 48px; color: var(--text-muted, #94a3b8); text-align: right; }
      .col-func { width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .col-loc  { width: 140px; white-space: nowrap; }
      .col-msg  { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .col-hotness { width: 70px; text-align: right; color: var(--text-muted, #64748b); }

      /* Row type tinting */
      .rtype-missed   { background: #fff5f5 !important; }
      .rtype-passed   { background: #f0fff4 !important; }
      .rtype-analysis { background: #fffbeb !important; }
      .rtype-missed:hover   { background: #fed7d7 !important; }
      .rtype-passed:hover   { background: #c6f6d5 !important; }
      .rtype-analysis:hover { background: #fef3c7 !important; }

      /* ── Badges ── */
      .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
      .badge-pass            { background: var(--bg-secondary, #e2e8f0); color: var(--text, #334155); }
      .badge-rtype-rtype-passed   { background: #dcfce7; color: #166534; }
      .badge-rtype-rtype-missed   { background: #fee2e2; color: #991b1b; }
      .badge-rtype-rtype-analysis { background: #fef9c3; color: #854d0e; }

      /* ── Hint card ── */
      .hint-row td { padding: 0; }
      .hint-card   { padding: 12px 20px; background: var(--bg-secondary, #f8fafc);
                     border-left: 3px solid var(--accent, #3b82f6); margin: 2px 0; }
      .hint-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
      .hint-func   { font-family: monospace; font-size: 12px; color: var(--text-muted, #64748b); }
      .hint-loc    { font-size: 12px; color: var(--text-muted, #64748b); }
      .hint-message { font-family: monospace; font-size: 12px; background: var(--bg, #fff);
                      padding: 8px 12px; border-radius: 4px; white-space: pre-wrap;
                      border: 1px solid var(--border, #e2e8f0); margin: 0 0 8px; }
      .hint-box    { display: flex; gap: 8px; align-items: flex-start; padding: 8px 12px;
                     background: #eff6ff; border-radius: 6px; font-size: 13px; }
      .hint-none   { background: var(--bg-secondary, #f1f5f9); color: var(--text-muted, #94a3b8); }
      .hint-docs   { margin-left: 8px; color: var(--accent, #3b82f6); font-size: 12px; }

      /* ── Heatmap ── */
      .heatmap-header { padding: 12px 16px; border-bottom: 1px solid var(--border, #e2e8f0); }
      .heatmap-header h3 { margin: 0 0 4px; font-size: 16px; }
      .heatmap-header p  { margin: 0; font-size: 12px; color: var(--text-muted, #64748b); }
      .tier-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px;
                    background: #fef3c7; color: #92400e; font-weight: 600; margin-left: 8px; }
      .heatmap-list { overflow-y: auto; flex: 1; padding: 12px 16px; display: flex;
                      flex-direction: column; gap: 8px; }
      .heatmap-card { display: flex; align-items: center; gap: 12px; padding: 10px 14px;
                      border: 1px solid var(--border, #e2e8f0); border-radius: 8px;
                      background: var(--bg, #fff); cursor: pointer; transition: box-shadow .15s; }
      .heatmap-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,.08); }
      .heatmap-rank  { width: 32px; font-weight: 700; color: var(--text-muted, #94a3b8); font-size: 13px; }
      .heatmap-body  { flex: 1; min-width: 0; }
      .heatmap-title { display: flex; gap: 10px; align-items: baseline; margin-bottom: 4px; }
      .heatmap-func  { font-family: monospace; font-size: 13px; font-weight: 600; }
      .heatmap-loc   { font-size: 12px; color: var(--text-muted, #64748b); }
      .heatmap-bar-wrap { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
      .heatmap-bar   { height: 6px; border-radius: 3px; background: linear-gradient(90deg,#f97316,#ef4444);
                       min-width: 4px; transition: width .3s; }
      .heatmap-score { font-size: 13px; font-weight: 700; color: #ef4444; }
      .heatmap-passes { display: flex; gap: 4px; flex-wrap: wrap; }
      .heatmap-meta  { display: flex; flex-direction: column; gap: 2px; font-size: 11px;
                       color: var(--text-muted, #94a3b8); text-align: right; white-space: nowrap; }

      /* ── Diff ── */
      .diff-controls { display: flex; gap: 12px; align-items: center; padding: 12px 16px;
                       border-bottom: 1px solid var(--border, #e2e8f0); flex-wrap: wrap; }
      .diff-controls label { display: flex; flex-direction: column; gap: 4px; font-size: 12px;
                             font-weight: 600; color: var(--text-muted, #64748b); }
      .an-btn { padding: 7px 16px; background: var(--accent, #3b82f6); color: #fff;
                border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; }
      .an-btn:hover { opacity: .9; }
      .diff-summary { display: flex; gap: 16px; padding: 12px 16px; flex-wrap: wrap;
                      border-bottom: 1px solid var(--border, #e2e8f0); }
      .diff-stat    { font-size: 14px; }
      .diff-tabs    { display: flex; gap: 0; border-bottom: 1px solid var(--border, #e2e8f0); }
      .diff-tab     { padding: 8px 18px; border: none; background: none; cursor: pointer; font-size: 13px;
                      border-bottom: 2px solid transparent; }
      .diff-tab.active { border-bottom-color: var(--accent, #3b82f6); font-weight: 600; }
      #diff-section { overflow-y: auto; flex: 1; }
      .diff-item    { padding: 10px 16px; border-bottom: 1px solid var(--border-light, #f1f5f9); }
      .diff-key     { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; flex-wrap: wrap; }
      .diff-remark  { font-family: monospace; font-size: 12px; }
      .diff-func    { font-family: monospace; font-size: 12px; color: var(--text-muted, #64748b); }
      .diff-loc     { font-size: 12px; color: var(--text-muted, #94a3b8); }
      .diff-msg     { font-family: monospace; font-size: 12px; padding: 2px 8px; border-radius: 3px; }
      .diff-before  { background: #fee2e2; color: #991b1b; }
      .diff-after   { background: #dcfce7; color: #166534; }

      /* ── States ── */
      .an-loading { padding: 40px; text-align: center; color: var(--text-muted, #64748b); }
      .an-error   { padding: 16px; color: #dc2626; background: #fee2e2; border-radius: 6px; margin: 16px; }
      .an-empty   { padding: 24px; text-align: center; color: var(--text-muted, #94a3b8); }
    `;
    document.head.appendChild(style);
  }

  return { init, load };

})();

// Auto-initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => Analytics.init());
} else {
  Analytics.init();
}
