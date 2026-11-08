/* SVG 轮廓视图：矢量渲染、缩放平移、点选测量、特征拖拽 */
(function (global) {
  'use strict';

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function fmt(v) { return (Math.round(v * 1000) / 1000).toFixed(3); }
  function niceStep(scale, minPx) {
    const steps = [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];
    for (const s of steps) if (s * scale >= minPx) return s;
    return 500;
  }
  function tickFmt(v, step) {
    const dec = step < 0.1 ? 3 : step < 1 ? 2 : step < 10 ? 1 : 0;
    let s = v.toFixed(dec);
    if (s === '-0.0' || s === '-0') s = '0';
    return s;
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  class Viewer {
    constructor(svg) {
      this.svg = svg;
      this.stage = svg.parentElement;
      this.view = null;
      this.fitScale = 1;
      this.parsed = null;
      this.sim = null;
      this.settings = { stockDiameter: 60 };
      this.mode = 'measure';
      this.selectedId = -1;
      this.measurements = [];
      this.layers = {
        nominal: true, stock: true, deviation: true, grid: true, chuck: true
      };
      this.pointers = new Map();
      this.gesture = null;
      this.drag = null;
      this._raf = 0;
      this.guides = [];
      this.guideTool = null;
      this.onTap = null;
      this.onEndpointChoice = null;
      this.onGuideAdd = null;
      this.onGuidePick = null;
      this.onFeature = null;
      this.onDrag = null;
      this.onReject = null;
      this.bind();
    }

    bind() {
      const svg = this.svg;
      svg.addEventListener('pointerdown', this._down.bind(this));
      svg.addEventListener('pointermove', this._move.bind(this));
      svg.addEventListener('pointerup', this._up.bind(this));
      svg.addEventListener('pointercancel', this._up.bind(this));
      svg.addEventListener('wheel', this._wheel.bind(this), { passive: false });
      this._resize = this._onResize.bind(this);
      if (window.ResizeObserver) {
        this._ro = new ResizeObserver(this._resize);
        this._ro.observe(this.stage);
      }
    }

    _onResize() {
      if (!this.view) this.fit();
      else this.render();
    }

    setData(parsed, sim, settings, opts) {
      this.parsed = parsed;
      this.sim = sim;
      this.settings = settings || this.settings;
      if (opts && opts.fit) this.fit();
      else if (!this.view) this.fit();
      else this.render();
    }

    setMode(mode) {
      this.mode = mode;
      this.render();
    }

    setSelected(id) {
      this.selectedId = id;
      this.render();
    }

    setMeasurements(points) {
      this.measurements = points || [];
      this.render();
    }

    /* 辅助线：铅垂线（axis='z'，等 Z）/ 水平线（axis='r'，等 X）；纯测量基准，不参与刀尖半径偏移 */
    setGuides(list) {
      this.guides = (list || []).slice();
      this.render();
    }

    setGuideTool(tool) {
      this.guideTool = tool || null;
      this.svg.style.cursor = this.guideTool ? 'crosshair' : '';
      this.render();
    }

    setLayers(layers) {
      this.layers = Object.assign(this.layers, layers);
      this.render();
    }

    worldToScreen(z, r) {
      const v = this.view;
      return { x: v.ox + (z - v.z0) * v.scale, y: v.oy - r * v.scale };
    }

    screenToWorld(x, y) {
      const v = this.view;
      return { z: v.z0 + (x - v.ox) / v.scale, r: (v.oy - y) / v.scale };
    }

    bounds() {
      const sim = this.sim;
      let zMin = sim ? sim.zMin : -50, zMax = sim ? sim.zMax : 0;
      let rMax = sim ? sim.stockRadius : 30;
      if (sim) {
        for (const p of sim.outerPoints) rMax = Math.max(rMax, p.r);
        for (const p of sim.innerPoints) rMax = Math.max(rMax, p.r);
        for (const c of sim.outerChains || []) for (const p of c.points) rMax = Math.max(rMax, p.r);
        for (const c of sim.innerChains || []) for (const p of c.points) rMax = Math.max(rMax, p.r);
        for (const c of sim.nominalChains) for (const p of c.points) rMax = Math.max(rMax, p.r);
      }
      if (this.parsed) {
        for (const f of this.parsed.cutting) rMax = Math.max(rMax, f.start.d / 2, f.end.d / 2);
      }
      rMax = Math.max(rMax, 5) * 1.04;
      return { zMin: zMin, zMax: zMax, rMax: rMax };
    }

    fit() {
      const rect = this.svg.getBoundingClientRect();
      const W = Math.max(1, rect.width), H = Math.max(1, rect.height);
      const b = this.bounds();
      const spanZ = Math.max(0.2, b.zMax - b.zMin);
      const spanR = Math.max(0.2, b.rMax);
      const padL = 50, padR = 26, padT = 30, padB = 40;
      const aw = W - padL - padR, ah = H - padT - padB;
      let scale = Math.min(aw / spanZ, ah / spanR);
      scale = clamp(scale, 0.5, 1200);
      const extraZ = aw - spanZ * scale;
      const ox = padL + extraZ / 2 - b.zMin * scale;
      const oy = H - padB;
      this.view = { scale: scale, ox: ox, oy: oy, z0: 0 };
      this.fitScale = scale;
      this.render();
    }

    zoomAt(factor, px, py) {
      if (!this.view) return;
      const rect = this.svg.getBoundingClientRect();
      const x = px == null ? rect.width / 2 : px;
      const y = py == null ? rect.height / 2 : py;
      const w = this.screenToWorld(x, y);
      const ns = clamp(this.view.scale * factor, 0.5, 5000);
      this.view.scale = ns;
      this.view.ox = x - w.z * ns;
      this.view.oy = y + w.r * ns;
      this.render();
    }

    _wheel(e) {
      e.preventDefault();
      const rect = this.svg.getBoundingClientRect();
      this.zoomAt(e.deltaY < 0 ? 1.22 : 1 / 1.22, e.clientX - rect.left, e.clientY - rect.top);
    }

    _down(e) {
      if (!this.view) return;
      const handle = e.target.closest ? e.target.closest('[data-handle]') : null;
      if (handle && this.mode === 'edit') {
        const id = Number(handle.getAttribute('data-feature'));
        const f = this.parsed && this.parsed.cutting.find(function (x) { return x.id === id; });
        if (f) {
          e.preventDefault();
          this.drag = { feature: f, pointerId: e.pointerId };
          this._dragMove = this._featureDragMove.bind(this);
          this._dragEnd = this._featureDragEnd.bind(this);
          window.addEventListener('pointermove', this._dragMove);
          window.addEventListener('pointerup', this._dragEnd);
          window.addEventListener('pointercancel', this._dragEnd);
          return;
        }
      }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false });
      this._updateGesture(e);
    }

    _updateGesture(e) {
      if (this.pointers.size === 2) {
        const arr = Array.from(this.pointers.values());
        const mid = { x: (arr[0].x + arr[1].x) / 2, y: (arr[0].y + arr[1].y) / 2 };
        const d = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
        this.gesture = { type: 'pinch', d0: d, mid0: mid, scale0: this.view.scale, ox0: this.view.ox, oy0: this.view.oy };
        const rect = this.svg.getBoundingClientRect();
        const w = this.screenToWorld(mid.x - rect.left, mid.y - rect.top);
        this.gesture.w = w;
      } else if (this.pointers.size === 1) {
        const p = Array.from(this.pointers.values())[0];
        this.gesture = { type: 'pan', startX: p.sx, startY: p.sy, ox0: this.view.ox, oy0: this.view.oy, pointerId: e.pointerId };
      } else {
        this.gesture = null;
      }
    }

    _move(e) {
      if (!this.view) return;
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX; p.y = e.clientY;
      const dx = p.x - p.sx, dy = p.y - p.sy;
      if (Math.hypot(dx, dy) > 6) p.moved = true;

      if (this.pointers.size === 2 && this.gesture && this.gesture.type === 'pinch') {
        const arr = Array.from(this.pointers.values());
        const mid = { x: (arr[0].x + arr[1].x) / 2, y: (arr[0].y + arr[1].y) / 2 };
        const d = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
        const ratio = d / Math.max(1, this.gesture.d0);
        const ns = clamp(this.gesture.scale0 * ratio, 0.5, 5000);
        const rect = this.svg.getBoundingClientRect();
        const mx = mid.x - rect.left, my = mid.y - rect.top;
        const w = this.gesture.w;
        this.view.scale = ns;
        this.view.ox = mx - w.z * ns;
        this.view.oy = my + w.r * ns;
        p.moved = true;
        this.render();
        return;
      }

      if (this.pointers.size === 1 && this.gesture && this.gesture.type === 'pan' && p.moved) {
        this.view.ox = this.gesture.ox0 + dx;
        this.view.oy = this.gesture.oy0 + dy;
        this.render();
      }
    }

    _up(e) {
      if (this.drag) return;
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      const wasSingle = this.gesture && this.gesture.type === 'pan';
      const tap = wasSingle && p && !p.moved && !this.gesture.wasPinch;
      if (this.pointers.size === 0) {
        if (tap) this._handleTap(e);
        this.gesture = null;
      } else {
        this._updateGesture(e);
        if (this.gesture) this.gesture.wasPinch = true;
      }
    }

    _handleTap(e) {
      const rect = this.svg.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const w = this.screenToWorld(x, y);
      if (this.mode === 'measure') {
        // 辅助线绘制：落点优先吸附已有基准点，便于让线精确穿过轮廓特征点
        if (this.guideTool) {
          const snap = this._pickSnap(x, y);
          const value = Geometry.r3(this.guideTool === 'z'
            ? (snap ? snap.z : w.z)
            : (snap ? snap.r : w.r));
          if (this.onGuideAdd) this.onGuideAdd(this.guideTool, value);
          return;
        }
        const pick = this._pickSnap(x, y);
        if (pick && this.onTap) {
          this.onTap(pick, x, y);
          return;
        }
        // 点中辅助线本身：打开数值编辑，精确定位（交点已由上面的吸附优先处理）
        const gp = this._pickGuide(x, y);
        if (gp) {
          if (this.onGuidePick) this.onGuidePick(gp.guide, e.clientX, e.clientY);
          return;
        }
        // 点到特征线的非端点位置：不报警，改为提供该线段的两个端点供选择
        const ends = this._pickFeatureEndpoints(x, y);
        if (ends && this.onEndpointChoice) {
          this.onEndpointChoice(ends, e.clientX, e.clientY);
          return;
        }
        if (this.onReject) this.onReject('未点中轮廓特征线，请点击实际轮廓的线段、端点或交点。');
      } else if (this.mode === 'edit') {
        if (!this.parsed) return;
        const rMax = Math.max(3.0, 20 / this.view.scale);
        const hit = Geometry.nearestFeature(this.parsed.cutting, w, rMax);
        if (hit && this.onFeature) this.onFeature(hit.feature, x, y);
      }
    }

    /* 命中辅助线本身（8px 容差），用于打开数值编辑 */
    _pickGuide(sx, sy) {
      if (!this.guides || !this.guides.length) return null;
      let best = null;
      for (const g of this.guides) {
        const s = g.axis === 'z' ? this.worldToScreen(g.value, 0) : this.worldToScreen(0, g.value);
        const dpx = Math.abs(g.axis === 'z' ? s.x - sx : s.y - sy);
        if (dpx <= 8 && (!best || dpx < best.dpx)) best = { dpx: dpx, guide: g };
      }
      return best;
    }

    /* 仅吸附程序特征端点 / 相邻特征交点 / 辅助线交点，禁止线上任意点 */
    _pickSnap(sx, sy) {
      const sim = this.sim;
      if (!sim) return null;
      const cands = [];
      if (sim.snapPoints) for (const n of sim.snapPoints) cands.push(n);
      for (const n of this.guidePoints()) cands.push(n);
      let best = null;
      for (const n of cands) {
        const s = this.worldToScreen(n.z, n.r);
        const dpx = Math.hypot(s.x - sx, s.y - sy);
        if (dpx <= 24 && (!best || dpx < best.dpx)) best = { dpx: dpx, node: n };
      }
      if (!best) return null;
      const n = best.node;
      return {
        z: n.z, r: n.r, d: n.d, kind: n.kind,
        node: n, type: n.type,
        featureIds: (n.featureIds || []).slice(),
        sx: sx, sy: sy
      };
    }

    /* 取实际轮廓上离点击点最近的特征，返回其两个端点（匹配到基准节点） */
    _pickFeatureEndpoints(sx, sy) {
      const sim = this.sim;
      if (!sim || !this.view) return null;
      const feats = [];
      for (const c of (sim.outerChains || [])) for (const f of (c.feats || [])) feats.push(f);
      for (const c of (sim.innerChains || [])) for (const f of (c.feats || [])) feats.push(f);
      if (!feats.length) return null;
      const w = this.screenToWorld(sx, sy);
      const hit = Geometry.nearestFeature(feats, w, Math.max(3, 24 / this.view.scale));
      if (!hit || !hit.feature) return null;
      const f = hit.feature;
      const out = [];
      const ends = [{ role: '起点', p: f.start }, { role: '终点', p: f.end }];
      for (const e of ends) {
        if (!e.p) continue;
        const n = (sim.snapPoints || []).find(function (node) {
          return Math.abs(node.z - e.p.z) < 1e-3 && Math.abs(node.d - e.p.d) < 1e-3;
        });
        if (!n) continue;
        if (out.some(function (q) { return q.node === n; })) continue;
        out.push({
          z: n.z, r: n.r, d: n.d, kind: n.kind, node: n, type: n.type,
          featureIds: (n.featureIds || []).slice(), role: e.role
        });
      }
      return out.length ? out : null;
    }

    /* 辅助线与实际轮廓的交点（可直接作为测量基准） */
    guidePoints() {
      const out = [];
      if (!this.sim || !this.guides || !this.guides.length) return out;
      const groups = [
        { list: this.sim.outerChains || [], kind: 'outer' },
        { list: this.sim.innerChains || [], kind: 'inner' }
      ];
      for (const g of this.guides) {
        for (const grp of groups) {
          for (const c of grp.list) {
            if (!c.feats || !c.feats.length) continue;
            const hits = Geometry.guideIntersections(c.feats, g.axis, g.value);
            for (const h of hits) {
              if (!this._onChain(c, h)) continue;
              out.push({
                z: h.z, r: h.r, d: h.d, kind: grp.kind, type: '辅助线交点',
                featureIds: h.featureId != null ? [h.featureId] : [],
                featureType: h.featureType,
                guideId: g.id, guideAxis: g.axis, guideValue: g.value,
                label: 'X' + fmt(h.d) + ' Z' + fmt(h.z)
              });
            }
          }
        }
      }
      return out;
    }

    /* 交点必须落在实际绘制的（已裁剪到 Z≤0 的）轮廓范围内，避免显示被裁掉的引入段交点 */
    _onChain(c, h) {
      const pts = c.points || [];
      if (!pts.length) return true;
      let zMin = Infinity, zMax = -Infinity, rMin = Infinity, rMax = -Infinity;
      for (const p of pts) {
        if (p.z < zMin) zMin = p.z;
        if (p.z > zMax) zMax = p.z;
        if (p.r < rMin) rMin = p.r;
        if (p.r > rMax) rMax = p.r;
      }
      const pad = 0.05;
      return h.z >= zMin - pad && h.z <= zMax + pad && h.r >= rMin - pad && h.r <= rMax + pad;
    }

    _featureDragMove(e) {
      if (!this.drag) return;
      const rect = this.svg.getBoundingClientRect();
      const w = this.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const f = this.drag.feature;
      const end = { d: Math.max(0, Math.round(w.r * 2 * 1000) / 1000), z: Math.round(w.z * 1000) / 1000 };
      if (this.onDrag) this.onDrag(f, end, 'move');
    }

    _featureDragEnd() {
      window.removeEventListener('pointermove', this._dragMove);
      window.removeEventListener('pointerup', this._dragEnd);
      window.removeEventListener('pointercancel', this._dragEnd);
      if (this.drag && this.onDrag) this.onDrag(this.drag.feature, null, 'end');
      this.drag = null;
    }

    /* ================= 渲染 ================= */
    render() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(this._render.bind(this));
    }

    _render() {
      this._raf = 0;
      if (!this.view) return;
      const rect = this.svg.getBoundingClientRect();
      const W = Math.max(1, rect.width), H = Math.max(1, rect.height);
      this.svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      this.svg.setAttribute('width', W);
      this.svg.setAttribute('height', H);
      const v = this.view;
      const scale = v.scale;
      const stroke = 1 / scale === 0 ? 1 : 1;
      void stroke;
      const parts = [];
      const zMin = this.sim ? this.sim.zMin : -50;
      const zMax = this.sim ? this.sim.zMax : 0;
      const stockR = this.sim ? this.sim.stockRadius : 30;

      parts.push('<defs>');
      parts.push('<linearGradient id="partFill" x1="0" y1="1" x2="0" y2="0">');
      parts.push('<stop offset="0" stop-color="#132a3c"/><stop offset="0.55" stop-color="#173447"/><stop offset="1" stop-color="#24475a"/>');
      parts.push('</linearGradient>');
      parts.push('<linearGradient id="chuckFill" x1="0" y1="0" x2="1" y2="0">');
      parts.push('<stop offset="0" stop-color="#1b2636"/><stop offset="1" stop-color="#0e1724"/>');
      parts.push('</linearGradient>');
      parts.push('</defs>');

      parts.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="transparent"/>');

      // 网格与坐标
      if (this.layers.grid) {
        const rStep = niceStep(scale, 34);
        const zStep = niceStep(scale, 46);
        const startZ = Math.floor((this.screenToWorld(50, H).z) / zStep) * zStep;
        const endZ = this.screenToWorld(W, 0).z;
        for (let z = startZ; z <= endZ + zStep * 0.5; z += zStep) {
          const s = this.worldToScreen(z, 0);
          const isZero = Math.abs(z) < 1e-9;
          parts.push('<line x1="' + s.x + '" y1="6" x2="' + s.x + '" y2="' + (H - 30) + '" stroke="' + (isZero ? 'rgba(120,160,200,.2)' : 'rgba(105,135,170,.1)') + '" stroke-width="1"/>');
          if (z !== 0 || true) {
            parts.push('<text x="' + s.x + '" y="' + (H - 16) + '" text-anchor="middle" class="axis-label">' + tickFmt(z, zStep) + '</text>');
          }
        }
        const topR = this.screenToWorld(0, 8).r;
        for (let r = 0; r <= topR; r += rStep) {
          const s = this.worldToScreen(0, r);
          if (s.y > H - 34 || s.y < 12) continue;
          const isZero = r < 1e-9;
          parts.push('<line x1="46" y1="' + s.y + '" x2="' + W + '" y2="' + s.y + '" stroke="' + (isZero ? 'rgba(120,160,200,.22)' : 'rgba(105,135,170,.1)') + '" stroke-width="1"/>');
          parts.push('<text x="42" y="' + (s.y + 3) + '" text-anchor="end" class="axis-label">' + tickFmt(r * 2, rStep * 2) + '</text>');
        }
        // 轴线
        const axisY = this.worldToScreen(0, 0).y;
        parts.push('<line x1="46" y1="' + axisY + '" x2="' + W + '" y2="' + axisY + '" stroke="rgba(140,174,208,.32)" stroke-width="1"/>');
        parts.push('<text x="8" y="18" class="axis-title">X 直径</text>');
        parts.push('<text x="' + (W - 8) + '" y="' + (H - 16) + '" text-anchor="end" class="axis-title">Z</text>');
        const tickStep = Math.max(1, Math.round(6 / scale));
        const tickTop = this.worldToScreen(0, 0).y;
        const zStart = Math.floor(this.screenToWorld(46, 0).z / tickStep) * tickStep;
        const zEnd = this.screenToWorld(W, 0).z;
        for (let z = zStart; z <= zEnd; z += tickStep) {
          const sx = this.worldToScreen(z, 0).x;
          parts.push('<line x1="' + sx + '" y1="' + tickTop + '" x2="' + sx + '" y2="' + (tickTop + 4) + '" stroke="rgba(140,174,208,.35)" stroke-width="1"/>');
        }
      }

      // 卡盘
      if (this.layers.chuck && this.sim) {
        const zLeft = zMin - 12;
        const p1 = this.worldToScreen(zLeft, 0);
        const p2 = this.worldToScreen(zMin, stockR * 1.12);
        const x1 = p1.x, y1 = p1.y, w = Math.max(0, p2.x - p1.x), h = Math.max(0, p1.y - p2.y);
        parts.push('<rect x="' + (x1 - w) + '" y="' + y2min(y1, y1 - h) + '" width="' + w + '" height="' + h + '" fill="url(#chuckFill)" opacity=".85"/>');
        parts.push('<rect x="' + (x1 - w) + '" y="' + (y1 - h) + '" width="' + w + '" height="' + h + '" fill="none" stroke="rgba(140,174,208,.18)" stroke-width="1"/>');
        for (let i = 1; i < 6; i++) {
          const xx = x1 - w + (w * i) / 6;
          parts.push('<line x1="' + xx + '" y1="' + y1 + '" x2="' + (xx - 6) + '" y2="' + (y1 - h) + '" stroke="rgba(140,174,208,.12)" stroke-width="1"/>');
        }
      }

      // 毛坯
      if (this.layers.stock && this.sim) {
        const a = this.worldToScreen(zMin, stockR);
        const b = this.worldToScreen(zMax, stockR);
        parts.push('<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" stroke="rgba(120,146,174,.5)" stroke-width="1" stroke-dasharray="7 5"/>');
        const c = this.worldToScreen(zMin, 0);
        const d = this.worldToScreen(zMax, 0);
        parts.push('<line x1="' + c.x + '" y1="' + c.y + '" x2="' + a.x + '" y2="' + a.y + '" stroke="rgba(120,146,174,.2)" stroke-width="1" stroke-dasharray="4 5"/>');
        parts.push('<line x1="' + d.x + '" y1="' + d.y + '" x2="' + b.x + '" y2="' + b.y + '" stroke="rgba(120,146,174,.2)" stroke-width="1" stroke-dasharray="4 5"/>');
      }

      // 实体填充
      if (this.sim) {
        const outerList = this.outerChains();
        if (outerList.length) {
          for (const c of outerList) {
            const fillPath = this.polygonPath(c.points, zMin, zMax);
            if (fillPath) parts.push('<path d="' + fillPath + '" fill="url(#partFill)" opacity=".92"/>');
          }
        } else if (this.sim.hasInner) {
          const a = this.worldToScreen(zMin, 0);
          const b = this.worldToScreen(zMax, stockR);
          parts.push('<rect x="' + a.x + '" y="' + b.y + '" width="' + Math.max(0, b.x - a.x) + '" height="' + Math.max(0, a.y - b.y) + '" fill="url(#partFill)" opacity=".9"/>');
        }
      }

      // 程序轨迹（刀尖圆心轨迹）
      if (this.layers.nominal || this.mode === 'edit') {
        for (const c of this.sim ? this.sim.nominalChains : []) {
          parts.push('<path d="' + this.pointsPath(c.points) + '" fill="none" stroke="rgba(134,155,179,.8)" stroke-width="1.2" stroke-dasharray="4 3"/>');
        }
      }

      // 偏差
      if (this.layers.deviation && this.sim) {
        for (const p of this.sim.deviation) {
          const a = this.worldToScreen(p.z, p.r);
          const b = this.worldToScreen(p.nz, p.nr);
          parts.push('<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" stroke="rgba(255,122,69,.55)" stroke-width="1"/>');
        }
      }

      // 实际工件轮廓（程序轨迹按刀尖半径向材料侧偏移 r 后的轮廓）
      if (this.sim) {
        for (const c of this.outerChains()) {
          const d = this.pointsPath(c.points);
          if (!d) continue;
          parts.push('<path d="' + d + '" fill="none" stroke="rgba(54,224,176,.18)" stroke-width="7" stroke-linejoin="round"/>');
          parts.push('<path d="' + d + '" fill="none" stroke="#36e0b0" stroke-width="2.2" stroke-linejoin="round"/>');
        }
        for (const c of this.innerChains()) {
          const d = this.pointsPath(c.points);
          if (!d) continue;
          parts.push('<path d="' + d + '" fill="none" stroke="rgba(96,200,255,.16)" stroke-width="6" stroke-linejoin="round"/>');
          parts.push('<path d="' + d + '" fill="none" stroke="#60c8ff" stroke-width="2.2" stroke-linejoin="round"/>');
        }
      }

      // 辅助线（铅垂线 / 水平线）及其与轮廓的交点
      if (this.guides && this.guides.length) {
        for (const g of this.guides) {
          if (g.axis === 'z') {
            const s = this.worldToScreen(g.value, 0);
            parts.push('<line x1="' + s.x + '" y1="6" x2="' + s.x + '" y2="' + (H - 30) + '" stroke="rgba(255,180,84,.6)" stroke-width="1.3" stroke-dasharray="6 4"/>');
            parts.push('<text x="' + (s.x + 5) + '" y="17" class="guide-label" text-anchor="start">Z ' + fmt(g.value) + '</text>');
          } else {
            const s = this.worldToScreen(0, g.value);
            parts.push('<line x1="46" y1="' + s.y + '" x2="' + W + '" y2="' + s.y + '" stroke="rgba(255,180,84,.6)" stroke-width="1.3" stroke-dasharray="6 4"/>');
            parts.push('<text x="' + (W - 8) + '" y="' + (s.y - 5) + '" class="guide-label" text-anchor="end">X ' + fmt(g.value * 2) + '</text>');
          }
        }
        for (const h of this.guidePoints()) {
          const s = this.worldToScreen(h.z, h.r);
          const d = 5;
          parts.push('<path d="M' + (s.x - d) + ' ' + s.y + 'L' + s.x + ' ' + (s.y - d) + 'L' + (s.x + d) + ' ' + s.y + 'L' + s.x + ' ' + (s.y + d) + 'Z" fill="#ffb454" stroke="rgba(255,180,84,.85)" stroke-width="1"/>');
        }
      }

      // 测量基准节点（程序特征端点 / 交点）
      if (this.mode === 'measure' && this.sim && this.sim.snapPoints) {
        for (const n of this.sim.snapPoints) {
          const s = this.worldToScreen(n.z, n.r);
          const inner = n.kind === 'inner';
          parts.push('<circle cx="' + s.x + '" cy="' + s.y + '" r="4" fill="none" stroke="' +
            (inner ? 'rgba(96,200,255,.55)' : 'rgba(54,224,176,.55)') +
            '" stroke-width="1.2" stroke-dasharray="2 2"/>');
          parts.push('<circle cx="' + s.x + '" cy="' + s.y + '" r="1.6" fill="' +
            (inner ? 'rgba(96,200,255,.55)' : 'rgba(54,224,176,.55)') + '"/>');
        }
      }

      // 选中特征
      if (this.mode === 'edit' && this.parsed && this.selectedId >= 0) {
        const f = this.parsed.cutting.find(function (x) { return x.id === this.selectedId; }, this);
        if (f) {
          const pts = Geometry.sampleFeature(f, 0.05);
          parts.push('<path d="' + this.pointsPath(pts) + '" fill="none" stroke="#ffb454" stroke-width="2.4" opacity=".95"/>');
        }
      }

      // 特征端点手柄
      if (this.mode === 'edit' && this.parsed) {
        for (const f of this.parsed.cutting) {
          if (f.type !== 'line') continue;
          const p = this.worldToScreen(f.end.z, f.end.d / 2);
          const isSel = f.id === this.selectedId;
          parts.push('<circle data-handle="1" data-feature="' + f.id + '" cx="' + p.x + '" cy="' + p.y + '" r="' + (isSel ? 7 : 5.5) + '" fill="' + (isSel ? 'rgba(255,180,84,.9)' : 'rgba(255,180,84,.28)') + '" stroke="#ffb454" stroke-width="1.3" style="cursor:grab"/>');
        }
      }

      // 测量标记
      if (this.measurements && this.measurements.length) {
        const pts = this.measurements;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const s = this.worldToScreen(p.z, p.r);
          const color = i === 0 ? '#36e0b0' : '#60c8ff';
          parts.push('<line x1="' + s.x + '" y1="' + s.y + '" x2="' + s.x + '" y2="' + this.worldToScreen(p.z, 0).y + '" stroke="' + color + '" stroke-width="1" stroke-dasharray="2 4" opacity=".5"/>');
          parts.push('<circle cx="' + s.x + '" cy="' + s.y + '" r="5.5" fill="' + color + '" opacity=".95"/>');
          parts.push('<circle cx="' + s.x + '" cy="' + s.y + '" r="9" fill="none" stroke="' + color + '" opacity=".45"/>');
          const label = 'P' + (i + 1) + ' ' + (p.type || '基准') + '  X' + fmt(p.d) + '  Z' + fmt(p.z);
          const lx = s.x + 12;
          const ly = s.y - 10;
          parts.push('<rect x="' + (lx - 4) + '" y="' + (ly - 11) + '" width="' + (label.length * 6.2 + 8) + '" height="16" rx="4" fill="rgba(7,13,23,.85)" stroke="' + color + '" stroke-opacity=".35"/>');
          parts.push('<text x="' + lx + '" y="' + ly + '" class="measure-label" data-color="' + color + '">' + esc(label) + '</text>');
        }
        if (pts.length === 2) {
          const a = this.worldToScreen(pts[0].z, pts[0].r);
          const b = this.worldToScreen(pts[1].z, pts[1].r);
          parts.push('<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" stroke="rgba(96,200,255,.7)" stroke-width="1.4" stroke-dasharray="5 3"/>');
        }
      }

      this.svg.innerHTML = parts.join('');
    }

    outerChains() {
      if (!this.sim) return [];
      if (this.sim.outerChains && this.sim.outerChains.length) return this.sim.outerChains;
      return this.sim.outerPoints && this.sim.outerPoints.length
        ? [{ points: this.sim.outerPoints }] : [];
    }

    innerChains() {
      if (!this.sim) return [];
      if (this.sim.innerChains && this.sim.innerChains.length) return this.sim.innerChains;
      return this.sim.innerPoints && this.sim.innerPoints.length
        ? [{ points: this.sim.innerPoints }] : [];
    }

    polygonPath(points, zMin, zMax) {
      if (!points.length) return '';
      const arr = points.slice();
      let d = 'M' + this.px(arr[0]) ;
      for (let i = 1; i < arr.length; i++) d += ' L' + this.px(arr[i]);
      const endY = this.worldToScreen(arr[arr.length - 1].z, 0);
      const startY = this.worldToScreen(arr[0].z, 0);
      d += ' L' + endY.x + ' ' + endY.y + ' L' + startY.x + ' ' + startY.y + ' Z';
      void zMin; void zMax;
      return d;
    }

    px(p) {
      const s = this.worldToScreen(p.z, p.r);
      return s.x + ' ' + s.y;
    }

    pointsPath(points) {
      if (!points || points.length < 2) return '';
      let d = '';
      for (let i = 0; i < points.length; i++) {
        const s = this.worldToScreen(points[i].z, points[i].r);
        d += (i === 0 ? 'M' : 'L') + s.x.toFixed(2) + ' ' + s.y.toFixed(2);
      }
      return d;
    }

    zoomReadout() {
      if (!this.view || !this.fitScale) return '--';
      return Math.round((this.view.scale / this.fitScale) * 100) + '%';
    }
  }

  function y2min(a, b) { return a < b ? a : b; }

  global.Viewer = Viewer;
})(window);
