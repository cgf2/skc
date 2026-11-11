/* 应用编排：视图、程序、刀具、测量与双向联动 */
(function (global) {
  'use strict';

  const LS_KEY = 'skc.state.v1';

  const TYPE_META = {
    outer: { label: '外圆刀', short: '外圆' },
    inner: { label: '内孔刀', short: '内孔' },
    groove: { label: '切槽刀', short: '切槽' },
    thread: { label: '螺纹刀', short: '螺纹' }
  };

  const TYPE_ICONS = {
    outer: '<svg viewBox="0 0 24 24"><path d="M4 17 17 4l3 3L7 20H4z"/><path d="M13 8l3 3"/></svg>',
    inner: '<svg viewBox="0 0 24 24"><path d="M9 4v16M15 6v12"/><path d="M9 10h6M9 14h6"/></svg>',
    groove: '<svg viewBox="0 0 24 24"><path d="M4 7h16M8 7v9M16 7v9"/><path d="M8 12h8"/></svg>',
    thread: '<svg viewBox="0 0 24 24"><path d="M4 8l8 8M8 8l8 8M12 8l8 8"/><path d="M4 5v14"/></svg>'
  };

  function defaultTools() {
    return [
      { id: 't1', toolNo: 1, name: '外圆精车刀', type: 'outer', radius: 0.8, angle: 93, tip: 80, width: 0, pitch: 0, threadAngle: 0, geoX: 0, geoZ: 0, wearX: 0, wearZ: 0 },
      { id: 't2', toolNo: 2, name: '内孔镗刀', type: 'inner', radius: 0.4, angle: 93, tip: 80, width: 0, pitch: 0, threadAngle: 0, geoX: 0, geoZ: 0, wearX: 0, wearZ: 0 },
      { id: 't3', toolNo: 3, name: '切槽刀', type: 'groove', radius: 0.2, angle: 90, tip: 0, width: 3, pitch: 0, threadAngle: 0, geoX: 0, geoZ: 0, wearX: 0, wearZ: 0 },
      { id: 't4', toolNo: 4, name: '螺纹刀', type: 'thread', radius: 0.1, angle: 60, tip: 60, width: 0, pitch: 2, threadAngle: 60, geoX: 0, geoZ: 0, wearX: 0, wearZ: 0 }
    ];
  }

  const state = {
    program: global.DefaultProgram || '',
    tools: defaultTools(),
    activeToolId: 't1',
    stockDiameter: 60,
    layers: { nominal: true, stock: true, deviation: true, grid: true, chuck: true },
    mode: 'measure',
    measurements: [],
    guides: [],
    guideTool: null,
    selectedId: -1,
    view: 'contour'
  };

  let parsed = null;
  let sim = null;
  let sheetMode = null;
  let editDir = null;
  let dragFeature = null;
  let dragPending = null;
  let dragRaf = 0;
  let parseTimer = 0;
  let gutterHits = [];
  let pendingFit = false;
  let guideSeq = 0;
  let guideEditId = null;

  /* 逆向页面状态 */
  const revState = {
    lastPipeline: null,  // runPipeline 返回
    debounceTimer: 0,
    sourceText: null,    // 生成前的原始程序（已写回程序页后仍用它作为目标轮廓）
    generatedText: null  // 最近一次写入程序页的生成程序
  };

  const $ = function (id) { return document.getElementById(id); };
  const editor = $('editor');
  const gutter = $('gutter');
  const sheet = $('sheet');
  const diagList = $('diagList');
  const pickPop = $('pickPop');
  const guidePop = $('guidePop');
  const guideInput = $('guideInput');
  const viewer = new global.Viewer($('svg'));

  /* ---------------- 通用 ---------------- */
  function fmt(v) {
    if (!isFinite(v)) return '—';
    let s = (Math.round(v * 1000) / 1000).toFixed(3);
    if (s === '-0.000') s = '0.000';
    return s;
  }
  function num(v) {
    const n = parseFloat(v);
    return isFinite(n) ? n : 0;
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function activeTool() {
    return state.tools.find(function (t) { return t.id === state.activeToolId; }) || state.tools[0];
  }
  function toolMeta(t) {
    return TYPE_META[t.type] || TYPE_META.outer;
  }
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, 1900);
  }

  /* ---------------- 持久化 ---------------- */
  function saveState() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        program: state.program,
        tools: state.tools,
        activeToolId: state.activeToolId,
        stockDiameter: state.stockDiameter,
        layers: state.layers,
        mode: state.mode
      }));
    } catch (e) { /* 忽略隐私模式存储失败 */ }
  }
  function loadState() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { saved = null; }
    if (!saved || typeof saved !== 'object') return;
    if (typeof saved.program === 'string' && saved.program.trim()) state.program = saved.program;
    if (Array.isArray(saved.tools) && saved.tools.length) {
      state.tools = saved.tools.map(function (t, i) {
        return Object.assign({
          id: 't' + (i + 1), toolNo: i + 1, name: '刀具' + (i + 1), type: 'outer',
          radius: 0.8, angle: 93, tip: 80, width: 0, pitch: 0, threadAngle: 0,
          geoX: 0, geoZ: 0, wearX: 0, wearZ: 0
        }, t);
      });
      if (!state.tools.some(function (t) { return t.id === saved.activeToolId; })) {
        state.activeToolId = state.tools[0].id;
      }
    }
    if (saved.activeToolId) state.activeToolId = saved.activeToolId;
    if (isFinite(saved.stockDiameter)) state.stockDiameter = Math.max(1, Number(saved.stockDiameter));
    if (saved.layers) state.layers = Object.assign(state.layers, saved.layers);
    if (saved.mode === 'measure' || saved.mode === 'edit' || saved.mode === 'pan') state.mode = saved.mode;
    if (!state.tools.some(function (t) { return t.id === state.activeToolId; })) {
      state.activeToolId = state.tools[0].id;
    }
  }

  /* ---------------- 解析与仿真 ---------------- */
  function rebuild(opts) {
    opts = opts || {};
    parsed = global.ProgramParser.parse(state.program, state.tools, { activeToolId: state.activeToolId });
    sim = global.ContourSimulator.simulate(parsed, { stockDiameter: state.stockDiameter });

    const visible = state.view === 'contour';
    if (opts.fit && !visible) pendingFit = true;
    viewer.setData(parsed, sim, { stockDiameter: state.stockDiameter }, { fit: !!opts.fit && visible });
    if (state.selectedId >= 0 && !parsed.cutting.some(function (f) { return f.id === state.selectedId; })) {
      state.selectedId = -1;
      viewer.setSelected(-1);
    } else {
      viewer.setSelected(state.selectedId);
    }

    updateChips();
    updateStats();
    updateDiagnostics();
    updateGutter();
    updateEmpty();
    updateZoom();

    if (!opts.keepSheet) {
      if (sheetMode === 'measure') renderMeasureSheet();
      if (sheetMode === 'feature' && state.selectedId >= 0 && !dragFeature && !opts.noSheet) {
        renderFeatureSheet(state.selectedId, opts.keepValues);
      }
    }
  }

  function updateChips() {
    const cov = parsed ? parsed.coverage : 0;
    const cc = $('chipCoverage');
    cc.textContent = parsed && parsed.cutting.length ? '识别 ' + Math.round(cov * 100) + '%' : '识别 --';
    cc.className = 'chip ' + (parsed && parsed.cutting.length && cov >= 0.95 ? 'chip-mint' : 'warn');

    const comp = $('chipComp');
    comp.textContent = '程序=刀心';
    comp.className = 'chip chip-mint';
  }

  function updateStats() {
    if (!parsed) return;
    const s = parsed.stats;
    $('programStats').textContent = s.lines + ' 行 · ' + s.segments + ' 段' + (s.arcs ? ' · ' + s.arcs + ' 弧' : '');
    $('programStats').className = 'pill' + (s.segments ? ' good' : ' bad');
  }

  function updateDiagnostics() {
    diagList.innerHTML = '';
    const list = parsed ? parsed.diagnostics.slice() : [];
    if (sim && sim.warnings) {
      sim.warnings.forEach(function (w) { list.push({ level: 'warn', line: 0, text: w }); });
    }
    $('diagCount').textContent = list.length ? list.length + ' 条' : '无';
    $('diagCount').className = 'pill' + (list.some(function (d) { return d.level === 'err'; }) ? ' bad' : list.some(function (d) { return d.level === 'warn'; }) ? ' warn' : ' good');
    if (!list.length) {
      diagList.innerHTML = '<div class="diag-empty">未发现需要提示的问题</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    list.forEach(function (d) {
      const item = document.createElement('div');
      item.className = 'diag-item ' + (d.level || 'ok');
      const ln = document.createElement('span');
      ln.className = 'ln';
      ln.textContent = d.line ? 'L' + d.line : '·';
      const tx = document.createElement('span');
      tx.textContent = d.text;
      item.appendChild(ln);
      item.appendChild(tx);
      if (d.line) {
        item.style.cursor = 'pointer';
        item.addEventListener('click', function () { jumpToLine(d.line); });
      }
      frag.appendChild(item);
    });
    diagList.appendChild(frag);
  }

  function updateGutter() {
    const lines = state.program.replace(/\r/g, '').split('\n');
    gutterHits = [];
    if (parsed) {
      parsed.diagnostics.forEach(function (d) {
        if (d.line && d.level !== 'ok') gutterHits.push({ line: d.line, level: d.level });
      });
      const sel = parsed.cutting.find(function (f) { return f.id === state.selectedId; });
      if (sel) gutterHits.push({ line: sel.line, level: 'hit' });
    }
    let html = '';
    for (let i = 1; i <= lines.length; i++) {
      const hit = gutterHits.find(function (h) { return h.line === i; });
      html += '<div class="' + (hit ? 'hit' : '') + '" data-line="' + i + '">' + i + '</div>';
    }
    gutter.innerHTML = html;
    gutter.scrollTop = editor.scrollTop;
  }

  function updateEmpty() {
    const empty = $('emptyState');
    const ok = parsed && parsed.cutting.length > 0;
    empty.classList.toggle('show', !ok);
  }

  function updateZoom() {
    $('zoomReadout').textContent = viewer.zoomReadout();
  }

  function scheduleParse() {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(function () {
      hidePickPop();
      rebuild({ noSheet: true });
      saveState();
    }, 200);
  }

  function jumpToLine(line) {
    setView('program');
    const lines = state.program.replace(/\r/g, '').split('\n');
    let start = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) start += lines[i].length + 1;
    const end = Math.min(state.program.length, start + (lines[line - 1] || '').length);
    editor.focus();
    editor.setSelectionRange(start, end);
    const lineTop = (line - 8) * 20;
    editor.scrollTop = Math.max(0, lineTop);
    gutter.scrollTop = editor.scrollTop;
  }

  /* ---------------- 视图切换 ---------------- */
  function setView(name) {
    state.view = name;
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('is-on', t.getAttribute('data-view') === name);
    });
    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.toggle('is-active', v.id === 'view-' + name);
    });
    if (name === 'contour') {
      requestAnimationFrame(function () {
        if (pendingFit) {
          pendingFit = false;
          viewer.fit();
        } else {
          viewer._onResize();
        }
        updateZoom();
      });
    } else if (name === 'tools') {
      renderTools();
      renderToolParams();
    } else if (name === 'program') {
      updateGutter();
    } else if (name === 'reverse') {
      revRefreshToolSelect();
      // 每次进入都按当前程序重新生成
      revGenerate(true);
    }
    $('layersPop').classList.remove('show');
  }

  /* ---------------- 测量（仅线特征端点 / 特征交点） ---------------- */
  function onTap(pick) {
    if (!pick) return;
    hidePickPop();
    hideGuidePop();
    if (state.measurements.length >= 2) state.measurements = [];
    state.measurements.push({
      z: pick.z, r: pick.r, d: pick.d, kind: pick.kind,
      type: pick.type, featureIds: (pick.featureIds || []).slice(),
      arc: pick.node && pick.node.arc ? Object.assign({}, pick.node.arc) : null
    });
    viewer.setMeasurements(state.measurements);
    renderMeasureSheet();
  }

  /* 点中特征线非端点位置：列出该线段的端点供选择，不弹报警 */
  function hidePickPop() {
    pickPop.classList.remove('show');
    pickPop.innerHTML = '';
  }
  function onEndpointChoice(cands, cx, cy) {
    if (!cands || !cands.length) {
      toast('该特征线没有可用的端点。');
      return;
    }
    pickPop.innerHTML = '<div class="pop-head">该特征线端点</div>' +
      cands.map(function (p, i) {
        return '<button type="button" class="pick-item" data-i="' + i + '">' +
          '<span>' + esc(p.role) + '</span>' +
          '<b>X' + fmt(p.d) + ' · Z' + fmt(p.z) + '</b>' +
          '</button>';
      }).join('');
    pickPop.style.left = Math.max(96, Math.min(window.innerWidth - 96, cx)) + 'px';
    pickPop.style.top = Math.max(120, cy - 12) + 'px';
    pickPop.classList.add('show');
    pickPop.querySelectorAll('.pick-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const p = cands[Number(btn.getAttribute('data-i'))];
        hidePickPop();
        onTap(p);
      });
    });
  }

  /* ---------------- 辅助线（铅垂线 / 水平线） ---------------- */
  function hideGuidePop() {
    guidePop.classList.remove('show');
    guideEditId = null;
  }
  function editingGuide() {
    return state.guides.find(function (g) { return g.id === guideEditId; }) || null;
  }
  /* 点中辅助线：弹出数值输入，输入即实时平移该辅助线 */
  function onGuidePick(guide, cx, cy) {
    hidePickPop();
    guideEditId = guide.id;
    const isZ = guide.axis === 'z';
    $('guidePopHead').textContent = isZ ? '铅垂线 · 等 Z' : '水平线 · 等 X';
    $('guideField').textContent = isZ ? 'Z (mm)' : 'X (mm，直径)';
    guideInput.value = fmt(isZ ? guide.value : guide.value * 2);
    guidePop.style.left = Math.max(110, Math.min(window.innerWidth - 110, cx)) + 'px';
    guidePop.style.top = Math.max(150, cy - 12) + 'px';
    guidePop.classList.add('show');
    setTimeout(function () { guideInput.focus(); guideInput.select(); }, 0);
  }
  function applyGuideInput() {
    const g = editingGuide();
    if (!g) return;
    const v = parseFloat(guideInput.value);
    if (!isFinite(v)) return;
    g.value = g.axis === 'z' ? v : v / 2;
    viewer.setGuides(state.guides);
  }
  function commitGuideValue() {
    const g = editingGuide();
    if (!g) return;
    const v = parseFloat(guideInput.value);
    if (!isFinite(v)) {
      guideInput.value = fmt(g.axis === 'z' ? g.value : g.value * 2);
      return;
    }
    const exact = Math.round(v * 1000) / 1000;   // 以界面显示单位（Z 或 X 直径）保留 0.001
    g.value = g.axis === 'z' ? exact : exact / 2;
    guideInput.value = fmt(g.axis === 'z' ? g.value : g.value * 2);
    viewer.setGuides(state.guides);
  }

  function updateGuideUI() {
    const v = $('btnGuideV'), h = $('btnGuideH'), c = $('btnGuideClear');
    v.classList.toggle('is-on', state.guideTool === 'z');
    v.classList.toggle('amber', state.guideTool === 'z');
    h.classList.toggle('is-on', state.guideTool === 'r');
    h.classList.toggle('amber', state.guideTool === 'r');
    c.classList.toggle('is-off', !state.guides.length);
  }
  function updateStageHint() {
    $('stageHint').textContent =
      state.mode === 'measure' && state.guideTool === 'z' ? '在画布上点击放置铅垂线（等 Z）；再点按钮退出，交点可直接拾取' :
      state.mode === 'measure' && state.guideTool === 'r' ? '在画布上点击放置水平线（等 X）；再点按钮退出，交点可直接拾取' :
      state.mode === 'measure' ? '点选实际轮廓端点 / 交点 / 辅助线交点作为测量基准；点击辅助线可编辑数值' :
      state.mode === 'edit' ? '点选轮廓段或拖动橙色端点，修改后自动回写程序' :
      '单指平移 · 双指缩放 · 滚轮缩放';
  }
  function setGuideTool(tool) {
    state.guideTool = state.guideTool === tool ? null : tool;
    if (state.guideTool && state.mode !== 'measure') applyMode('measure');
    viewer.setGuideTool(state.guideTool);
    hidePickPop();
    hideGuidePop();
    updateGuideUI();
    updateStageHint();
  }
  function applyMode(mode) {
    state.mode = mode;
    if (mode !== 'measure' && state.guideTool) {
      state.guideTool = null;
      viewer.setGuideTool(null);
      updateGuideUI();
    }
    document.querySelectorAll('#modeSwitch [data-mode]').forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-mode') === state.mode);
    });
    hidePickPop();
    hideGuidePop();
    viewer.setMode(state.mode);
    updateStageHint();
    if (state.mode === 'measure') {
      if (sheetMode === 'feature') hideSheet();
      if (state.measurements.length) renderMeasureSheet();
    } else if (state.mode === 'edit') {
      if (sheetMode === 'measure') hideSheet();
      if (!sheetMode && parsed && parsed.cutting.length) {
        if (state.selectedId < 0) {
          state.selectedId = parsed.cutting[0].id;
          viewer.setSelected(state.selectedId);
        }
        renderFeatureSheet(state.selectedId);
      }
    } else if (sheetMode) {
      hideSheet();
    }
    saveState();
  }

  function findFeature(id) {
    return parsed ? parsed.cutting.find(function (f) { return f.id === id; }) : null;
  }

  function sharedFeature(a, b) {
    if (!a || !b) return null;
    const ids = a.featureIds || [];
    for (const id of ids) {
      if ((b.featureIds || []).indexOf(id) >= 0) {
        const f = findFeature(id);
        if (f) return f;
      }
    }
    return null;
  }

  function arcMeta(point) {
    if (!point) return null;
    if (point.arc) return { r: point.arc.r, cz: point.arc.cz, cr: point.arc.cr, feature: null };
    for (const id of point.featureIds || []) {
      const f = findFeature(id);
      if (f && f.type === 'arc' && f.center) {
        return { r: f.radius, cz: f.center.z, cr: f.center.r, feature: f };
      }
    }
    return null;
  }

  function lineMeta(f) {
    if (!f || f.type !== 'line') return null;
    const dz = f.end.z - f.start.z;
    const dr = (f.end.d - f.start.d) / 2;
    return { angle: Math.atan2(dr, -dz) * 180 / Math.PI, len: Math.hypot(dz, dr) };
  }

  function renderMeasureSheet() {
    sheetMode = 'measure';
    const pts = state.measurements;
    const rows = pts.map(function (p, i) {
      return '<div class="point-row' + (i === 1 ? ' is-p2' : '') + '">' +
        '<span class="tagdot">P' + (i + 1) + '</span>' +
        '<div class="coords"><span><i>X</i>' + fmt(p.d) + '</span><span><i>Z</i>' + fmt(p.z) + '</span></div>' +
        '<span class="seg">' + esc(p.type || '基准') + ' · ' + (p.kind === 'inner' ? '内孔' : '外圆') + '</span></div>';
    }).join('');

    let metrics = '';
    if (pts.length === 2) {
      const a = pts[0], b = pts[1];
      const dist = Math.hypot(b.z - a.z, b.r - a.r);
      const dz = Math.abs(b.z - a.z);
      const dx = Math.abs(b.d - a.d);
      const shared = sharedFeature(a, b);
      let arc = null;
      if (shared && shared.type === 'arc') {
        arc = a.arc || b.arc || {
          r: shared.radius, cz: shared.center.z, cr: shared.center.r
        };
      } else if (a.arc && b.arc &&
        Math.abs(a.arc.cz - b.arc.cz) < 1e-6 && Math.abs(a.arc.cr - b.arc.cr) < 1e-6 &&
        Math.abs(a.arc.r - b.arc.r) < 1e-6) {
        arc = a.arc;
      }
      const line = shared ? lineMeta(shared) : null;
      metrics = '<div class="measure-grid">' +
        '<div class="metric accent"><label>基准点距离</label><b>' + fmt(dist) + '<em>mm</em></b></div>' +
        '<div class="metric"><label>轴向 ΔZ</label><b>' + fmt(dz) + '<em>mm</em></b></div>' +
        '<div class="metric"><label>径向 ΔX</label><b>' + fmt(dx) + '<em>mm</em></b></div>' +
        '<div class="metric' + (arc ? ' amber' : '') + '"><label>圆弧半径</label><b>' + (arc ? fmt(arc.r) : '—') + (arc ? '<em>mm</em>' : '') + '</b></div>' +
        '<div class="metric wide"><label>' + (arc ? '圆心坐标' : '所属特征') + '</label><b>' +
        (arc ? 'X ' + fmt(arc.cr * 2) + '　Z ' + fmt(arc.cz) :
          line ? '直线段 · 段长 ' + fmt(line.len) + ' mm · A' + fmt(line.angle) + '°' : '跨特征基准点') +
        '</b></div>' +
        '</div>';
    } else {
      const arc = pts.length === 1 ? arcMeta(pts[0]) : null;
      metrics = '<div class="measure-grid">' +
        '<div class="metric wide"><label>' + (pts.length ? '基准点属性' : '测量提示') + '</label><b>' +
        (pts.length ? (pts[0].type || '基准') + (arc ? ' · 圆弧 R ' + fmt(arc.r) + ' mm' : '') : '仅可点选实际轮廓端点、特征交点或辅助线交点') +
        '</b></div>' +
        '</div>' +
        '<div class="sheet-note"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg><span>基准点取自实际工件轮廓（程序刀心轨迹按刀尖半径向材料侧偏移 r 后的轮廓）：可选择线特征端点、特征交点或辅助线（铅垂线 / 水平线）与轮廓的交点，禁止在特征线上任意取点。辅助线不受刀尖半径影响。依次拾取 P1、P2 后显示距离、ΔX/ΔZ 与所属圆弧/直线参数。</span></div>';
    }

    showSheet(
      '<div class="sheet-inner">' +
      '<div class="sheet-grip"></div>' +
      '<div class="sheet-head"><div class="sheet-title"><div class="idx">M</div><div><h3>工件轮廓基准测量</h3><p>精度 0.001 mm · ' + (pts.length ? 'P' + pts.length + ' 已定位' : '待拾取') + '</p></div></div>' +
      '<button class="close-btn" data-act="closeSheet">×</button></div>' +
      '<div class="sheet-body">' +
      (rows ? '<div class="point-list">' + rows + '</div>' : '') +
      metrics +
      '</div>' +
      '<div class="sheet-actions"><button class="btn ghost" data-act="clearMeasure">清除拾取</button>' +
      '<button class="btn primary" data-act="closeSheet">完成</button></div>' +
      '</div>'
    );
  }

  /* ---------------- 特征编辑 ---------------- */
  function featureLabel(f) {
    if (f.type === 'arc') return 'G0' + (f.cw ? 2 : 3) + ' Z' + fmt(f.end.z);
    return 'G01 Z' + fmt(f.end.z);
  }

  function renderFeatureSheet(id, keepValues) {
    const f = parsed ? parsed.cutting.find(function (x) { return x.id === id; }) : null;
    if (!f) {
      hideSheet();
      return;
    }
    sheetMode = 'feature';
    state.selectedId = id;
    const arc = f.type === 'arc';
    if (!keepValues || editDir == null) editDir = arc ? !!f.cw : true;
    const chips = parsed.cutting.slice(0, 60).map(function (x) {
      return '<button class="feature-chip' + (x.id === id ? ' is-on' : '') + '" data-feature="' + x.id + '"><i></i>' + esc(featureLabel(x)) + '</button>';
    }).join('');

    const segLen = arc ? f.radius * global.Geometry.arcSweep(f) : Math.hypot(f.end.z - f.start.z, (f.end.d - f.start.d) / 2);

    showSheet(
      '<div class="sheet-inner">' +
      '<div class="sheet-grip"></div>' +
      '<div class="sheet-head"><div class="sheet-title"><div class="idx">' + esc(f.lineNo) + '</div><div><h3>' + (arc ? '圆弧段 G0' + (f.cw ? 2 : 3) : '直线段 G01') + '</h3>' +
      '<p>第 ' + f.line + ' 行 · T' + f.toolNo + '</p></div></div>' +
      '<button class="close-btn" data-act="closeSheet">×</button></div>' +
      '<div class="sheet-body">' +
      '<div class="feature-strip">' + chips + '</div>' +
      '<div class="field-grid">' +
      '<div class="field"><label>终点直径 X (mm)</label><div class="num-input"><button data-step="x" data-dir="-1">−</button>' +
      '<input id="editX" type="number" inputmode="decimal" step="0.1" value="' + fmt(f.end.d) + '"><button data-step="x" data-dir="1">+</button></div></div>' +
      '<div class="field"><label>终点 Z (mm)</label><div class="num-input"><button data-step="z" data-dir="-1">−</button>' +
      '<input id="editZ" type="number" inputmode="decimal" step="0.1" value="' + fmt(f.end.z) + '"><button data-step="z" data-dir="1">+</button></div></div>' +
      '</div>' +
      (arc ? '<div class="field-grid">' +
        '<div class="field"><label>圆弧半径 R (mm)</label><div class="num-input"><button data-step="r" data-dir="-1">−</button>' +
        '<input id="editR" type="number" inputmode="decimal" step="0.1" value="' + fmt(f.radius) + '"><button data-step="r" data-dir="1">+</button></div></div>' +
        '<div class="field"><label>圆弧方向</label><div class="segmented-small">' +
        '<button data-cw="1" class="' + (editDir ? 'is-on' : '') + '">G02</button>' +
        '<button data-cw="0" class="' + (!editDir ? 'is-on' : '') + '">G03</button></div></div>' +
        '</div>' : '') +
      '<div class="readonly">起点 X ' + fmt(f.start.d) + '　Z ' + fmt(f.start.z) + '　段长 ' + fmt(segLen) +
      (f.angleA != null ? '　A' + fmt(f.angleA) + '°' : '') +
      (f.cornerC > 0 ? '　C' + fmt(f.cornerC) : '') +
      (f.cornerR > 0 ? '　R' + fmt(f.cornerR) : '') + '</div>' +
      '<div class="sheet-note"><svg viewBox="0 0 24 24"><path d="m5 12 4.5 4.5L19 7"/></svg><span>修改后点击“应用”回写第 ' + f.line + ' 行；也可直接拖动轮廓上的橙色端点实时联动。</span></div>' +
      '</div>' +
      '<div class="sheet-actions"><button class="btn primary" id="btnEditApply">应用并回写</button>' +
      '<button class="btn ghost" data-act="closeSheet">关闭</button></div>' +
      '</div>'
    );

    sheet.querySelectorAll('[data-feature]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const fid = Number(btn.getAttribute('data-feature'));
        state.selectedId = fid;
        viewer.setSelected(fid);
        renderFeatureSheet(fid);
      });
    });
    sheet.querySelectorAll('[data-step]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const which = btn.getAttribute('data-step');
        const delta = Number(btn.getAttribute('data-dir')) * 0.1;
        applySheetEdit(which, delta);
      });
    });
    sheet.querySelectorAll('[data-cw]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        editDir = btn.getAttribute('data-cw') === '1';
        sheet.querySelectorAll('[data-cw]').forEach(function (b) {
          b.classList.toggle('is-on', (b.getAttribute('data-cw') === '1') === editDir);
        });
        applySheetEdit(null, 0);
      });
    });
    const applyBtn = sheet.querySelector('#btnEditApply');
    if (applyBtn) applyBtn.addEventListener('click', function () { applySheetEdit(null, 0); });
  }

  function applySheetEdit(stepField, delta) {
    const f = parsed && parsed.cutting.find(function (x) { return x.id === state.selectedId; });
    if (!f) return;
    const xEl = sheet.querySelector('#editX');
    const zEl = sheet.querySelector('#editZ');
    const rEl = sheet.querySelector('#editR');
    if (!xEl || !zEl) return;

    let x = num(xEl.value);
    let z = num(zEl.value);
    if (stepField === 'x') x = Math.round((x + delta) * 1000) / 1000;
    if (stepField === 'z') z = Math.round((z + delta) * 1000) / 1000;
    if (stepField === 'r' && rEl) {
      const nr = Math.max(0.001, num(rEl.value) + delta);
      rEl.value = fmt(nr);
    }

    const changes = {};
    if (isFinite(x) && Math.abs(x - f.end.d) > 1e-6) changes.x = x;
    if (isFinite(z) && Math.abs(z - f.end.z) > 1e-6) changes.z = z;
    if (f.type === 'arc' && rEl && isFinite(num(rEl.value)) && Math.abs(num(rEl.value) - f.radius) > 1e-6) {
      changes.radius = Math.abs(num(rEl.value));
    }
    if (f.type === 'arc' && editDir != null && editDir !== !!f.cw) changes.cw = editDir;
    if (!Object.keys(changes).length) {
      if (!stepField) toast('参数未变化');
      return;
    }
    const ok = applyEdit(f, changes);
    if (ok) {
      toast(stepField ? '已回写第 ' + f.line + ' 行' : '已应用并回写程序');
      renderFeatureSheet(state.selectedId, true);
    }
  }

  function applyEdit(feature, changes, opts) {
    opts = opts || {};
    const next = global.ProgramParser.applyFeatureEdit(state.program, feature, changes);
    if (next === state.program) return false;
    state.program = next;
    editor.value = next;
    rebuild({ noSheet: !!opts.silent, keepSheet: false });
    if (!opts.silent) saveState();
    return true;
  }

  /* ---------------- 拖拽联动 ---------------- */
  function processDrag() {
    dragRaf = 0;
    if (!dragFeature || !dragPending) return;
    if (sheet.classList.contains('show')) sheet.classList.remove('show');
    const f = dragFeature;
    const end = dragPending;
    const changes = {};
    if (Math.abs(end.d - f.end.d) > 1e-6) changes.x = Math.max(0, end.d);
    if (Math.abs(end.z - f.end.z) > 1e-6) changes.z = end.z;
    if (Object.keys(changes).length) {
      state.program = global.ProgramParser.applyFeatureEdit(state.program, f, changes);
      editor.value = state.program;
      rebuild({ noSheet: true, keepSheet: true });
    }
  }

  function onDrag(f, end, phase) {
    if (phase === 'move') {
      dragFeature = f;
      dragPending = end;
      state.selectedId = f.id;
      if (!dragRaf) dragRaf = requestAnimationFrame(processDrag);
    } else {
      const last = dragFeature;
      dragFeature = null;
      dragPending = null;
      if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
      saveState();
      rebuild({ noSheet: true, keepSheet: true });
      if (last) {
        renderFeatureSheet(last.id, true);
        toast('已拖动回写第 ' + last.line + ' 行');
      }
    }
  }

  /* ---------------- 刀具 ---------------- */
  function renderTools() {
    const strip = $('toolStrip');
    strip.innerHTML = state.tools.map(function (t) {
      const meta = toolMeta(t);
      return '<button class="tool-card' + (t.id === state.activeToolId ? ' is-on' : '') + '" data-tool="' + t.id + '">' +
        '<div class="tool-card-top"><span class="tool-no">T' + t.toolNo + '</span><span class="tool-icon">' + (TYPE_ICONS[t.type] || TYPE_ICONS.outer) + '</span></div>' +
        '<h4>' + esc(t.name) + '</h4><p>R' + fmt(t.radius) + ' · ' + meta.short + '</p>' +
        '<div class="active-line"></div></button>';
    }).join('');
    strip.querySelectorAll('[data-tool]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.activeToolId = btn.getAttribute('data-tool');
        renderTools();
        renderToolParams();
        rebuild();
        saveState();
      });
    });
  }

  function fieldHtml(label, key, value, step) {
    return '<div class="field"><label>' + label + '</label>' +
      '<input class="select-input" data-param="' + key + '" type="number" inputmode="decimal" step="' + (step || 0.01) + '" value="' + value + '"></div>';
  }

  function renderToolParams() {
    const t = activeTool() || state.tools[0];
    if (!t) { $('toolParams').innerHTML = '<div class="diag-empty">暂无刀具</div>'; return; }
    const meta = toolMeta(t);
    const typeOpts = Object.keys(TYPE_META).map(function (k) {
      return '<option value="' + k + '"' + (t.type === k ? ' selected' : '') + '>' + TYPE_META[k].label + '</option>';
    }).join('');

    let extra = '';
    if (t.type === 'groove') {
      extra = '<div class="field-grid">' + fieldHtml('刀宽 (mm)', 'width', fmt(t.width), 0.1) +
        fieldHtml('刀杆角度 (°)', 'angle', t.angle, 1) + '</div>';
    } else if (t.type === 'thread') {
      extra = '<div class="field-grid">' + fieldHtml('螺距 (mm)', 'pitch', t.pitch, 0.1) +
        fieldHtml('牙型角 (°)', 'threadAngle', t.threadAngle, 1) + '</div>';
    } else {
      extra = '<div class="field-grid">' + fieldHtml('刀杆角度 (°)', 'angle', t.angle, 1) +
        fieldHtml('刀尖圆弧 R (mm)', 'radius', fmt(t.radius), 0.01) + '</div>';
    }

    $('toolParams').innerHTML =
      '<div class="card-head"><h3>' + esc(t.name) + ' <span class="tool-badge">T' + t.toolNo + '</span></h3>' +
      '<span class="pill">' + meta.label + '</span></div>' +
      '<div class="field-grid">' +
      '<div class="field"><label>刀具类型</label><select class="select-input" data-param="type">' + typeOpts + '</select></div>' +
      fieldHtml('刀号', 'toolNo', t.toolNo, 1) +
      '</div>' +
      extra +
      '<div class="field-grid">' +
      fieldHtml('几何补偿 X (直径)', 'geoX', fmt(t.geoX), 0.01) +
      fieldHtml('几何补偿 Z', 'geoZ', fmt(t.geoZ), 0.01) +
      '</div>' +
      '<div class="field-grid">' +
      fieldHtml('磨损补偿 X (直径)', 'wearX', fmt(t.wearX), 0.01) +
      fieldHtml('磨损补偿 Z', 'wearZ', fmt(t.wearZ), 0.01) +
      '</div>' +
      '<div class="tool-actions">' +
      '<button class="btn ghost delete-tool" id="btnDeleteTool"' + (state.tools.length <= 1 ? ' disabled style="opacity:.4"' : '') + '>删除刀具</button>' +
      '</div>' +
      '<p class="hint">程序 X/Z 为刀尖圆心轨迹；实际工件轮廓由程序轨迹向材料侧等距偏移刀尖半径 R 自动生成（直线平移 R、内凹圆弧 R+r、外凸圆弧 R−r、程序凹拐角留下半径 R 的包络弧）。几何/磨损补偿按刀库输入值整体平移实际轮廓：X 为直径量、Z 为轴向，按输入值方向平移。</p>';

    $('toolParams').querySelectorAll('[data-param]').forEach(function (el) {
      el.addEventListener('change', function () {
        const key = el.getAttribute('data-param');
        if (key === 'type') {
          t.type = el.value;
          if (t.type === 'groove' && !(Number(t.width) > 0)) t.width = 3;
          if (t.type === 'thread' && !(Number(t.pitch) > 0)) { t.pitch = 2; t.threadAngle = 60; }
          if (t.type === 'inner' && !(Number(t.radius) > 0)) t.radius = 0.4;
          renderTools();
          renderToolParams();
        } else {
          const v = num(el.value);
          t[key] = key === 'toolNo' ? Math.max(1, Math.round(v)) : v;
        }
        rebuild();
        saveState();
      });
    });

    const del = $('toolParams').querySelector('#btnDeleteTool');
    if (del && state.tools.length > 1) {
      del.addEventListener('click', function () {
        state.tools = state.tools.filter(function (x) { return x.id !== t.id; });
        state.activeToolId = state.tools[0].id;
        renderTools();
        renderToolParams();
        rebuild();
        saveState();
        toast('已删除 ' + t.name);
      });
    }
  }

  function addTool() {
    let maxNo = 0;
    state.tools.forEach(function (t) { maxNo = Math.max(maxNo, Number(t.toolNo) || 0); });
    const id = 't' + Date.now().toString(36);
    const tool = {
      id: id, toolNo: maxNo + 1, name: '外圆刀 ' + (maxNo + 1), type: 'outer',
      radius: 0.8, angle: 93, tip: 80, width: 0, pitch: 0, threadAngle: 0,
      geoX: 0, geoZ: 0, wearX: 0, wearZ: 0
    };
    state.tools.push(tool);
    state.activeToolId = id;
    renderTools();
    renderToolParams();
    rebuild();
    saveState();
    toast('已新增 T' + tool.toolNo);
  }

  /* ---------------- Sheet 通用 ---------------- */
  function showSheet(inner) {
    sheet.innerHTML = inner;
    sheet.classList.add('show');
    sheet.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const act = btn.getAttribute('data-act');
        if (act === 'closeSheet') {
          hideSheet();
        } else if (act === 'clearMeasure') {
          state.measurements = [];
          viewer.setMeasurements([]);
          renderMeasureSheet();
        }
      });
    });
  }

  function hideSheet() {
    sheet.classList.remove('show');
    sheet.innerHTML = '';
    sheetMode = null;
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () { setView(tab.getAttribute('data-view')); });
    });

    $('btnHelp').addEventListener('click', function () { $('modal').classList.add('show'); });
    $('btnCloseModal').addEventListener('click', function () { $('modal').classList.remove('show'); });
    $('modal').addEventListener('click', function (e) {
      if (e.target === $('modal')) $('modal').classList.remove('show');
    });

    $('btnGoProgram').addEventListener('click', function () { setView('program'); });

    $('quickKeys').querySelectorAll('[data-ins]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const text = btn.getAttribute('data-ins');
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.setRangeText(text, start, end, 'end');
        editor.focus();
        state.program = editor.value;
        scheduleParse();
      });
    });

    $('sampleSelect').addEventListener('change', function () {
      const key = $('sampleSelect').value;
      if (!key || !global.Samples[key]) return;
      state.program = global.Samples[key];
      editor.value = state.program;
      hideSheet();
      state.measurements = [];
      viewer.setMeasurements([]);
      rebuild({ fit: true });
      saveState();
      toast('已载入' + $('sampleSelect').selectedOptions[0].textContent);
      $('sampleSelect').value = '';
    });

    $('btnApply').addEventListener('click', function () {
      rebuild({ fit: true });
      saveState();
      toast('程序已应用 · ' + (parsed.stats.segments) + ' 个切削段');
    });
    editor.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        $('btnApply').click();
      }
    });
    editor.addEventListener('input', function () {
      state.program = editor.value;
      state.measurements = [];
      viewer.setMeasurements([]);
      scheduleParse();
    });
    editor.addEventListener('scroll', function () { gutter.scrollTop = editor.scrollTop; });
    gutter.addEventListener('click', function (e) {
      const d = e.target.closest('[data-line]');
      if (d) jumpToLine(Number(d.getAttribute('data-line')));
    });

    document.querySelectorAll('#modeSwitch [data-mode]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        applyMode(btn.getAttribute('data-mode'));
      });
    });

    $('btnGuideV').addEventListener('click', function () { setGuideTool('z'); });
    $('btnGuideH').addEventListener('click', function () { setGuideTool('r'); });
    $('btnGuideClear').addEventListener('click', function () {
      if (!state.guides.length) return;
      state.guides = [];
      viewer.setGuides(state.guides);
      hidePickPop();
      hideGuidePop();
      updateGuideUI();
    });
    guideInput.addEventListener('input', applyGuideInput);
    guideInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitGuideValue();
        hideGuidePop();
      }
    });
    $('btnGuideOk').addEventListener('click', function () {
      commitGuideValue();
      hideGuidePop();
    });
    $('btnGuideDel').addEventListener('click', function () {
      state.guides = state.guides.filter(function (g) { return g.id !== guideEditId; });
      viewer.setGuides(state.guides);
      hideGuidePop();
      updateGuideUI();
    });

    $('btnFit').addEventListener('click', function () {
      viewer.fit();
      updateZoom();
    });
    $('btnZoomIn').addEventListener('click', function () {
      viewer.zoomAt(1.4);
      updateZoom();
    });
    $('btnZoomOut').addEventListener('click', function () {
      viewer.zoomAt(1 / 1.4);
      updateZoom();
    });
    $('btnLayers').addEventListener('click', function () {
      $('layersPop').classList.toggle('show');
    });

    const layerMap = {
      tgNominal: 'nominal', tgStock: 'stock', tgDeviation: 'deviation',
      tgGrid: 'grid', tgChuck: 'chuck'
    };
    Object.keys(layerMap).forEach(function (id) {
      const el = $(id);
      const key = layerMap[id];
      el.checked = !!state.layers[key];
      el.addEventListener('change', function () {
        state.layers[key] = el.checked;
        viewer.setLayers(state.layers);
        saveState();
      });
    });

    $('stockDia').addEventListener('change', function () {
      state.stockDiameter = Math.max(1, num($('stockDia').value));
      $('stockDia').value = fmt(state.stockDiameter).replace(/\.000$/, '');
      $('stockState').textContent = fmt(state.stockDiameter) + ' mm';
      rebuild();
      saveState();
    });
    $('btnAddTool').addEventListener('click', addTool);

    document.querySelectorAll('[data-target="stockDia"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const d = Number(btn.getAttribute('data-step'));
        state.stockDiameter = Math.max(1, Math.round((state.stockDiameter + d * 0.5) * 1000) / 1000);
        $('stockDia').value = String(state.stockDiameter);
        $('stockState').textContent = fmt(state.stockDiameter) + ' mm';
        rebuild();
        saveState();
      });
    });

    // 点击图层弹层外部关闭
    document.addEventListener('pointerdown', function (e) {
      if (!$('layersPop').classList.contains('show')) return;
      if (e.target.closest('#layersPop') || e.target.closest('#btnLayers')) return;
      $('layersPop').classList.remove('show');
    });

    // 点击端点选择弹层外部关闭
    document.addEventListener('pointerdown', function (e) {
      if (!pickPop.classList.contains('show')) return;
      if (e.target.closest('#pickPop')) return;
      hidePickPop();
    });

    // 点击辅助线编辑弹层外部关闭
    document.addEventListener('pointerdown', function (e) {
      if (!guidePop.classList.contains('show')) return;
      if (e.target.closest('#guidePop')) return;
      hideGuidePop();
    });

    // viewer 回调
    viewer.onTap = onTap;
    viewer.onEndpointChoice = onEndpointChoice;
    viewer.onGuideAdd = function (axis, value) {
      state.guides.push({ id: 'g' + (guideSeq++), axis: axis, value: value });
      viewer.setGuides(state.guides);
      hidePickPop();
      updateGuideUI();
      toast((axis === 'z' ? '铅垂线 Z ' : '水平线 X ') + fmt(axis === 'z' ? value : value * 2));
    };
    viewer.onFeature = function (f) {
      state.selectedId = f.id;
      viewer.setSelected(f.id);
      renderFeatureSheet(f.id);
    };
    viewer.onDrag = onDrag;
    viewer.onReject = function (msg) { toast(msg); };
    viewer.onGuidePick = onGuidePick;

    // 缩放读数刷新（手势结束后）
    setInterval(function () {
      if (state.view === 'contour' && !document.hidden) updateZoom();
    }, 600);
  }

  /* ---------------- 逆向：当前程序 → 加工程序 ---------------- */

  function revRefreshToolSelect() {
    const sel = $('revToolSelect');
    if (!sel) return;
    sel.innerHTML = state.tools.map(function (t) {
      return '<option value="' + t.id + '">T' + t.toolNo + ' ' + esc(t.name) + ' · R' + fmt(t.radius) + '</option>';
    }).join('');
    if (state.tools.some(function (t) { return t.id === state.activeToolId; })) {
      sel.value = state.activeToolId;
    }
  }

  /* 当前程序的切削段 → 目标工件轮廓特征链（程序路径即实际轮廓） */
  function revSourceFeatures() {
    // 程序页已被“生成程序”覆盖时，仍以覆盖前的原始程序作为目标轮廓，避免二次偏移
    const reuseStored = revState.generatedText && revState.sourceText &&
      state.program === revState.generatedText;
    const srcParsed = reuseStored
      ? global.ProgramParser.parse(revState.sourceText, state.tools, { activeToolId: state.activeToolId })
      : parsed;
    if (!srcParsed || !srcParsed.cutting) return { feats: [], error: '当前程序无法解析' };
    const cut = srcParsed.cutting.filter(function (f) {
      if (f.rapid) return false;
      if (f.type === 'arc' && !f.center) return false;
      return !(Math.abs(f.start.d - f.end.d) < 1e-4 && Math.abs(f.start.z - f.end.z) < 1e-4);
    });
    if (!cut.length) return { feats: [], error: '当前程序没有可用的切削路径' };
    // 按端点连续性拆成若干条链，取总长最长的一条（避免把 G00 跳刀后的两段连成一条）
    const chains = [];
    cut.forEach(function (f) {
      const last = chains.length ? chains[chains.length - 1] : null;
      const prevEnd = last ? last.feats[last.feats.length - 1].end : null;
      const cont = prevEnd && Math.hypot(f.start.d - prevEnd.d, f.start.z - prevEnd.z) < 1e-3;
      if (cont) last.feats.push(f);
      else chains.push({ feats: [f], len: 0 });
    });
    chains.forEach(function (c) {
      c.len = c.feats.reduce(function (s, f) {
        return s + Math.hypot(f.end.z - f.start.z, (f.end.d - f.start.d) / 2);
      }, 0);
    });
    chains.sort(function (a, b) { return b.len - a.len; });
    const composed = global.Geometry.composeChain(chains[0].feats, { autoRadius: 0 });
    const feats = composed.features.map(function (f) {
      const o = {
        id: f.id, type: f.type,
        start: f.start, end: f.end,
        center: f.center || null,
        radius: f.radius || 0,
        cw: !!f.cw, rapid: false, offset: false
      };
      if (o.type === 'arc' && o.center && !(o.radius > 0)) {
        o.radius = Math.hypot(o.end.d / 2 - o.center.r, o.end.z - o.center.z);
      }
      return o;
    });
    return { feats: feats, warnings: composed.warnings || [], error: null, reuseStored: !!reuseStored };
  }

  function revSourceSummary(src) {
    if (!src.feats.length) {
      return '<div class="rev-source-row"><span>' + esc(src.error || '无可用切削路径') + '</span></div>';
    }
    let lineCnt = 0, arcCnt = 0, minZ = Infinity, maxZ = -Infinity, maxD = 0;
    src.feats.forEach(function (f) {
      if (f.type === 'arc') arcCnt++; else lineCnt++;
      minZ = Math.min(minZ, f.start.z, f.end.z);
      maxZ = Math.max(maxZ, f.start.z, f.end.z);
      maxD = Math.max(maxD, f.start.d, f.end.d);
    });
    return '<div class="rev-source-row"><span>切削段</span><b>' + src.feats.length + ' 段</b></div>' +
      (src.reuseStored ? '<div class="rev-source-row"><span>来源</span><b>生成前的原始程序</b></div>' : '') +
      '<div class="rev-source-row"><span>直线 / 圆弧</span><b>' + lineCnt + ' / ' + arcCnt + '</b></div>' +
      '<div class="rev-source-row"><span>Z 范围</span><b>' + fmt(minZ) + ' ~ ' + fmt(maxZ) + '</b></div>' +
      '<div class="rev-source-row"><span>最大直径</span><b>Ø' + fmt(maxD) + '</b></div>';
  }

  function revCollectTool() {
    return {
      radius: Math.max(0, parseFloat($('revRadius').value) || 0),
      side: $('revSidePlus').classList.contains('is-on') ? 1 : -1,
      toolNo: parseInt($('revToolNo').value, 10) || 1,
      toolName: $('revToolName').value || '加工程序'
    };
  }

  function revCollectGcodeOpts() {
    return {
      programNo: parseInt($('revProgNo').value, 10) || 1007,
      units: 'mm',
      spindle: parseInt($('revSpindle').value, 10) || 2500,
      speed: parseFloat($('revSpeed').value) || 180,
      feed: parseFloat($('revFeed').value) || 0.2,
      coolant: $('revCoolantOn').classList.contains('is-on')
    };
  }

  function revSetSide(side) {
    $('revSidePlus').classList.toggle('is-on', side > 0);
    $('revSideMinus').classList.toggle('is-on', side < 0);
  }

  /* 回代验证：生成程序按正向算法偏移后，与实际轮廓比较（包络弧除外） */
  function revVerify(targetFeats, progFeats, r, side) {
    if (!targetFeats.length) return { maxDev: 0, envCount: 0, ok: true };
    const back = global.Geometry.offsetChain(progFeats, r, side);
    const used = back.features.filter(function (f) { return !f.envelope; });
    if (!used.length) return { maxDev: 0, envCount: 0, ok: true };
    const ref = [];
    targetFeats.forEach(function (f) {
      global.Geometry.sampleFeature(f, 0.02).forEach(function (p) { ref.push(p); });
    });
    let maxDev = 0;
    used.forEach(function (f) {
      global.Geometry.sampleFeature(f, 0.05).forEach(function (p) {
        const hit = global.Geometry.nearestOnPolyline(ref, p);
        if (hit && hit.distance > maxDev) maxDev = hit.distance;
      });
    });
    const envCount = back.features.length - used.length;
    return { maxDev: maxDev, envCount: envCount, ok: maxDev <= 0.01 };
  }

  /* 逆向主流程：当前程序 → 目标轮廓 → 刀心轨迹 → G 代码 */
  function revGenerate(silent) {
    const src = revSourceFeatures();
    $('revSourceInfo').innerHTML = revSourceSummary(src);
    if (src.error || !src.feats.length) {
      if (!silent) toast(src.error || '当前程序没有可用的切削路径');
      $('revPreviewState').textContent = '无可用轮廓';
      $('revPreviewState').className = 'pill warn';
      return false;
    }

    const toolOpts = revCollectTool();
    const r = toolOpts.radius;
    const side = toolOpts.side;
    let prog, gcode, verify;
    try {
      prog = global.ReverseContour.reverseContour(src.feats, r, side).features;
      let maxD = 0, maxZ = -Infinity;
      prog.forEach(function (f) {
        maxD = Math.max(maxD, f.start.d, f.end.d);
        maxZ = Math.max(maxZ, f.start.z, f.end.z);
      });
      const gcodeOpts = revCollectGcodeOpts();
      gcodeOpts.toolNo = toolOpts.toolNo;
      gcodeOpts.toolName = toolOpts.toolName;
      gcodeOpts.startD = maxD + 4;
      gcodeOpts.startZ = Math.max(maxZ, 0) + 2;
      gcodeOpts.safetyD = maxD + 6;
      gcodeOpts.safetyZ = gcodeOpts.startZ;
      gcodeOpts.retractEnd = true;
      gcode = global.ReverseContour.generateGcode(prog, gcodeOpts);
      verify = revVerify(src.feats, prog, r, side);
    } catch (e) {
      toast('生成失败：' + e.message);
      $('revPreviewState').textContent = '生成失败';
      $('revPreviewState').className = 'pill warn';
      return false;
    }

    if (!src.reuseStored) revState.sourceText = state.program;
    revState.generatedText = gcode;
    revState.lastPipeline = { source: src, programFeatures: prog, gcode: gcode, verify: verify, toolOpts: toolOpts };

    $('revGcodeOutput').value = gcode;
    $('revGcodeStats').textContent = gcode.split('\n').length + ' 行 · ' + prog.length + ' 段';
    revDrawPreview(src.feats, prog);

    const msgs = (src.warnings || []).slice();
    if (!verify.ok) msgs.push('回代偏差 ' + fmt(verify.maxDev) + ' mm，超过 0.01 mm，请检查轮廓是否连续。');
    if (verify.envCount) msgs.push('检测到 ' + verify.envCount + ' 处尖角包络弧（半径 R' + fmt(r) + '），属正常现象。');
    revShowDiag(msgs);

    $('revPreviewState').textContent = '已生成 · 回代偏差 ' + fmt(verify.maxDev) + ' mm';
    $('revPreviewState').className = 'pill ' + (verify.ok ? 'good' : 'warn');
    if (!silent) toast('已生成 ' + prog.length + ' 段程序');
    return true;
  }

  function revShowDiag(msgs) {
    const card = $('revDiagCard');
    if (!msgs.length) { card.style.display = 'none'; return; }
    card.style.display = '';
    $('revDiagList').innerHTML = msgs.map(function (w) {
      return '<div class="diag-item warn"><span class="ln">!</span><span>' + esc(w) + '</span></div>';
    }).join('');
  }

  function revScheduleGenerate() {
    clearTimeout(revState.debounceTimer);
    revState.debounceTimer = setTimeout(function () {
      revGenerate(true);
    }, 350);
  }

  /* 绘制 SVG 预览：实际轮廓（绿）+ 逆向程序轨迹（蓝虚线） */
  function revDrawPreview(actualFeats, progFeats) {
    const svg = $('revPreviewSvg');
    const W = 400, H = 240;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

    // 收集所有端点做 bounds
    const allPts = [];
    function collect(feats) {
      if (!feats) return;
      feats.forEach(function (f) {
        if (f.start) allPts.push({ d: f.start.d, z: f.start.z });
        if (f.end) allPts.push({ d: f.end.d, z: f.end.z });
        if (f.center) allPts.push({ d: f.center.r * 2, z: f.center.z });
      });
    }
    collect(actualFeats);
    collect(progFeats);

    if (!allPts.length) {
      svg.innerHTML = '<text x="' + (W/2) + '" y="' + (H/2) + '" fill="#5e718b" font-size="12" text-anchor="middle">暂无数据</text>';
      return;
    }

    // 留边距
    let minD = Infinity, maxD = -Infinity, minZ = Infinity, maxZ = -Infinity;
    allPts.forEach(function (p) {
      minD = Math.min(minD, p.d); maxD = Math.max(maxD, p.d);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    });
    const padD = Math.max(4, (maxD - minD) * 0.12);
    const padZ = Math.max(4, (maxZ - minZ) * 0.12);
    minD -= padD; maxD += padD;
    minZ -= padZ; maxZ += padZ;
    // X 轴为直径，映射到真实半径比例：X 方向是半径差/2，Z 方向是轴向
    // 在 SVG 中：水平方向画 Z（轴向），垂直方向画半径（D/2），上下翻转使负 Z 在下
    const spanZ = maxZ - minZ || 1;
    const spanR = (maxD - minD) / 2 || 1;
    const marginL = 28, marginR = 14, marginT = 14, marginB = 20;
    const plotW = W - marginL - marginR;
    const plotH = H - marginT - marginB;
    const scale = Math.min(plotW / spanZ, plotH / spanR);
    const offsetZ = (plotW - spanZ * scale) / 2;
    const offsetR = (plotH - spanR * scale) / 2;

    const xOfZ = function (z) { return marginL + offsetZ + (z - minZ) * scale; };
    const yOfD = function (d) { return marginT + offsetR + spanR * scale - ((d / 2) - minD / 2) * scale; };

    // 画网格
    let grid = '';
    const zStep = niceStep(spanZ, 6);
    const dStep = niceStep((maxD - minD), 6);
    for (let z = Math.ceil(minZ / zStep) * zStep; z <= maxZ + 1e-6; z += zStep) {
      const x = xOfZ(z);
      grid += '<line class="rev-grid-line" x1="' + x.toFixed(1) + '" y1="' + marginT + '" x2="' + x.toFixed(1) + '" y2="' + (marginT + plotH) + '"/>';
    }
    for (let d = Math.ceil(minD / dStep) * dStep; d <= maxD + 1e-6; d += dStep) {
      const y = yOfD(d);
      grid += '<line class="rev-grid-line" x1="' + marginL + '" y1="' + y.toFixed(1) + '" x2="' + (marginL + plotW) + '" y2="' + y.toFixed(1) + '"/>';
    }
    // 画轴线（Z=0 或 D=0）
    let axis = '';
    if (minZ < 0 && maxZ >= 0) {
      const x = xOfZ(0);
      axis += '<line class="rev-axis-line" x1="' + x.toFixed(1) + '" y1="' + marginT + '" x2="' + x.toFixed(1) + '" y2="' + (marginT + plotH) + '"/>';
    }
    if (minD < 0 && maxD >= 0) {
      const y = yOfD(0);
      axis += '<line class="rev-axis-line" x1="' + marginL + '" y1="' + y.toFixed(1) + '" x2="' + (marginL + plotW) + '" y2="' + y.toFixed(1) + '"/>';
    }

    svg.innerHTML = grid + axis +
      revRenderFeats(actualFeats, xOfZ, yOfD, 'actual') +
      revRenderFeats(progFeats, xOfZ, yOfD, 'nominal');

    function niceStep(range, targetDiv) {
      const raw = range / targetDiv;
      const exp = Math.pow(10, Math.floor(Math.log10(raw)));
      const f = raw / exp;
      let nf;
      if (f < 1.5) nf = 1; else if (f < 3.5) nf = 2; else if (f < 7.5) nf = 5; else nf = 10;
      return nf * exp;
    }
  }

  function revRenderFeats(feats, xOfZ, yOfD, cls) {
    if (!feats || !feats.length) return '';
    let out = '';
    feats.forEach(function (f) {
      const x1 = xOfZ(f.start.z), y1 = yOfD(f.start.d);
      const x2 = xOfZ(f.end.z), y2 = yOfD(f.end.d);
      if (f.type === 'arc' && f.center) {
        // 圆弧 SVG：计算 sweep flag 和 large arc flag
        const cx = xOfZ(f.center.z), cy = yOfD(f.center.r * 2);
        const r = Math.hypot(x1 - cx, y1 - cy);
        const sweep = f.cw ? 0 : 1;  // SVG y 轴翻转后，方向取反
        // large-arc-flag：计算扫过角度
        const ang1 = Math.atan2(y1 - cy, x1 - cx);
        const ang2 = Math.atan2(y2 - cy, x2 - cx);
        let delta = ang2 - ang1;
        if (delta > Math.PI) delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;
        // 调整：cw 时 delta 应为负（SVG 翻转坐标系后）
        const largeArc = Math.abs(delta) > Math.PI ? 1 : 0;
        out += '<path class="rev-arc-' + cls + '" d="M' + x1.toFixed(2) + ',' + y1.toFixed(2) +
          ' A' + r.toFixed(2) + ',' + r.toFixed(2) + ' 0 ' + largeArc + ' ' + sweep +
          ' ' + x2.toFixed(2) + ',' + y2.toFixed(2) + '"/>';
      } else {
        out += '<line class="rev-line-' + cls + '" x1="' + x1.toFixed(2) + '" y1="' + y1.toFixed(2) +
          '" x2="' + x2.toFixed(2) + '" y2="' + y2.toFixed(2) + '"/>';
      }
      // 端点
      out += '<circle class="rev-pt-' + cls + '" cx="' + x2.toFixed(2) + '" cy="' + y2.toFixed(2) + '" r="3"/>';
    });
    // 起点
    const f0 = feats[0];
    if (f0 && f0.start) {
      out = '<circle class="rev-pt-' + cls + '" cx="' + xOfZ(f0.start.z).toFixed(2) +
        '" cy="' + yOfD(f0.start.d).toFixed(2) + '" r="3"/>' + out;
    }
    return out;
  }

  /* ---------------- 逆向事件绑定 ---------------- */
  function bindReverse() {
    // 使用说明弹窗
    const revHelp = $('revHelpModal');
    $('btnRevHelp').addEventListener('click', function () { revHelp.classList.add('show'); });
    $('btnRevHelpClose').addEventListener('click', function () { revHelp.classList.remove('show'); });
    revHelp.addEventListener('click', function (e) {
      if (e.target === revHelp) revHelp.classList.remove('show');
    });
    revHelp.querySelectorAll('.doc-toc a').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        const target = revHelp.querySelector(a.getAttribute('href'));
        const card = revHelp.querySelector('.modal-card');
        if (!target || !card) return;
        const top = target.getBoundingClientRect().top - card.getBoundingClientRect().top + card.scrollTop - 46;
        card.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && revHelp.classList.contains('show')) revHelp.classList.remove('show');
    });

    // 刀具选择 → 同步 R / 刀号 / 方向
    $('revToolSelect').addEventListener('change', function () {
      const t = state.tools.find(function (x) { return x.id === $('revToolSelect').value; });
      if (!t) return;
      $('revRadius').value = fmt(t.radius);
      $('revToolNo').value = t.toolNo;
      $('revToolName').value = t.name;
      revSetSide(t.type === 'inner' ? -1 : 1);
      revScheduleGenerate();
    });

    // side 切换
    $('revSidePlus').addEventListener('click', function () { revSetSide(+1); revScheduleGenerate(); });
    $('revSideMinus').addEventListener('click', function () { revSetSide(-1); revScheduleGenerate(); });

    // 切削液
    $('revCoolantOff').addEventListener('click', function () { $('revCoolantOff').classList.add('is-on'); $('revCoolantOn').classList.remove('is-on'); revScheduleGenerate(); });
    $('revCoolantOn').addEventListener('click', function () { $('revCoolantOn').classList.add('is-on'); $('revCoolantOff').classList.remove('is-on'); revScheduleGenerate(); });

    // 数值 / 文本输入
    document.querySelectorAll('#view-reverse input[type=number], #view-reverse input[type=text]').forEach(function (el) {
      el.addEventListener('change', revScheduleGenerate);
    });

    // 刀尖半径 step 按钮
    document.querySelectorAll('[data-rev-step]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const el = $(btn.getAttribute('data-target'));
        const delta = Number(btn.getAttribute('data-rev-step')) * 0.05;
        el.value = fmt(Math.min(3, Math.max(0, (parseFloat(el.value) || 0) + delta)));
        revScheduleGenerate();
      });
    });

    // 重新读取当前程序
    $('revReload').addEventListener('click', function () {
      revRefreshToolSelect();
      revGenerate(false);
    });

    // 主生成按钮：生成并直接写入程序页
    $('btnRevGenerate').addEventListener('click', function () {
      if (revGenerate(false)) revApplyCurrent(true);
    });

    // 复制 G 代码
    $('revBtnCopy').addEventListener('click', function () {
      const text = $('revGcodeOutput').value;
      if (!text) { toast('暂无 G 代码'); return; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('已复制到剪贴板'); });
      } else {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast('已复制到剪贴板'); } catch (e) { toast('复制失败'); }
        document.body.removeChild(ta);
      }
    });

    // 下载 .nc
    $('revBtnDownload').addEventListener('click', function () {
      const text = $('revGcodeOutput').value;
      if (!text) { toast('暂无 G 代码'); return; }
      const progNo = $('revProgNo').value || '1007';
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'O' + progNo + '.nc';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('已导出 O' + progNo + '.nc');
    });

    // 替换当前程序（生成后自动写入时无需再点，保留用于手动重新写入）
    $('revBtnApply').addEventListener('click', function () { revApplyCurrent(false); });
  }

  /* 把生成的 G 代码写入“程序”页；stayHere=true 时停留在逆向页 */
  function revApplyCurrent(stayHere) {
    const text = $('revGcodeOutput').value;
    if (!text) { toast('暂无 G 代码可替换'); return false; }
    state.program = text;
    editor.value = text;
    state.measurements = [];
    viewer.setMeasurements([]);
    rebuild({ fit: true });
    saveState();
    if (stayHere) {
      toast('已生成并写入程序页 · ' + (parsed ? parsed.stats.segments : 0) + ' 段');
    } else {
      hideSheet();
      setView('program');
      toast('已替换当前程序 · ' + (parsed ? parsed.stats.segments : 0) + ' 段切削');
    }
    return true;
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    loadState();
    editor.value = state.program;
    $('stockDia').value = String(state.stockDiameter);
    $('stockState').textContent = fmt(state.stockDiameter) + ' mm';
    $('sampleSelect').value = '';
    viewer.setLayers(state.layers);
    viewer.setMode(state.mode);
    viewer.setGuides(state.guides);
    document.querySelectorAll('#modeSwitch [data-mode]').forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-mode') === state.mode);
    });
    updateStageHint();
    updateGuideUI();

    bind();
    bindReverse();
    renderTools();
    renderToolParams();
    rebuild({ fit: true });
    if (state.selectedId >= 0) viewer.setSelected(state.selectedId);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
