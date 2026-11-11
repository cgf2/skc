/* 几何内核：圆弧、偏置、交点、采样与最近点计算
   坐标系：内部使用 (z, r)，r 为真实半径；程序 X 为直径。 */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;
  const EPS = 1e-9;

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  function norm(a) { a = a % TAU; return a < 0 ? a + TAU : a; }
  function dist(a, b) { return Math.hypot(a.z - b.z, a.r - b.r); }
  function pt(z, r) { return { z: z, r: r }; }

  function startOf(f) { return pt(f.start.z, f.start.d / 2); }
  function endOf(f) { return pt(f.end.z, f.end.d / 2); }

  function lineSamples(f, step) {
    const a = startOf(f), b = endOf(f);
    const len = Math.hypot(b.z - a.z, b.r - a.r);
    const n = Math.max(1, Math.ceil(len / step));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      out.push(pt(a.z + (b.z - a.z) * t, a.r + (b.r - a.r) * t));
    }
    return out;
  }

  function arcAngles(f) {
    const c = f.center;
    const s = startOf(f), e = endOf(f);
    return {
      a1: Math.atan2(s.r - c.r, s.z - c.z),
      a2: Math.atan2(e.r - c.r, e.z - c.z)
    };
  }

  function arcSweep(f) {
    const { a1, a2 } = arcAngles(f);
    let sw;
    if (f.cw) sw = norm(a1 - a2);
    else sw = norm(a2 - a1);
    if (sw < 1e-7) sw = TAU;
    return sw;
  }

  function arcSamples(f, step) {
    const c = f.center;
    const s = startOf(f), e = endOf(f);
    let R = (dist(s, c) + dist(e, c)) / 2;
    const { a1 } = arcAngles(f);
    const sw = arcSweep(f);
    const dir = f.cw ? -1 : 1;
    const n = Math.max(2, Math.ceil((R * sw) / step));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const a = a1 + dir * sw * (i / n);
      out.push(pt(c.z + Math.cos(a) * R, c.r + Math.sin(a) * R));
    }
    return out;
  }

  function sampleFeature(f, step) {
    return f.type === 'arc' ? arcSamples(f, step) : lineSamples(f, step);
  }

  function tangentAt(f, atStart) {
    if (f.type === 'line') {
      const a = startOf(f), b = endOf(f);
      const len = Math.hypot(b.z - a.z, b.r - a.r) || 1;
      return { z: (b.z - a.z) / len, r: (b.r - a.r) / len };
    }
    const c = f.center;
    const p = atStart ? startOf(f) : endOf(f);
    const u = { z: (p.z - c.z) / f.radius, r: (p.r - c.r) / f.radius };
    return f.cw ? { z: u.r, r: -u.z } : { z: -u.r, r: u.z };
  }

  /* 圆弧由起点、终点、半径与方向求圆心（显示坐标 z-r） */
  function arcFromRS(s, e, R, cw) {
    const dz = e.z - s.z, dr = e.r - s.r;
    const chord = Math.hypot(dz, dr);
    let absR = Math.abs(R);
    if (chord < 1e-9) return null;
    if (absR < chord / 2) absR = chord / 2;
    const h = Math.sqrt(Math.max(0, absR * absR - (chord * chord) / 4));
    const mid = { z: (s.z + e.z) / 2, r: (s.r + e.r) / 2 };
    const u = { z: dz / chord, r: dr / chord };
    // 右法线
    const rn = { z: u.r, r: -u.z };
    const sign = (cw ? 1 : -1) * (R < 0 ? -1 : 1);
    const c = { z: mid.z + rn.z * h * sign, r: mid.r + rn.r * h * sign };
    return { center: c, radius: absR, cw: cw };
  }

  /* ---------------- 交点 ---------------- */
  function lineLine(p1, d1, p2, d2) {
    const den = d1.z * d2.r - d1.r * d2.z;
    if (Math.abs(den) < 1e-12) return [];
    const t = ((p2.z - p1.z) * d2.r - (p2.r - p1.r) * d2.z) / den;
    return [pt(p1.z + d1.z * t, p1.r + d1.r * t)];
  }

  function lineCircle(p, d, c, R) {
    const ox = p.z - c.z, oy = p.r - c.r;
    const a = d.z * d.z + d.r * d.r;
    const b = 2 * (ox * d.z + oy * d.r);
    const cc = ox * ox + oy * oy - R * R;
    const disc = b * b - 4 * a * cc;
    if (disc <= 0) return [];
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a);
    const t2 = (-b + sq) / (2 * a);
    const out = [pt(p.z + d.z * t1, p.r + d.r * t1)];
    if (Math.abs(t2 - t1) > 1e-9) out.push(pt(p.z + d.z * t2, p.r + d.r * t2));
    return out;
  }

  function circleCircle(c1, R1, c2, R2) {
    const d = dist(c1, c2);
    if (d < 1e-9 || d > R1 + R2 || d < Math.abs(R1 - R2)) return [];
    const a = (R1 * R1 - R2 * R2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, R1 * R1 - a * a));
    const u = { z: (c2.z - c1.z) / d, r: (c2.r - c1.r) / d };
    const m = pt(c1.z + u.z * a, c1.r + u.r * a);
    const n = { z: -u.r * h, r: u.z * h };
    return [pt(m.z + n.z, m.r + n.r), pt(m.z - n.z, m.r - n.r)];
  }

  function offsetArcGeom(f, r, side) {
    const c = f.center;
    let R2 = f.radius + side * (f.cw ? -1 : 1) * r;
    if (R2 < 0.0001) R2 = 0.0001;
    return { type: 'arc', center: c, radius: R2, cw: f.cw };
  }

  function offsetLineGeom(f, r, side) {
    const s = startOf(f);
    const t = tangentAt(f, true);
    const n = { z: side * t.r, r: -side * t.z };
    return { type: 'line', p: pt(s.z + n.z * r, s.r + n.r * r), d: t };
  }

  function offsetFeatureSamples(f, r, side, step) {
    if (f.type === 'line') {
      const s = startOf(f), e = endOf(f);
      const t = tangentAt(f, true);
      const n = { z: side * t.r, r: -side * t.z };
      const a = pt(s.z + n.z * r, s.r + n.r * r);
      const b = pt(e.z + n.z * r, e.r + n.r * r);
      const len = Math.hypot(b.z - a.z, b.r - a.r);
      const nseg = Math.max(1, Math.ceil(len / step));
      const out = [];
      for (let i = 0; i <= nseg; i++) {
        const t2 = i / nseg;
        out.push(pt(a.z + (b.z - a.z) * t2, a.r + (b.r - a.r) * t2));
      }
      return out;
    }
    const k = f.radius + side * (f.cw ? -1 : 1) * r;
    if (k < 0.0001) return [];
    const c = f.center;
    const { a1 } = arcAngles(f);
    const sw = arcSweep(f);
    const dir = f.cw ? -1 : 1;
    const n = Math.max(2, Math.ceil((k * sw) / step));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const ang = a1 + dir * sw * (i / n);
      out.push(pt(c.z + Math.cos(ang) * k, c.r + Math.sin(ang) * k));
    }
    return out;
  }

  /* 纯径向（端面）切削：Z 不变、X 变化 */
  function isRadialFeature(f) {
    return Math.abs(f.end.z - f.start.z) < 1e-6 && Math.abs(f.end.d - f.start.d) > 1e-9;
  }

  function jointIntersection(prev, cur, r, side) {
    const g1 = prev.type === 'arc' ? offsetArcGeom(prev, r, side) : offsetLineGeom(prev, r, side);
    const g2 = cur.type === 'arc' ? offsetArcGeom(cur, r, side) : offsetLineGeom(cur, r, side);
    let pts = [];
    if (g1.type === 'line' && g2.type === 'line') pts = lineLine(g1.p, g1.d, g2.p, g2.d);
    else if (g1.type === 'line' && g2.type === 'arc') pts = lineCircle(g1.p, g1.d, g2.center, g2.radius);
    else if (g1.type === 'arc' && g2.type === 'line') pts = lineCircle(g2.p, g2.d, g1.center, g1.radius);
    else pts = circleCircle(g1.center, g1.radius, g2.center, g2.radius);
    if (!pts.length) return null;
    const v = endOf(prev);
    let best = null, bd = Infinity;
    for (const p of pts) {
      const d = dist(p, v);
      if (d < bd) { bd = d; best = p; }
    }
    return { p: best, distance: bd };
  }

  /* 生成偏置轨迹（沿法向按刀尖半径 r 向 side 侧偏移） */
  function buildCenterPath(features, r, side, step) {
    if (!features.length) return [];
    const lists = [];
    for (const f of features) {
      const arr = offsetFeatureSamples(f, r, side, step);
      const radial = isRadialFeature(f);
      for (const p of arr) p.radial = radial;
      lists.push(arr);
    }
    if (!lists[0] || !lists[0].length) return [];
    let out = lists[0].slice();
    for (let i = 1; i < features.length; i++) {
      if (!lists[i] || !lists[i].length) continue;
      const prev = features[i - 1], cur = features[i];
      const v = endOf(prev);
      const t1 = tangentAt(prev, false), t2 = tangentAt(cur, true);
      const cross = t1.z * t2.r - t1.r * t2.z;
      const o1 = out[out.length - 1];
      const o2 = lists[i][0];
      if (!o1 || !o2) continue;
      const isRound = cross * side > 1e-8 && Math.abs(cross) > 1e-7;
      const isTrim = cross * side < -1e-8 && Math.abs(cross) > 1e-7;

      if (isRound) {
        const a1 = Math.atan2(o1.r - v.r, o1.z - v.z);
        const a2 = Math.atan2(o2.r - v.r, o2.z - v.z);
        const ccw = cross > 0;
        let sw = ccw ? norm(a2 - a1) : norm(a1 - a2);
        if (sw < 1e-9) sw = 0;
        const n = Math.max(1, Math.ceil((sw * Math.abs(r)) / (step * 1.5)));
        for (let k = 1; k <= n; k++) {
          const ang = ccw ? a1 + sw * (k / n) : a1 - sw * (k / n);
          out.push(pt(v.z + Math.cos(ang) * r, v.r + Math.sin(ang) * r));
        }
        for (let k = 1; k < lists[i].length; k++) out.push(lists[i][k]);
      } else if (isTrim) {
        const hit = jointIntersection(prev, cur, r, side);
        if (hit && hit.distance < Math.max(8 * Math.abs(r), 0.3)) {
          out.pop();
          out.push(hit.p);
          for (let k = 1; k < lists[i].length; k++) out.push(lists[i][k]);
        } else {
          for (let k = 1; k < lists[i].length; k++) out.push(lists[i][k]);
        }
      } else {
        for (let k = 1; k < lists[i].length; k++) out.push(lists[i][k]);
      }
    }
    return out;
  }

  /* Ramer-Douglas-Peucker；在垂直台阶处强制分段，保证台阶不被抹平 */
  function rdpRange(points, a, b, tol) {
    if (b <= a) return [];
    const keep = new Uint8Array(b - a + 1);
    keep[0] = keep[b - a] = 1;
    const stack = [[0, b - a]];
    while (stack.length) {
      const [ia, ib] = stack.pop();
      let maxD = 0, idx = -1;
      const p1 = points[a + ia], p2 = points[a + ib];
      const dz = p2.z - p1.z, dr = p2.r - p1.r;
      const len = Math.hypot(dz, dr);
      for (let i = ia + 1; i < ib; i++) {
        let d;
        if (len < 1e-12) d = Math.hypot(points[a + i].z - p1.z, points[a + i].r - p1.r);
        else d = Math.abs((points[a + i].z - p1.z) * dr - (points[a + i].r - p1.r) * dz) / len;
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tol && idx >= 0) {
        keep[idx] = 1;
        stack.push([ia, idx], [idx, ib]);
      }
    }
    const out = [];
    for (let i = 0; i <= b - a; i++) if (keep[i]) out.push(points[a + i]);
    return out;
  }

  function simplify(points, tol) {
    if (points.length <= 2) return points.slice();
    const splits = [0];
    for (let i = 0; i < points.length - 1; i++) {
      if (Math.abs(points[i].z - points[i + 1].z) < 1e-9 &&
          Math.abs(points[i].r - points[i + 1].r) > 1e-9) {
        splits.push(i, i + 1);
      }
    }
    splits.push(points.length - 1);
    splits.sort(function (a, b) { return a - b; });
    const out = [];
    for (let s = 0; s < splits.length - 1; s++) {
      const a = splits[s], b = splits[s + 1];
      if (a === b) continue;
      const part = rdpRange(points, a, b, tol);
      for (let k = (out.length ? 1 : 0); k < part.length; k++) out.push(part[k]);
    }
    return out;
  }

  function nearestOnPolyline(points, target) {
    let best = null;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const dz = b.z - a.z, dr = b.r - a.r;
      const l2 = dz * dz + dr * dr;
      let t = 0;
      if (l2 > 1e-15) t = clamp(((target.z - a.z) * dz + (target.r - a.r) * dr) / l2, 0, 1);
      const p = pt(a.z + dz * t, a.r + dr * t);
      const d = dist(p, target);
      if (!best || d < best.distance) best = { point: p, distance: d, index: i, t: t };
    }
    return best;
  }

  function polylineLength(points) {
    let s = 0;
    for (let i = 1; i < points.length; i++) s += dist(points[i - 1], points[i]);
    return s;
  }

  function nearestFeature(features, target, maxDist) {
    let best = null;
    for (const f of features) {
      if (f.rapid || f.type === 'rapid') continue;
      let d, p;
      if (f.type === 'line') {
        const a = startOf(f), b = endOf(f);
        const dz = b.z - a.z, dr = b.r - a.r;
        const l2 = dz * dz + dr * dr;
        const t = l2 > 1e-15 ? clamp(((target.z - a.z) * dz + (target.r - a.r) * dr) / l2, 0, 1) : 0;
        p = pt(a.z + dz * t, a.r + dr * t);
        d = dist(p, target);
      } else {
        const c = f.center;
        const a1 = Math.atan2(target.r - c.r, target.z - c.z);
        const { a1: s1, a2: s2 } = arcAngles(f);
        const sw = arcSweep(f);
        const dir = f.cw ? -1 : 1;
        let da = dir > 0 ? norm(a1 - s1) : norm(s1 - a1);
        if (da <= sw + 1e-7) {
          p = pt(c.z + Math.cos(a1) * f.radius, c.r + Math.sin(a1) * f.radius);
          d = Math.abs(dist(target, c) - f.radius);
        } else {
          const s = startOf(f), e = endOf(f);
          const d1 = dist(target, s), d2 = dist(target, e);
          p = d1 < d2 ? s : e;
          d = Math.min(d1, d2);
        }
      }
      if (d <= maxDist && (!best || d < best.distance)) best = { feature: f, distance: d, point: p };
    }
    return best;
  }

  /* ================= 轮廓角部处理：C 倒角 / R 圆角 / 自动刀尖过渡 ================= */

  function featureLength(f) {
    if (f.type === 'arc' && f.center) return Math.abs(f.radius) * arcSweep(f);
    const a = startOf(f), b = endOf(f);
    return Math.hypot(b.z - a.z, b.r - a.r);
  }

  /* 距离起点/终点 d 处的点（线为弧长，圆弧为弧长） */
  function pointAtDist(f, fromStart, d) {
    if (!(d > 0)) return fromStart ? startOf(f) : endOf(f);
    if (f.type !== 'arc' || !f.center || !(f.radius > 0)) {
      const a = startOf(f), b = endOf(f);
      const len = Math.hypot(b.z - a.z, b.r - a.r) || 1;
      const u = { z: (b.z - a.z) / len, r: (b.r - a.r) / len };
      const base = fromStart ? a : b;
      const sgn = fromStart ? 1 : -1;
      return pt(base.z + sgn * u.z * d, base.r + sgn * u.r * d);
    }
    const base = fromStart ? arcAngles(f).a1 : arcAngles(f).a2;
    const a = fromStart ? base + (f.cw ? -1 : 1) * (d / f.radius)
                        : base - (f.cw ? -1 : 1) * (d / f.radius);
    return pt(f.center.z + Math.cos(a) * f.radius, f.center.r + Math.sin(a) * f.radius);
  }

  /* 点相对圆弧起点的角参数（沿切削方向，0..TAU） */
  function arcParam(f, p) {
    const c = f.center;
    if (!c) return Infinity;
    const a1 = arcAngles(f).a1;
    const ap = Math.atan2(p.r - c.r, p.z - c.z);
    return f.cw ? norm(a1 - ap) : norm(ap - a1);
  }

  function onFeature(f, p, tol) {
    tol = tol || 0.002;
    if (f.type === 'arc' && f.center) {
      if (Math.abs(dist(p, f.center) - f.radius) > tol) return false;
      return arcParam(f, p) <= arcSweep(f) + 0.02;
    }
    const a = startOf(f), b = endOf(f);
    const dz = b.z - a.z, dr = b.r - a.r;
    const l2 = dz * dz + dr * dr;
    if (l2 < 1e-12) return dist(p, a) < tol;
    const t = ((p.z - a.z) * dz + (p.r - a.r) * dr) / l2;
    if (t < -1e-4 || t > 1 + 1e-4) return false;
    const q = pt(a.z + dz * t, a.r + dr * t);
    return dist(p, q) <= tol;
  }

  function leftNormal(t) { return { z: -t.r, r: t.z }; }

  function lineOffsetAt(f, R, s) {
    const t = tangentAt(f, true);
    const n = leftNormal(t);
    const a = startOf(f);
    return { type: 'line', p: pt(a.z + n.z * s * R, a.r + n.r * s * R), d: t };
  }

  function seedCenter(prev, next, R, V, s) {
    const t1 = tangentAt(prev, false), t2 = tangentAt(next, true);
    const n1 = leftNormal(t1), n2 = leftNormal(t2);
    const bz = (n1.z + n2.z) * s, br = (n1.r + n2.r) * s;
    const bl = Math.hypot(bz, br);
    if (bl < 1e-7) return null;
    const dot = t1.z * t2.z + t1.r * t2.r;
    const sinH = Math.sqrt(Math.max(1e-8, (1 - dot) / 2));
    return pt(V.z + (bz / bl) * (R / sinH), V.r + (br / bl) * (R / sinH));
  }

  /* 求相切圆角：线与线、线与弧、弧与弧 */
  function filletSolve(prev, next, R) {
    R = Math.abs(R);
    if (!(R > 1e-6)) return null;
    const V = endOf(prev);
    const t1 = tangentAt(prev, false), t2 = tangentAt(next, true);
    const cross = t1.z * t2.r - t1.r * t2.z;
    if (Math.abs(cross) < 1e-8) return null;
    const dot = t1.z * t2.z + t1.r * t2.r;
    if (dot < -0.9999) return null;
    const s = cross > 0 ? 1 : -1;
    const seed = seedCenter(prev, next, R, V, s);
    const cands = [];

    const prevArc = prev.type === 'arc' && prev.center;
    const nextArc = next.type === 'arc' && next.center;
    if (!prevArc && !nextArc) {
      const L1 = lineOffsetAt(prev, R, s), L2 = lineOffsetAt(next, R, s);
      for (const C of lineLine(L1.p, L1.d, L2.p, L2.d)) {
        cands.push({ C: C, ext1: false, ext2: false, k1: 0, k2: 0 });
      }
    } else if (!prevArc) {
      const L1 = lineOffsetAt(prev, R, s);
      const R2 = next.radius;
      const ks = [R2 + R];
      if (Math.abs(R2 - R) > 1e-6) ks.push(Math.abs(R2 - R));
      for (const k2 of ks) {
        for (const C of lineCircle(L1.p, L1.d, next.center, k2)) {
          cands.push({ C: C, ext1: false, ext2: Math.abs(k2 - (R2 + R)) < 1e-6, k1: 0, k2: k2 });
        }
      }
    } else if (!nextArc) {
      const L2 = lineOffsetAt(next, R, s);
      const R1 = prev.radius;
      const ks = [R1 + R];
      if (Math.abs(R1 - R) > 1e-6) ks.push(Math.abs(R1 - R));
      for (const k1 of ks) {
        for (const C of lineCircle(L2.p, L2.d, prev.center, k1)) {
          cands.push({ C: C, ext1: Math.abs(k1 - (R1 + R)) < 1e-6, ext2: false, k1: k1, k2: 0 });
        }
      }
    } else {
      const R1 = prev.radius, R2 = next.radius;
      const ks1 = [R1 + R], ks2 = [R2 + R];
      if (Math.abs(R1 - R) > 1e-6) ks1.push(Math.abs(R1 - R));
      if (Math.abs(R2 - R) > 1e-6) ks2.push(Math.abs(R2 - R));
      for (const k1 of ks1) {
        for (const k2 of ks2) {
          for (const C of circleCircle(prev.center, k1, next.center, k2)) {
            cands.push({
              C: C, k1: k1, k2: k2,
              ext1: Math.abs(k1 - (R1 + R)) < 1e-6,
              ext2: Math.abs(k2 - (R2 + R)) < 1e-6
            });
          }
        }
      }
    }

    let best = null;
    for (const cd of cands) {
      const C = cd.C;
      let p1, p2;
      if (prevArc) {
        const u = unitFrom(prev.center, C);
        if (!u) continue;
        const inside = !cd.ext1 && prev.radius > R;
        const sgn = (cd.ext1 || inside) ? 1 : -1;
        p1 = pt(prev.center.z + u.z * prev.radius * sgn, prev.center.r + u.r * prev.radius * sgn);
      } else {
        p1 = projectOnLine(prev, C);
      }
      if (nextArc) {
        const u = unitFrom(next.center, C);
        if (!u) continue;
        const inside = !cd.ext2 && next.radius > R;
        const sgn = (cd.ext2 || inside) ? 1 : -1;
        p2 = pt(next.center.z + u.z * next.radius * sgn, next.center.r + u.r * next.radius * sgn);
      } else {
        p2 = projectOnLine(next, C);
      }
      if (!onFeature(prev, p1, 0.003) || !onFeature(next, p2, 0.003)) continue;
      const trim1 = distFromEnd(prev, p1);
      const trim2 = distFromStart(next, p2);
      if (!(trim1 > 1e-5) || !(trim2 > 1e-5)) continue;
      if (trim1 > featureLength(prev) + 1e-4 || trim2 > featureLength(next) + 1e-4) continue;
      const score = seed ? dist(C, seed) : 0;
      if (!best || score < best.score) {
        best = { score: score, C: C, p1: p1, p2: p2, trim1: trim1, trim2: trim2 };
      }
    }
    if (!best) return null;
    return {
      kind: 'arc', p1: best.p1, p2: best.p2, center: best.C, radius: R,
      cw: s < 0, trim1: best.trim1, trim2: best.trim2, V: V, side: s
    };
  }

  function unitFrom(a, b) {
    const d = dist(a, b);
    if (d < 1e-9) return null;
    return { z: (b.z - a.z) / d, r: (b.r - a.r) / d };
  }

  function projectOnLine(f, p) {
    const a = startOf(f), b = endOf(f);
    const dz = b.z - a.z, dr = b.r - a.r;
    const l2 = dz * dz + dr * dr;
    if (l2 < 1e-12) return a;
    const t = ((p.z - a.z) * dz + (p.r - a.r) * dr) / l2;
    return pt(a.z + dz * t, a.r + dr * t);
  }

  function distFromStart(f, p) {
    if (!(f.type === 'arc' && f.center)) return dist(p, startOf(f));
    return Math.abs(f.radius) * arcParam(f, p);
  }

  function distFromEnd(f, p) {
    if (!(f.type === 'arc' && f.center)) return dist(p, endOf(f));
    return Math.abs(f.radius) * (arcSweep(f) - arcParam(f, p));
  }

  /* C 倒角（两侧等长） */
  function chamferSolve(prev, next, C) {
    const len1 = featureLength(prev), len2 = featureLength(next);
    let c = Math.abs(C);
    if (!(c > 1e-4)) return null;
    const cap = Math.max(1e-4, Math.min(len1, len2) - 1e-4);
    if (c > cap) c = cap;
    if (c < 0.01) return null;
    const p1 = pointAtDist(prev, false, c);
    const p2 = pointAtDist(next, true, c);
    if (!onFeature(prev, p1, 0.003) || !onFeature(next, p2, 0.003)) return null;
    return {
      kind: 'line', p1: p1, p2: p2, center: null, radius: 0, cw: false,
      trim1: c, trim2: c, requested: Math.abs(C), clamped: c < Math.abs(C) - 1e-7
    };
  }

  function buildTreatment(prev, next, kind, size, warnings) {
    if (kind === 'chamfer') {
      const t = chamferSolve(prev, next, size);
      if (t && t.clamped && warnings) {
        warnings.push({ level: 'warn', line: prev.line || 0, text: 'C' + size + ' 超出相邻轮廓可容纳长度，已按 ' + r3(t.trim1) + ' mm 倒角。' });
      }
      return t;
    }
    let R = Math.abs(size);
    for (let k = 0; k < 12; k++) {
      const t = filletSolve(prev, next, R);
      if (t) {
        if (warnings && Math.abs(R - Math.abs(size)) > 1e-4) {
          warnings.push({ level: 'warn', line: prev.line || 0, text: 'R' + size + ' 超出相邻轮廓可容纳范围，已按 R' + r3(R) + ' 过渡。' });
        }
        t.requested = Math.abs(size);
        t.clamped = Math.abs(R - Math.abs(size)) > 1e-4;
        return t;
      }
      R *= 0.65;
      if (R < 0.02) break;
    }
    if (warnings) warnings.push({ level: 'warn', line: prev.line || 0, text: '无法在相邻轮廓之间生成 R' + size + ' 过渡，已保留尖角。' });
    return null;
  }

  function trimFeature(f, trimStart, trimEnd) {
    if (!(trimStart > 1e-6) && !(trimEnd > 1e-6)) {
      return Object.assign({}, f);
    }
    if (f.type === 'arc' && !f.center) return Object.assign({}, f);
    const s = trimStart > 1e-6 ? pointAtDist(f, true, trimStart) : startOf(f);
    const e = trimEnd > 1e-6 ? pointAtDist(f, false, trimEnd) : endOf(f);
    return Object.assign({}, f, {
      start: { d: Math.max(0, s.r * 2), z: s.z },
      end: { d: Math.max(0, e.r * 2), z: e.z }
    });
  }

  /**
   * 生成最终轮廓特征段
   * @param {Array} feats 连续的程序切削特征
   * @param {{autoRadius?:number|Function}} opts autoRadius 为自动拐角圆角半径（刀尖半径）
   * @returns {{features:Array, warnings:Array}}
   */
  function composeChain(feats, opts) {
    opts = opts || {};
    const result = { features: [], warnings: [] };
    if (!Array.isArray(feats) || !feats.length) return result;
    const autoFn = typeof opts.autoRadius === 'function'
      ? opts.autoRadius
      : function () { return Number(opts.autoRadius) || 0; };
    const treats = new Array(feats.length).fill(null);

    for (let i = 0; i < feats.length - 1; i++) {
      const prev = feats[i], next = feats[i + 1];
      if (dist(endOf(prev), startOf(next)) > 1e-4) continue;
      let treat = null, source = '';
      if (Number(prev.cornerC) > 0) {
        treat = buildTreatment(prev, next, 'chamfer', Number(prev.cornerC), result.warnings);
        source = 'C';
      } else if (Number(prev.cornerR) > 0) {
        treat = buildTreatment(prev, next, 'arc', Number(prev.cornerR), result.warnings);
        source = 'R';
      }
      if (!treat) {
        const ar = Number(autoFn(prev, next));
        if (ar > 0 && Number(prev.comp) !== 0 && Number(next.comp) !== 0) {
          treat = buildTreatment(prev, next, 'arc', ar, result.warnings);
          source = 'auto';
        }
      }
      if (treat) {
        treat.source = source;
        treat.prev = prev;
        treat.next = next;
        treats[i] = treat;
      }
    }

    for (let i = 0; i < feats.length; i++) {
      const f = feats[i];
      const trimStart = i > 0 && treats[i - 1] ? treats[i - 1].trim2 : 0;
      const trimEnd = i < feats.length - 1 && treats[i] ? treats[i].trim1 : 0;
      const tf = trimFeature(f, trimStart, trimEnd);
      result.features.push(tf);
      const tr = treats[i];
      if (tr) {
        result.features.push({
          id: 'J' + i + '-' + (f.id !== undefined ? f.id : i),
          type: tr.kind === 'arc' ? 'arc' : 'line',
          start: { d: Math.max(0, tr.p1.r * 2), z: tr.p1.z },
          end: { d: Math.max(0, tr.p2.r * 2), z: tr.p2.z },
          center: tr.center || null,
          radius: tr.radius || 0,
          cw: !!tr.cw,
          rapid: false,
          comp: f.comp,
          tool: f.tool,
          toolNo: f.toolNo,
          auto: tr.source === 'auto',
          cornerSource: tr.source,
          corner: true,
          fromId: f.id,
          toId: feats[i + 1].id,
          line: f.line
        });
      }
    }
    return result;
  }

  /* ================= 刀尖圆弧补偿：整条轨迹等距偏移 =================
     约定：side=+1 表示沿行进方向向左侧偏移，side=-1 为右侧。
     编程轨迹（刀尖圆心路径）向材料侧偏移 r 得到工件实际轮廓。
     拐角规则：
       cross * side > 0  → 两侧偏移线相交，取交点形成尖角；
       cross * side < 0  → 两侧偏移线分离，插入以拐点 V 为圆心、半径 r 的包络圆弧。 */

  function offsetSampleGeom(f, r, side) {
    if (f.type === 'line') {
      const t = tangentAt(f, true);
      const n = leftNormal(t);
      const s = startOf(f), e = endOf(f);
      const a = pt(s.z + n.z * side * r, s.r + n.r * side * r);
      const b = pt(e.z + n.z * side * r, e.r + n.r * side * r);
      return { kind: 'line', start: a, end: b, d: t };
    }
    const c = f.center;
    const base = f.radius + side * (f.cw ? 1 : -1) * r;
    const flip = base < 0;
    const R2 = Math.abs(base);
    const sw = arcSweep(f);
    const { a1, a2 } = arcAngles(f);
    const da = flip ? Math.PI : 0;
    const A1 = a1 + da, A2 = a2 + da;
    const cw2 = flip ? !f.cw : f.cw;
    return {
      kind: 'arc', center: c, radius: Math.max(R2, 0.0001), cw: cw2,
      a1: A1, a2: A2, sweep: sw,
      start: pt(c.z + Math.cos(A1) * Math.max(R2, 0.0001), c.r + Math.sin(A1) * Math.max(R2, 0.0001)),
      end: pt(c.z + Math.cos(A2) * Math.max(R2, 0.0001), c.r + Math.sin(A2) * Math.max(R2, 0.0001))
    };
  }

  /* 交点是否落在偏移圆弧的有效扫掠范围内（允许起点附近极小的反向越界） */
  function offsetArcAccepts(o, p) {
    if (o.kind !== 'arc') return true;
    const ang = Math.atan2(p.r - o.center.r, p.z - o.center.z);
    let t = o.cw ? o.a1 - ang : ang - o.a1;
    t = norm(t);
    if (t > Math.PI) t -= TAU;   // 转成 [-π, π)，避免 359.7° 被误判为越界
    return t >= -0.05 && t <= o.sweep + 0.05;
  }

  function offsetIntersection(o1, o2) {
    const A = o1.end, B = o2.start;
    let cands = [];
    if (o1.kind === 'line' && o2.kind === 'line') {
      cands = lineLine(o1.start, o1.d, o2.start, o2.d);
    } else if (o1.kind === 'line' && o2.kind === 'arc') {
      cands = lineCircle(o1.start, o1.d, o2.center, o2.radius);
    } else if (o1.kind === 'arc' && o2.kind === 'line') {
      cands = lineCircle(o2.start, o2.d, o1.center, o1.radius);
    } else {
      cands = circleCircle(o1.center, o1.radius, o2.center, o2.radius);
    }
    let best = null, bs = Infinity;
    for (const p of cands) {
      if (!offsetArcAccepts(o1, p) || !offsetArcAccepts(o2, p)) continue;
      const score = dist(p, A) + dist(p, B);
      if (score < bs) { bs = score; best = p; }
    }
    return best;
  }

  /* 逆向偏移：从实际工件轮廓还原程序刀心轨迹。
     与 offsetChain 相比的关键差异：
       1) envelope 候选（radius ≈ r，或显式 envelope=true）是刀尖圆弧在程序凹拐角处留下的
          包络弧，本身不属于程序轨迹——删除它，取其圆心 V 作为程序拐角拐点；
       2) 对非 envelope 特征调用 offsetSampleGeom(f, r, -side) 完成逆向；
       3) 相邻两个逆向特征端点分离时，沿切线延长取交点作为程序拐点；
       4) 如果用户给的实际轮廓里**不含 envelope 弧**（简化输入），该函数也会在
          cross*side<0 的位置推算出正确的程序拐点。 */
  function reverseOffsetChain(feats, r, side) {
    r = Math.abs(Number(r) || 0);
    if (!(r > 1e-9)) {
      return { features: feats.map(function (f) { return Object.assign({}, f); }), warnings: [] };
    }
    side = side < 0 ? -1 : 1;
    const EPS = Math.max(0.003, r * 0.01);

    // 1) 把 envelope 候选挑出来
    const envIdx = {};
    feats.forEach(function (f, i) {
      if (f.type !== 'arc') return;
      if (f.envelope === true) { envIdx[i] = true; return; }
      if (Math.abs(f.radius - r) <= EPS) envIdx[i] = true;
    });

    // 2) 每个 envelope 候选：取其圆心 V，记录为前后两个相邻特征在程序侧的拐点
    const programCorners = {};   // envIndex -> V
    for (let i = 0; i < feats.length; i++) {
      if (!envIdx[i]) continue;
      const e = feats[i];
      programCorners[i] = { z: e.center.z, r: e.center.r };
    }

    // 3) 对所有特征（含 envelope，后面会根据 envelope 删掉）做逆向 offsetSampleGeom
    const reversed = feats.map(function (f, i) {
      // 逆向用 -side，即正向用 side 从程序→实际，逆向用 -side 从实际→程序
      const o = offsetSampleGeom(f, r, -side);
      return { f: f, o: o, idx: i, isEnv: !!envIdx[i], srcId: f.id };
    });

    // 4) 构造程序特征链：跳过 envelope 候选，把它们的圆心塞到前后相邻特征之间
    const outFeats = [];
    const pendingCorners = [];  // 队列：待插入的 V 点（envelope 圆心）
    for (let i = 0; i < reversed.length; i++) {
      const item = reversed[i];
      if (item.isEnv) {
        // envelope 的圆心是程序拐点，排队插入
        const V = programCorners[i];
        if (V) pendingCorners.push({ V: V, at: 'before' });
        continue;
      }
      // 处理当前特征的起点：可能被前面排队的 V 覆盖
      const prevCorner = pendingCorners.shift();
      if (prevCorner) {
        item.o.start = { z: prevCorner.V.z, r: prevCorner.V.r };
      }
      // 如果这是第一个特征且队列里还有 V（不合逻辑），丢弃
      outFeats.push(item);
    }

    // 6) 拐角处理
    //    a. envelope 提供的 V 已把端点设好 → 已闭合
    //    b. cross*side > 0（凹角）→ 两偏移特征求交，程序走尖角
    //    c. cross*side < 0（凸角）→ 程序侧插入半径 r、圆心为轮廓拐点 V 的圆弧，
    //       这样正向偏移回到轮廓时正好收成一个尖角
    for (let i = 1; i < outFeats.length; i++) {
      const prevItem = outFeats[i - 1];
      const item = outFeats[i];
      const A = prevItem.o;
      const B = item.o;
      const pA = pt(A.end.z, A.end.r);
      const pB = pt(B.start.z, B.start.r);
      if (dist(pA, pB) < 1e-4) continue;   // 已经闭合
      const curA = prevItem.f;
      const curB = item.f;
      const t1 = tangentAt(curA, false), t2 = tangentAt(curB, true);
      const cross = t1.z * t2.r - t1.r * t2.z;
      if (Math.abs(cross) < 1e-7) {
        // 共线：合并端点到中点
        const m = pt((pA.z + pB.z) / 2, (pA.r + pB.r) / 2);
        A.end = m; B.start = m; continue;
      }
      if (cross * side > 0) {
        // 凹角：沿两逆向特征的方向延长求交
        const p = offsetIntersection(A, B);
        if (p) { A.end = p; B.start = p; continue; }
      }
      // 凸角：刀尖绕轮廓拐点摆动，程序侧为半径 r 的圆弧
      const V = pt(curA.end.z, curA.end.d / 2);
      const qA = tangentPointOn(A, V, r, A.end);
      const qB = tangentPointOn(B, V, r, B.start);
      if (qA && qB) {
        A.end = qA;
        B.start = qB;
        // 拐角圆弧走短弧（凸角处刀尖绕拐点摆过的外角恒小于 π）
        const a1 = Math.atan2(qA.r - V.r, qA.z - V.z);
        const a2 = Math.atan2(qB.r - V.r, qB.z - V.z);
        let cw = cross < 0;
        let sw = cw ? norm(a1 - a2) : norm(a2 - a1);
        if (sw > Math.PI) cw = !cw;
        outFeats.splice(i, 0, {
          f: { id: 'CR' + i, line: curA.line },
          o: {
            kind: 'arc', center: V, radius: r, cw: cw,
            start: qA, end: qB,
            a1: a1, a2: a2
          },
          idx: i,
          srcId: 'CR' + i,
          cornerArc: true
        });
        i++;
        continue;
      }
      // 兜底：直接把两端点中点作连接（退化处理）
      const m = pt((pA.z + pB.z) / 2, (pA.r + pB.r) / 2);
      A.end = m; B.start = m;
    }

    /* 求偏移特征 o 上与「圆心 V、半径 r」圆弧相切的点（凸角过渡用） */
    function tangentPointOn(o, V, r, near) {
      if (o.kind === 'line') {
        const dz = o.end.z - o.start.z;
        const dr = o.end.r - o.start.r;
        const len = Math.hypot(dz, dr);
        if (len < 1e-9) return null;
        const t = ((V.z - o.start.z) * dz + (V.r - o.start.r) * dr) / len;
        const p = pt(o.start.z + dz / len * t, o.start.r + dr / len * t);
        if (Math.abs(dist(p, V) - r) > Math.max(1e-3, r * 0.05)) return null;
        return p;
      }
      const cands = circleCircle(o.center, o.radius, V, r);
      let best = null, bd = Infinity;
      cands.forEach(function (p) {
        const dd = dist(p, near);
        if (dd < bd) { bd = dd; best = p; }
      });
      return best;
    }

    // 7) 生成输出特征
    const result = { features: [], warnings: [] };
    outFeats.forEach(function (item, i) {
      const o = item.o;
      if (o.kind === 'arc' && o.radius < 0.002) {
        result.warnings.push('逆向偏移后第 ' + (item.srcId || i + 1) + ' 行圆弧退化，请检查圆弧半径或刀尖半径。');
      }
      const f = {
        id: item.srcId !== undefined ? item.srcId : 'P' + i,
        type: o.kind,
        start: { d: Math.max(0, o.start.r * 2), z: o.start.z },
        end:   { d: Math.max(0, o.end.r   * 2), z: o.end.z },
        center: o.kind === 'arc' ? o.center : null,
        radius: o.kind === 'arc' ? o.radius : 0,
        cw:    !!o.cw,
        rapid: false,
        offset: false
      };
      result.features.push(f);
    });
    return result;
  }

  /* 生成偏移后的特征链；返回 { features, warnings } */
  function offsetChain(feats, r, side, opts) {
    opts = opts || {};
    const result = { features: [], warnings: [] };
    if (!Array.isArray(feats) || !feats.length) return result;
    r = Math.abs(Number(r) || 0);
    if (!(r > 1e-9)) {
      result.features = feats.map(function (f) { return Object.assign({}, f); });
      return result;
    }
    side = side < 0 ? -1 : 1;

    const items = feats.map(function (f, i) {
      let o = offsetSampleGeom(f, r, side);
      // 程序侧半径等于刀尖半径的拐角圆弧：正向偏移后收成一个点（工件尖角），不参与轮廓
      const cornerCollapse = f.type === 'arc' &&
        Math.abs(f.radius - r) <= Math.max(1e-3, r * 0.01);
      if (cornerCollapse) {
        const V = pt(f.center.z, f.center.r);
        o = { kind: 'point', start: V, end: V };
      } else if (o.kind === 'arc' && o.radius < 0.002) {
        result.warnings.push('刀尖半径 R' + r3(r) + ' 使第 ' + (f.line || i + 1) + ' 行圆弧偏移后退化，请检查圆弧半径。');
      }
      if (o.start.r < -1e-6 || o.end.r < -1e-6) {
        result.warnings.push('第 ' + (f.line || i + 1) + ' 行轮廓偏移后越过轴线，已按 X0 截断。');
      }
      return { src: f, o: o, idx: i };
    });

    const envelopes = [];
    for (let i = 1; i < feats.length; i++) {
      const prev = feats[i - 1], cur = feats[i];
      if (dist(endOf(prev), startOf(cur)) > 1e-4) continue;
      const A = items[i - 1].o, B = items[i].o;
      // 拐角圆弧偏移后收成的点：前后两条轮廓直接在该点汇合
      if (A.kind === 'point' || B.kind === 'point') {
        const q = A.kind === 'point' ? A.start : B.start;
        A.end = q; B.start = q;
        continue;
      }
      const t1 = tangentAt(prev, false), t2 = tangentAt(cur, true);
      const cross = t1.z * t2.r - t1.r * t2.z;
      if (Math.abs(cross) < 1e-7) {
        const m = pt((A.end.z + B.start.z) / 2, (A.end.r + B.start.r) / 2);
        A.end = m; B.start = m;
        continue;
      }
      if (cross * side > 0) {
        const p = offsetIntersection(A, B);
        if (p) { A.end = p; B.start = p; continue; }
      }
      /* 包络圆弧：圆心为编程轨迹拐点，半径等于刀尖半径 */
      const V = endOf(prev);
      if (dist(A.end, B.start) < 1e-6) continue;
      const angA = Math.atan2(A.end.r - V.r, A.end.z - V.z);
      const angB = Math.atan2(B.start.r - V.r, B.start.z - V.z);
      const cw = cross < 0;
      envelopes.push({
        idx: i,
        arc: {
          kind: 'arc', center: V, radius: r, cw: cw, a1: angA, a2: angB,
          start: A.end, end: B.start, envelope: true
        }
      });
    }

    function pushFeature(o, src, id) {
      result.features.push({
        id: id,
        type: o.kind,
        start: { d: Math.max(0, o.start.r * 2), z: o.start.z },
        end: { d: Math.max(0, o.end.r * 2), z: o.end.z },
        center: o.kind === 'arc' ? o.center : null,
        radius: o.kind === 'arc' ? o.radius : 0,
        cw: !!o.cw,
        rapid: false,
        comp: src.comp,
        tool: src.tool,
        toolNo: src.toolNo,
        line: src.line,
        gcode: src.gcode,
        offset: true,
        offsetSide: side,
        offsetRadius: r,
        corner: false,
        envelope: !!o.envelope
      });
    }

    for (let i = 0; i < items.length; i++) {
      const src = items[i].src;
      if (items[i].o.kind === 'point') continue;
      pushFeature(items[i].o, src, src.id !== undefined ? src.id : 'O' + i);
      const env = envelopes.find(function (e) { return e.idx === i + 1; });
      if (env) {
        pushFeature(env.arc, src, 'E' + i + '-' + (src.id !== undefined ? src.id : i));
      }
    }
    return result;
  }

  /* 程序特征基准节点：仅取各特征端点与相邻特征交点，禁止线上任意点 */
  function buildSnapNodes(cutting) {
    const map = new Map();
    function add(p, f) {
      const key = Math.round(p.z * 1000) + '|' + Math.round(p.d * 1000);
      let n = map.get(key);
      if (!n) {
        n = {
          z: Math.round(p.z * 1000) / 1000,
          d: Math.round(p.d * 1000) / 1000,
          featureIds: [],
          arcIds: [],
          inner: false,
          outer: false,
          count: 0
        };
        n.r = n.d / 2;
        map.set(key, n);
      }
      if (n.featureIds.indexOf(f.id) < 0) n.featureIds.push(f.id);
      if (f.tool && f.tool.type === 'inner') n.inner = true;
      else n.outer = true;
      if (f.type === 'arc' && f.center && f.radius > 0) {
        n.arcIds.push(f.id);
        n.arc = { r: f.radius, cz: f.center.z, cr: f.center.r };
      }
      n.count++;
    }
    for (const f of cutting) {
      if (f.rapid) continue;
      add({ d: f.start.d, z: f.start.z }, f);
      add({ d: f.end.d, z: f.end.z }, f);
    }
    const out = [];
    map.forEach(function (n) {
      n.kind = n.inner && !n.outer ? 'inner' : 'outer';
      n.type = n.count > 1 ? '交点' : '特征端点';
      n.label = 'X' + r3(n.d).toFixed(3) + ' Z' + r3(n.z).toFixed(3);
      out.push(n);
    });
    out.sort(function (a, b) { return (a.z - b.z) || (a.d - b.d); });
    return out;
  }

  /* 辅助线交点：铅垂线 z=value（axis='z'）或水平线 r=value（axis='r'）与轮廓特征的交点
     直线按参数插值精确求交，圆弧按圆方程求交并校验是否落在弧段角度范围内；
     辅助线为纯测量基准，不参与刀尖半径偏移 */
  function guideIntersections(features, axis, value) {
    const out = [];
    function push(f, z, r) {
      for (const q of out) {
        if (Math.abs(q.z - z) < 1e-6 && Math.abs(q.r - r) < 1e-6) return;
      }
      out.push({ z: z, r: r, d: r * 2, featureId: f.id, featureType: f.type });
    }
    for (const f of features) {
      if (!f || f.rapid || f.type === 'rapid') continue;
      if (f.type === 'line') {
        const a = startOf(f), b = endOf(f);
        if (axis === 'z') {
          const dz = b.z - a.z;
          if (Math.abs(dz) < 1e-9) continue;
          const t = (value - a.z) / dz;
          if (t < -1e-9 || t > 1 + 1e-9) continue;
          const tc = clamp(t, 0, 1);
          push(f, value, a.r + (b.r - a.r) * tc);
        } else {
          const dr = b.r - a.r;
          if (Math.abs(dr) < 1e-9) continue;
          const t = (value - a.r) / dr;
          if (t < -1e-9 || t > 1 + 1e-9) continue;
          const tc = clamp(t, 0, 1);
          push(f, a.z + (b.z - a.z) * tc, value);
        }
        continue;
      }
      const c = f.center;
      if (!c || !(f.radius > 0)) continue;
      const s1 = arcAngles(f).a1;
      const sw = arcSweep(f);
      const dir = f.cw ? -1 : 1;
      const onArc = function (ang) {
        const da = dir > 0 ? norm(ang - s1) : norm(s1 - ang);
        return da <= sw + 1e-7;
      };
      if (axis === 'z') {
        const dx = value - c.z;
        if (Math.abs(dx) > f.radius) continue;
        const h = Math.sqrt(Math.max(0, f.radius * f.radius - dx * dx));
        for (const sgn of [1, -1]) {
          if (h === 0 && sgn < 0) continue;
          const rr = c.r + sgn * h;
          if (onArc(Math.atan2(sgn * h, dx))) push(f, value, rr);
        }
      } else {
        const dy = value - c.r;
        if (Math.abs(dy) > f.radius) continue;
        const h = Math.sqrt(Math.max(0, f.radius * f.radius - dy * dy));
        for (const sgn of [1, -1]) {
          if (h === 0 && sgn < 0) continue;
          const zz = c.z + sgn * h;
          if (onArc(Math.atan2(dy, sgn * h))) push(f, zz, value);
        }
      }
    }
    return out;
  }

  global.Geometry = {
    TAU, EPS, clamp, r3, norm, dist, pt, startOf, endOf,
    lineSamples, arcSamples, sampleFeature, tangentAt, arcAngles, arcSweep, arcFromRS,
    lineLine, lineCircle, circleCircle, offsetArcGeom, offsetLineGeom,
    offsetFeatureSamples, jointIntersection, buildCenterPath, isRadialFeature,
    offsetSampleGeom, offsetChain,
    simplify, nearestOnPolyline, polylineLength, nearestFeature,
    featureLength, pointAtDist, arcParam, onFeature, filletSolve, chamferSolve,
    buildTreatment, trimFeature, composeChain, buildSnapNodes, distFromStart, distFromEnd,
    guideIntersections, reverseOffsetChain
  };
})(window);
