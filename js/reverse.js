/* 逆向轮廓生成：从实际工件轮廓数据 → 程序刀心轨迹特征 → FANUC G 代码
   与 simulator.js 的正向方向（程序→实际轮廓）配套使用。 */
(function (global) {
  'use strict';

  function fmt(v) { return (Math.round(v * 1000) / 1000).toFixed(3); }

  /* ============ 1. 轮廓数据导入 ============ */

  /* 解析轮廓数据为 { feats, type, warnings }。
     支持的格式：
       A) JSON 端点数组：[[X0,Z0],[X1,Z1], ...]  全部按直线连接
       B) JSON 对象数组：[{point:[X,Z]} | {arcCenter:[Xr,Zr], cw:bool, end:[X,Z]}] 混合
       C) 纯文本：每行 "X Z" 或 "X Z CX CZ CW"（空格/逗号），端点自动直线连接 */
  function parseContour(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    let data = null;
    const warnings = [];
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = null; }
      if (!data) {
        // 纯文本逐行解析（最后再试一次对象解析失败的情况）
        const rows = text.split(/\r?\n/).map(function (ln) {
          return ln.trim().replace(/^[;,#].*$/, '').trim();
        }).filter(Boolean);
        data = rows.map(function (ln) {
          const toks = ln.split(/[\s,]+/).filter(Boolean).map(Number);
          if (!toks.length || toks.some(function (n) { return !isFinite(n); })) return null;
          if (toks.length === 2) return { point: [toks[0], toks[1]] };
          if (toks.length >= 5) {
            return { arcCenter: [toks[2], toks[3]], cw: !!toks[4], end: [toks[0], toks[1]] };
          }
          return { point: [toks[0], toks[1]] };
        }).filter(Boolean);
      }
    } else {
      data = raw;
    }

    if (!data) return { feats: [], tool: null, side: +1, warnings: ['轮廓数据为空'] };

    // 外层对象：{ tool, contour }
    let tool = null, side = +1, items = data;
    if (data && !Array.isArray(data) && Array.isArray(data.contour)) {
      tool = data.tool || null;
      side = toolSide(tool);
      items = data.contour;
    } else if (Array.isArray(data)) {
      items = data;
    } else {
      return { feats: [], tool: null, side: +1, warnings: ['轮廓数据结构不明'] };
    }

    if (!Array.isArray(items) || !items.length) {
      return { feats: [], tool: tool, side: side, warnings: ['未识别到有效端点'] };
    }

    // 统一为 item 对象：{ point:[X,Z] } 直线端点 / { arcCenter:[Xr,Zr], cw, end:[X,Z] } 圆弧端点
    const normalized = items.map(function (it) {
      if (Array.isArray(it)) {
        if (it.length >= 2 && it.every(function (n) { return isFinite(n); })) return { point: [+it[0], +it[1]] };
        return null;
      }
      if (it && typeof it === 'object') return it;
      return null;
    }).filter(Boolean);

    if (!normalized.length) {
      return { feats: [], tool: tool, side: side, warnings: ['未识别到有效端点'] };
    }

    // 转成 features：起点是第一个 point；直线段 = 当前 point 到下一个 point；
    // 圆弧段 = 当前 point 到 end（arcCenter 给圆心）
    const feats = [];
    let prev = null;
    for (let i = 0; i < normalized.length; i++) {
      const it = normalized[i];
      if (!prev) { prev = it.point ? it.point.slice() : null; continue; }
      if (!prev) continue;
      const id = 'C' + i;
      if (it.point) {
        feats.push({
          id: id, type: 'line',
          start: { d: prev[0], z: prev[1] },
          end:   { d: it.point[0], z: it.point[1] },
          center: null, radius: 0, cw: false, rapid: false
        });
        prev = it.point.slice();
      } else if (it.end && it.arcCenter) {
        feats.push(buildArc({
          id: id, startD: prev[0], startZ: prev[1],
          endD: it.end[0], endZ: it.end[1],
          centerR: it.arcCenter[0] / 2, centerZ: it.arcCenter[1],
          cw: !!it.cw
        }));
        prev = it.end.slice();
      } else {
        warnings.push('第 ' + (i + 1) + ' 个条目格式不明');
      }
    }

    return { feats: feats, tool: tool, side: side, warnings: warnings };
  }

  function toolSide(tool) {
    if (!tool) return +1;
    if (tool.type === 'inner') return -1;
    return +1;
  }

  /* 已知端点、圆心、方向 → 构造圆弧 feature（含 center.r / center.z / radius / cw） */
  function buildArc(opts) {
    const sR = opts.startD / 2, eR = opts.endD / 2;
    const c = { z: opts.centerZ, r: opts.centerR };
    const start = { d: opts.startD, z: opts.startZ };
    const end   = { d: opts.endD,  z: opts.endZ };
    const a1 = Math.atan2(sR - c.r, opts.startZ - c.z);
    const a2 = Math.atan2(eR - c.r, opts.endZ - c.z);
    const R = Math.hypot(opts.startZ - c.z, sR - c.r);
    // 确定 cw：从 start → end 的实际方向
    const sweep = sweepAngle(a1, a2, opts.cw);
    // 修正 cw：让 start → end 沿 cw 方向扫过 sweep
    const actualCw = opts.cw;
    return {
      id: opts.id, type: 'arc', start: start, end: end, center: c,
      radius: R, cw: actualCw, rapid: false, sweep: sweep, a1: a1, a2: a2
    };
  }

  function sweepAngle(a1, a2, cw) {
    let da = a2 - a1;
    if (cw) {
      // 顺时针 sweep 为正（数学上逆时针增加，所以顺时针是负方向）
      // 我们这里 sweep 是正数值
      while (da >= 0) da -= Math.PI * 2;
      return Math.abs(da) % (Math.PI * 2);
    } else {
      while (da <= 0) da += Math.PI * 2;
      return da % (Math.PI * 2);
    }
  }

  /* ============ 2. 逆向生成程序轨迹 ============ */

  /* 给定实际轮廓 features + 刀尖半径 + 材料侧 → 程序刀心轨迹 features */
  function reverseContour(actualFeats, r, side) {
    return global.Geometry.reverseOffsetChain(actualFeats, r, side);
  }

  /* ============ 3. G 代码生成 ============ */

  /* 把程序特征链输出成 FANUC G 代码。
     参数：
       opts = {
         units: 'mm'|'inch',        // G21/G20
         toolNo: 1,                 // T 号
         toolName: '外圆精车刀',     // 仅注释
         spindle: 2000,             // G50 S
         speed: 180,                // G96 S 恒线速
         feed: 0.2,                 // F
         startD: 64, startZ: 2,     // 起刀点（默认毛坯外）
         safetyD: 66, safetyZ: 2,   // 安全退刀点
         numberStart: 10, numberStep: 5,
         coolant: false,             // M08
         retractEnd: true,           // 结束时返回安全点
         programNo: 1007             // O 号
       } */
  function generateGcode(progFeats, opts) {
    opts = opts || {};
    const unitG = opts.units === 'inch' ? 'G20' : 'G21';
    const T = opts.toolNo ? 'T' + String(opts.toolNo).padStart(2, '0') + String(opts.toolNo).padStart(2, '0') : 'T0101';
    const S50 = opts.spindle ? 'G50 S' + opts.spindle : '';
    const S96 = opts.speed !== undefined ? 'G96 S' + opts.speed + ' M03' : 'M03';
    const F = opts.feed !== undefined ? 'F' + opts.feed.toFixed(2) : 'F0.2';
    const startD = opts.startD !== undefined ? opts.startD : (progFeats[0] && progFeats[0].start ? progFeats[0].start.d + 6 : 64);
    const startZ = opts.startZ !== undefined ? opts.startZ : (progFeats[0] && progFeats[0].start ? progFeats[0].start.z + 2 : 2);
    const safetyD = opts.safetyD !== undefined ? opts.safetyD : startD + 2;
    const safetyZ = opts.safetyZ !== undefined ? opts.safetyZ : startZ;
    const numStart = opts.numberStart || 10;
    const numStep = opts.numberStep || 5;
    const toolName = opts.toolName ? ' (' + opts.toolName + ')' : '';

    const out = [];
    let N = numStart;
    const line = function () { return 'N' + N; };
    const bump = function () { N += numStep; };

    const p0 = progFeats[0] && progFeats[0].start;

    out.push('O' + (opts.programNo || 1007) + toolName);
    out.push(line() + ' ' + unitG + ' G99'); bump();
    out.push(line() + ' ' + T); bump();
    if (S50) { out.push(line() + ' ' + S50); bump(); }
    out.push(line() + ' ' + S96); bump();
    if (opts.coolant) { out.push(line() + ' M08'); bump(); }
    out.push(line() + ' G00 X' + fmt(startD) + ' Z' + fmt(startZ)); bump();
    if (p0) {
      // 快速定位到轮廓起点：不产生额外的 G01 引入段，保证程序路径就是目标轮廓
      out.push(line() + ' G00 X' + fmt(p0.d) + ' Z' + fmt(p0.z)); bump();
    }
    for (let i = 0; i < progFeats.length; i++) {
      const f = progFeats[i];
      const D = fmt(f.end.d), Z = fmt(f.end.z);
      if (f.type === 'line') {
        out.push(line() + ' G01 X' + D + ' Z' + Z);
      } else if (f.type === 'arc' && f.center) {
        const G = f.cw ? 'G02' : 'G03';
        const I = fmt(f.center.r - f.start.d / 2);   // I = 圆心R − 起点R（半径增量）
        const K = fmt(f.center.z - f.start.z);
        out.push(line() + ' ' + G + ' X' + D + ' Z' + Z + ' I' + I + ' K' + K);
      } else {
        out.push(line() + ' G01 X' + D + ' Z' + Z);
      }
      if (i === 0) out[out.length - 1] += ' ' + F;
      bump();
    }
    if (opts.retractEnd !== false) {
      out.push(line() + ' G00 X' + fmt(safetyD) + ' Z' + fmt(safetyZ)); bump();
    }
    out.push(line() + ' M30');
    return out.join('\n');
  }

  /* ============ 4. 一站式：输入轮廓 JSON → 程序特征 + G 代码 + 审计 ============ */

  function runPipeline(rawContour, toolOpts, gcodeOpts) {
    toolOpts = toolOpts || {};
    gcodeOpts = gcodeOpts || {};
    const parsed = parseContour(rawContour);
    const r = toolOpts.radius !== undefined ? Math.abs(toolOpts.radius) : (parsed.tool && parsed.tool.radius) || 0.8;
    const side = toolOpts.side !== undefined ? toolOpts.side : parsed.side;
    const prog = reverseContour(parsed.feats, r, side);
    const gcode = generateGcode(prog.features, Object.assign({
      toolNo: toolOpts.toolNo || (parsed.tool && parsed.tool.toolNo) || 1,
      toolName: toolOpts.toolName || (parsed.tool && parsed.tool.name) || '逆向轮廓程序',
      programNo: gcodeOpts.programNo || 1007,
      startD: gcodeOpts.startD, startZ: gcodeOpts.startZ,
      safetyD: gcodeOpts.safetyD, safetyZ: gcodeOpts.safetyZ,
      feed: gcodeOpts.feed !== undefined ? gcodeOpts.feed : 0.2,
      speed: gcodeOpts.speed !== undefined ? gcodeOpts.speed : 180,
      spindle: gcodeOpts.spindle || 2500,
      retractEnd: gcodeOpts.retractEnd !== false,
      coolant: !!gcodeOpts.coolant
    }, toolOpts));

    return {
      inputFeatures: parsed.feats,
      inputSide: side,
      inputRadius: r,
      programFeatures: prog.features,
      warnings: parsed.warnings.concat(prog.warnings || []),
      gcode: gcode
    };
  }

  global.ReverseContour = {
    parseContour: parseContour,
    reverseContour: reverseContour,
    generateGcode: generateGcode,
    runPipeline: runPipeline
  };
})(window);
