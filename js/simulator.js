/* 车削轮廓仿真
   核心语义（G41/G42 已移除）：
   - 程序 X/Z 是刀尖圆心轨迹（刀心路径），不是工件轮廓。
   - 实际工件轮廓 = 程序轨迹向材料侧等距偏移刀尖圆弧半径 r：
     直线沿法向平移 r；内凹圆弧 实际R = 程序R + r；外凸圆弧 实际R = 程序R − r；
     程序拐角的凹侧会留下以拐点为圆心、半径 r 的包络圆弧。
   - 测量基准节点只取实际工件轮廓的特征端点与相邻特征交点，禁止线上任意点。 */
(function (global) {
  'use strict';

  const STEP = 0.002;          // 显示/偏差采样参考步距 mm
  const PATH_STEP = 0.04;      // 轨迹采样步距 mm
  const SIMPLIFY_TOL = 0.001;  // 轮廓折线简化容差 mm
  const SAMPLE_STEP = 0.02;    // 最终轮廓采样步距 mm
  const DEV_TOL = 0.002;       // 补偿一致性允差 mm

  function samePoint(a, b) {
    return Math.abs(a.d - b.d) < 1e-4 && Math.abs(a.z - b.z) < 1e-4;
  }

  function chainComp(f) {
    const c = Number(f.comp) || 0;
    return c === 41 || c === 42 ? c : 0;
  }

  /* 刀具身份：同类型不同刀号/不同刀尖半径不得并入同一条轮廓链 */
  function toolKey(t) {
    if (!t) return '';
    return String(t.id || ('n' + (t.toolNo === undefined ? '' : t.toolNo)));
  }

  /* 按连续性、刀具身份（类型 + 刀号/半径）与补偿模式分组 */
  function buildChains(cutting) {
    const chains = [];
    let cur = null;
    for (const f of cutting) {
      if (f.rapid) continue;
      if (f.type === 'arc' && !f.center) continue;
      if (samePoint(f.start, f.end)) continue;   // 空走切削段不参与轮廓
      const type = f.tool && f.tool.type === 'inner' ? 'inner' : 'outer';
      const comp = chainComp(f);
      const key = toolKey(f.tool);
      const joined = cur && samePoint(cur.end, f.start) &&
        cur.type === type && cur.comp === comp && cur.toolKey === key;
      if (joined) {
        cur.feats.push(f);
        cur.end = f.end;
      } else {
        cur = {
          feats: [f], type: type, comp: comp, toolKey: key,
          tool: f.tool, start: f.start, end: f.end
        };
        chains.push(cur);
      }
    }
    return chains;
  }

  function sampleFeatures(feats, step) {
    const pts = [];
    for (let i = 0; i < feats.length; i++) {
      const arr = Geometry.sampleFeature(feats[i], step || SAMPLE_STEP);
      const radial = Geometry.isRadialFeature(feats[i]);
      for (let k = i === 0 ? 0 : 1; k < arr.length; k++) {
        const p = arr[k];
        p.radial = radial;
        p.corner = !!feats[i].corner;
        p.envelope = !!feats[i].envelope;
        pts.push(p);
      }
    }
    return pts;
  }

  function longestPoints(chains) {
    let best = null;
    for (const c of chains) {
      if (!best || c.points.length > best.length) best = c.points;
    }
    return best || [];
  }

  /* 刀具几何/磨损补偿：X 为直径量、Z 为轴向，整体平移刀尖圆心轨迹与实际轮廓 */
  function shiftFeatures(feats, dd, dz) {
    if (Math.abs(dd) < 1e-9 && Math.abs(dz) < 1e-9) return feats;
    return feats.map(function (f) {
      const o = Object.assign({}, f);
      o.start = { d: Math.max(0, f.start.d + dd), z: f.start.z + dz };
      o.end = { d: Math.max(0, f.end.d + dd), z: f.end.z + dz };
      if (f.center) {
        o.center = { z: f.center.z + dz, r: Math.max(0, f.center.r + dd / 2) };
      }
      return o;
    });
  }

  function textOf(w) {
    return typeof w === 'string' ? w : (w && w.text ? w.text : '');
  }

  function uniqueWarnings(list) {
    const seen = new Set();
    const out = [];
    for (const w of list) {
      const text = textOf(w);
      if (!text) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
    return out;
  }

  function countEnvelopes(feats) {
    let n = 0;
    for (const f of feats) if (f.envelope) n++;
    return n;
  }

  function simulate(parsed, settings) {
    settings = settings || {};
    const stockDia = Math.max(1, Number(settings.stockDiameter) || 60);
    const stockR = stockDia / 2;
    const cutting = (parsed.cutting || []).filter(function (f) {
      return !(f.type === 'arc' && !f.center);
    });
    const warnings = [];

    if (!cutting.length) {
      return {
        ok: false, outerPoints: [], innerPoints: [], outerChains: [], innerChains: [],
        nominalChains: [], toolpaths: [], snapPoints: [],
        stockRadius: stockR, zMin: -50, zMax: 0, maxDev: 0, avgDev: 0, deviation: [],
        hasOuter: false, hasInner: false, step: STEP,
        stats: { autoFillets: 0, chamfers: 0, rounds: 0, corners: 0 },
        calibration: { tolerance: DEV_TOL, chains: [], total: 0, failed: 0, maxErr: 0, maxDx: 0, maxDz: 0, pass: false },
        compensation: { tolerance: DEV_TOL, applied: false, chains: [] },
        warnings: ['没有可仿真的切削运动']
      };
    }

    let zMin = Infinity, zMax = -Infinity;
    let maxProgR = 0;
    let hasOuter = false, hasInner = false;
    for (const f of cutting) {
      zMin = Math.min(zMin, f.start.z, f.end.z);
      zMax = Math.max(zMax, f.start.z, f.end.z);
      maxProgR = Math.max(maxProgR, f.start.d / 2, f.end.d / 2);
      if (f.tool && f.tool.type === 'inner') hasInner = true;
      else hasOuter = true;
    }
    if (zMax - zMin < 0.5) { zMin -= 0.5; zMax += 0.5; zMin = Math.min(zMin, zMax - 1); }

    const chains = buildChains(cutting);
    const nominalChains = [];
    const outerChains = [];
    const innerChains = [];
    const toolpaths = [];
    const partFeatsAll = [];
    const cornerStats = { autoFillets: 0, chamfers: 0, rounds: 0, corners: 0 };
    let maxDev = 0, sumDev = 0, devCount = 0;
    const deviation = [];
    // 轮廓坐标校准：实际轮廓点到程序（刀心）轨迹的最近距离应恒等于刀尖半径 r；判定阈值 DEV_TOL
    const calibration = { tolerance: DEV_TOL, chains: [], total: 0, failed: 0, maxErr: 0, maxDx: 0, maxDz: 0, pass: false };
    // 刀尖圆弧补偿审计：每条链实际采用的刀尖半径与轮廓到程序轨迹的偏移量
    const compAudit = [];

    for (const ch of chains) {
      const tool = ch.tool || cutting[0].tool || { radius: 0, type: 'outer' };
      const type = ch.type;
      const comp = ch.comp;
      const r = tool.type === 'thread' ? 0 : Math.max(0, Number(tool.radius) || 0);
      const materialSide = type === 'inner' ? -1 : 1;

      // 编程轨迹：显式 C/R 已按程序语义并入，不含自动刀尖过渡
      const prog = Geometry.composeChain(ch.feats, { autoRadius: 0 });
      for (const w of prog.warnings) warnings.push(w);
      prog.features.forEach(function (f) {
        if (f.cornerSource === 'C') cornerStats.chamfers++;
        else if (f.cornerSource === 'R') cornerStats.rounds++;
      });

      // 刀具几何/磨损补偿：X 为直径量、Z 为轴向，先平移刀尖圆心轨迹，再按刀尖半径派生实际轮廓
      const dd = (Number(tool.geoX) || 0) + (Number(tool.wearX) || 0);
      const dz = (Number(tool.geoZ) || 0) + (Number(tool.wearZ) || 0);
      const cut = { features: shiftFeatures(prog.features, dd, dz), warnings: [] };

      // 程序坐标 = 刀尖圆心轨迹；实际工件轮廓 = 补偿后轨迹向材料侧偏移刀尖半径 r
      // 内凹圆弧 实际R = 程序R + r，外凸圆弧 实际R = 程序R − r，程序凹拐角处留下半径 r 的包络弧
      const part = Geometry.offsetChain(cut.features, r, materialSide);
      for (const w of part.warnings) warnings.push(w);

      let progPts = sampleFeatures(prog.features, SAMPLE_STEP);
      const cutMatch = sampleFeatures(cut.features, SAMPLE_STEP);
      let cutPts = cutMatch.slice();
      let partPts = sampleFeatures(part.features, SAMPLE_STEP);

      // 车床以 Z0 为成品端面：忽略 Z>0 的引入段（仅影响显示，补偿校验仍用完整轨迹）
      const clipFront = zMin < -0.5 && zMax > 0.5;
      if (clipFront) {
        progPts = progPts.filter(function (p) { return p.z <= 1e-6; });
        cutPts = cutPts.filter(function (p) { return p.z <= 1e-6; });
        partPts = partPts.filter(function (p) { return p.z <= 1e-6; });
      }
      const toolPts = cutPts;

      if (!partPts.length) continue;
      for (const f of part.features) partFeatsAll.push(f);

      if (progPts.length >= 2) {
        nominalChains.push({
          points: Geometry.simplify(progPts, SIMPLIFY_TOL),
          rawPoints: progPts,
          feats: prog.features,
          type: type,
          comp: comp
        });
      }

      if (partPts.length >= 2) {
        const item = {
          points: Geometry.simplify(partPts, SIMPLIFY_TOL),
          rawPoints: partPts,
          feats: part.features,
          comp: comp,
          tool: tool,
          envelope: countEnvelopes(part.features)
        };
        if (type === 'inner') innerChains.push(item);
        else outerChains.push(item);
      }

      if (toolPts.length >= 2) {
        toolpaths.push({
          points: toolPts,
          feats: cut.features,
          comp: comp,
          tool: tool,
          offsetRadius: r,
          offsetSide: materialSide,
          shiftD: dd,
          shiftZ: dz
        });
      }

      cornerStats.autoFillets += countEnvelopes(part.features);

      // 补偿一致性：实际轮廓上的点到补偿后刀心轨迹的距离应恒等于刀尖半径 r
      // 这是“刀尖圆弧补偿已叠加到实际轮廓”的证据链：刀心轨迹 + R（材料侧）= 实际轮廓
      const audit = {
        toolNo: tool.toolNo, type: type, radius: r, side: materialSide,
        shiftD: dd, shiftZ: dz,
        samples: 0, minOffset: Infinity, maxOffset: -Infinity, maxErr: 0
      };
      if (r > 1e-9 && cutMatch.length >= 2 && partPts.length >= 2) {
        const stride = Math.max(1, Math.round(0.1 / SAMPLE_STEP));
        for (let i = 0; i < partPts.length; i += stride) {
          const p = partPts[i];
          const hit = Geometry.nearestOnPolyline(cutMatch, p);
          if (!hit) continue;
          if (hit.distance > Math.max(4 * r + 1, 2)) continue;
          const err = Math.abs(hit.distance - r);
          audit.samples++;
          audit.minOffset = Math.min(audit.minOffset, hit.distance);
          audit.maxOffset = Math.max(audit.maxOffset, hit.distance);
          audit.maxErr = Math.max(audit.maxErr, err);
          maxDev = Math.max(maxDev, err);
          sumDev += err;
          devCount++;
          if (err > 0.0015 && deviation.length < 240) {
            deviation.push({ z: p.z, r: p.r, nz: hit.point.z, nr: hit.point.r, d: err, offset: hit.distance });
          }
        }
        compAudit.push(audit);
      } else if (r <= 1e-9) {
        audit.minOffset = 0; audit.maxOffset = 0;
        compAudit.push(audit);
      }

      // 逐点坐标匹配：实际轮廓点 → 补偿后刀心轨迹最近点，最近距离应等于刀尖半径 r
      if (cutMatch.length >= 2 && partPts.length >= 2) {
        const expected = r;
        const stride = Math.max(1, Math.round(0.1 / SAMPLE_STEP));
        const chainCal = {
          comp: comp, type: type, expected: expected, shiftD: dd, shiftZ: dz,
          count: 0, failed: 0, maxErr: 0, maxDx: 0, maxDz: 0, pairs: []
        };
        for (let i = 0; i < partPts.length; i += stride) {
          const p = partPts[i];
          const hit = Geometry.nearestOnPolyline(cutMatch, p);
          if (!hit) continue;
          if (hit.distance > Math.max(4 * r + 1, 2)) continue;
          const err = Math.abs(hit.distance - expected);
          const dx = Math.abs(p.r - hit.point.r) * 2;   // X 为直径方向
          const dz = Math.abs(p.z - hit.point.z);       // Z 为轴向
          chainCal.count++;
          calibration.total++;
          if (err > chainCal.maxErr) chainCal.maxErr = err;
          if (err > calibration.maxErr) calibration.maxErr = err;
          if (dx > chainCal.maxDx) chainCal.maxDx = dx;
          if (dz > chainCal.maxDz) chainCal.maxDz = dz;
          if (dx > calibration.maxDx) calibration.maxDx = dx;
          if (dz > calibration.maxDz) calibration.maxDz = dz;
          const okPt = err <= DEV_TOL;
          if (!okPt) { chainCal.failed++; calibration.failed++; }
          if (chainCal.pairs.length < 16) {
            chainCal.pairs.push({
              pz: hit.point.z, pd: hit.point.r * 2,   // 对应程序点（X 为直径）
              z: p.z, d: p.r * 2,                     // 实际轮廓点
              dist: hit.distance, dx: dx, dz: dz, err: err, ok: okPt
            });
          }
        }
        if (chainCal.count) calibration.chains.push(chainCal);
      }
    }
    calibration.pass = calibration.total > 0 && calibration.failed === 0;

    const avgDev = devCount ? sumDev / devCount : 0;

    const allPts = [];
    for (const c of outerChains) for (const p of c.points) allPts.push(p);
    for (const c of innerChains) for (const p of c.points) allPts.push(p);
    let maxPartR = 0;
    for (const p of allPts) {
      zMin = Math.min(zMin, p.z);
      zMax = Math.max(zMax, p.z);
      maxPartR = Math.max(maxPartR, p.r);
    }
    if (maxPartR > stockR + 1e-6) {
      warnings.push('毛坯直径小于实际轮廓最大直径，超出部分按空切处理；建议增大毛坯直径。');
    }
    if (maxProgR > maxPartR + 1e-6 && maxProgR > stockR + 1e-6) {
      warnings.push('程序刀心轨迹超出毛坯边界，请确认程序坐标（刀心）与毛坯直径。');
    }

    cornerStats.corners = cornerStats.chamfers + cornerStats.rounds + cornerStats.autoFillets;
    const snapPoints = Geometry.buildSnapNodes(partFeatsAll);

    return {
      ok: true,
      outerPoints: longestPoints(outerChains),
      innerPoints: longestPoints(innerChains),
      outerChains: outerChains,
      innerChains: innerChains,
      nominalChains: nominalChains,
      toolpaths: toolpaths,
      snapPoints: snapPoints,
      stockRadius: stockR,
      zMin: zMin,
      zMax: zMax,
      maxDev: maxDev,
      avgDev: avgDev,
      deviation: deviation,
      hasOuter: outerChains.length > 0,
      hasInner: innerChains.length > 0,
      step: STEP,
      devTolerance: DEV_TOL,
      stats: cornerStats,
      calibration: calibration,
      compensation: {
        tolerance: DEV_TOL,
        applied: compAudit.some(function (a) { return a.radius > 0; }),
        chains: compAudit
      },
      warnings: uniqueWarnings(warnings)
    };
  }

  global.ContourSimulator = { simulate: simulate, STEP: STEP, DEV_TOL: DEV_TOL };
})(window);
