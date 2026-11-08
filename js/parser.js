/* FANUC 车削程序解析器
   - 支持 G00/G01/G02/G03、G90/G91、G20/G21（G40/G41/G42 已移除：程序坐标即刀尖圆心轨迹）
   - 支持 G70/G71/G72/G73 轮廓段提取（轮廓程序段按顺序解析为最终轮廓）
   - G74/G75/G76/G92/G32 识别并给出近似说明
   - 输出带程序段索引的特征段，供双向编辑回写 */
(function (global) {
  'use strict';

  const G_KNOWN = new Set([
    0, 1, 2, 3, 4, 9, 10, 17, 20, 21, 22, 23, 27, 28, 30, 31, 32, 33, 34, 37, 38, 39,
    40, 41, 42, 43, 44, 49, 50, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 64, 65,
    68, 70, 71, 72, 73, 74, 75, 76, 80, 90, 91, 92, 94, 95, 96, 97, 98, 99
  ]);
  const LETTERS_OK = new Set('GMNOSTFXZURIKPQABCDEHLVWY'.split(''));

  const WORD_RE = /([A-Z])([+-]?(?:\d+\.?\d*|\.\d+))/g;

  function splitLine(line) {
    let code = line;
    let comment = '';
    const pi = code.indexOf('(');
    const si = code.indexOf(';');
    let cut = -1;
    if (pi >= 0) cut = pi;
    if (si >= 0 && (cut < 0 || si < cut)) cut = si;
    if (cut >= 0) {
      const tail = code.slice(cut);
      code = code.slice(0, cut);
      comment = tail;
      // FANUC 允许同一行圆括号备注，去掉
      comment = comment.replace(/\([^)]*\)/g, '');
    }
    return { code: code, comment: comment };
  }

  function parseWords(code) {
    const up = code.toUpperCase();
    const words = [];
    let m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(up)) !== null) {
      words.push({ letter: m[1], value: parseFloat(m[2]), text: m[0], index: m.index });
    }
    return words;
  }

  function findWord(words, letter) {
    for (let i = words.length - 1; i >= 0; i--) if (words[i].letter === letter) return words[i];
    return null;
  }
  function hasWord(words, letter) {
    return words.some(function (w) { return w.letter === letter; });
  }

  function toolForT(tools, tValue, fallback) {
    if (!tValue) return fallback;
    const num = tValue >= 100 ? Math.floor(tValue / 100) : tValue;
    let t = tools.find(function (x) { return Number(x.toolNo) === num; });
    if (!t) t = tools.find(function (x) { return Number(x.toolNo) === Number(String(tValue).slice(0, -2) || tValue); });
    return t || fallback;
  }

  /**
   * @param {string} src 程序文本
   * @param {Array} tools 刀具列表
   * @param {{activeToolId?:string}} opts
   */
  function parse(src, tools, opts) {
    opts = opts || {};
    const list = Array.isArray(tools) && tools.length ? tools : [];
    const fallback = list.find(function (t) { return t.id === opts.activeToolId; }) || list[0] || {
      id: 't0', toolNo: 1, name: '外圆刀', type: 'outer', radius: 0.8,
      angle: 55, width: 0, geoX: 0, geoZ: 0, wearX: 0, wearZ: 0
    };

    const rawLines = String(src == null ? '' : src).replace(/\r/g, '').split('\n');
    const features = [];
    const diagnostics = [];
    const missingTools = new Set();
    const cycleWarned = new Set();
    let unknownG = new Set();
    let totalWords = 0, unknownWords = 0;
    let pos = null;
    let blockCount = 0;

    const modal = {
      motion: null,       // 0,1,2,3
      comp: 0,            // 刀尖补偿已移除，恒为 0
      abs: true,
      unit: 1,            // mm per program unit
      feed: 0.2,
      tool: fallback,
      toolNo: Number(fallback.toolNo) || 1
    };

    let ended = false;
    const compWarned = new Set();

    for (let li = 0; li < rawLines.length; li++) {
      if (ended) break;
      let raw = rawLines[li];
      if (raw.trim().startsWith('/')) raw = raw.trim().slice(1);
      const parts = splitLine(raw);
      const code = parts.code;
      if (!code.trim()) continue;

      blockCount++;
      const words = parseWords(code);
      totalWords += words.length;

      // 未知 G / 字母统计
      const gWords = words.filter(function (w) { return w.letter === 'G'; });
      const gVals = gWords.map(function (w) { return Math.abs(w.value); });
      for (const w of words) {
        if (!LETTERS_OK.has(w.letter)) { unknownWords++; }
      }
      for (const g of gVals) {
        const intg = Math.round(g);
        if (!G_KNOWN.has(intg)) {
          unknownG.add(intg);
          diagnostics.push({ line: li + 1, level: 'warn', text: '未识别的 G 指令 G' + intg + '，已跳过该功能。' });
        }
      }

      const nWord = findWord(words, 'N');
      const lineNo = nWord ? 'N' + Math.round(nWord.value) : String(li + 1);

      // 单位与坐标模式需先于运动生效
      if (gVals.some(function (g) { return Math.round(g) === 20; })) {
        modal.unit = 25.4;
        diagnostics.push({ line: li + 1, level: 'ok', text: '切换到英制单位 G20（内部统一换算为 mm）。' });
      }
      if (gVals.some(function (g) { return Math.round(g) === 21; })) modal.unit = 1;
      if (gVals.some(function (g) { return Math.round(g) === 90; })) modal.abs = true;
      if (gVals.some(function (g) { return Math.round(g) === 91; })) modal.abs = false;
      // G41/G42 刀尖补偿功能已移除：忽略并警告，程序坐标一律按刀尖圆心轨迹处理
      modal.comp = 0;
      for (const g of gVals) {
        const intg = Math.round(g);
        if ((intg === 41 || intg === 42) && !compWarned.has(intg)) {
          compWarned.add(intg);
          diagnostics.push({
            line: li + 1, level: 'warn',
            text: 'G' + intg + ' 刀尖半径补偿功能已移除，已忽略；程序 X/Z 作为刀尖圆心轨迹，实际工件轮廓由系统按刀尖半径向材料侧自动偏移生成。'
          });
        }
      }

      const tWord = findWord(words, 'T');
      if (tWord) {
        modal.toolNo = tWord.value >= 100 ? Math.floor(tWord.value / 100) : Math.round(tWord.value);
        const found = toolForT(list, tWord.value, null);
        if (found) modal.tool = found;
        else {
          modal.tool = fallback;
          if (!missingTools.has(modal.toolNo)) {
            missingTools.add(modal.toolNo);
            diagnostics.push({ line: li + 1, level: 'warn', text: 'T' + modal.toolNo + ' 未在刀具表中，暂用当前刀具参数计算。' });
          }
        }
      }

      // 固定循环 / 轮廓循环：循环行本身不产生运动
      const cycleCodes = new Set();
      gVals.forEach(function (g) { cycleCodes.add(Math.round(g)); });
      const skipBlock =
        cycleCodes.has(70) || cycleCodes.has(71) || cycleCodes.has(72) || cycleCodes.has(73) ||
        cycleCodes.has(74) || cycleCodes.has(75) || cycleCodes.has(76) ||
        cycleCodes.has(28) || cycleCodes.has(30) || cycleCodes.has(50) ||
        cycleCodes.has(4) || cycleCodes.has(9) || cycleCodes.has(10);

      if (cycleCodes.has(74) || cycleCodes.has(75) || cycleCodes.has(76)) {
        const c = cycleCodes.has(74) ? 'G74' : cycleCodes.has(75) ? 'G75' : 'G76';
        if (!cycleWarned.has(c)) {
          cycleWarned.add(c);
          diagnostics.push({ line: li + 1, level: 'ok', text: c + ' 固定循环已识别；轮廓按最终坐标近似显示。' });
        }
      }
      if (cycleCodes.has(70) || cycleCodes.has(71) || cycleCodes.has(72) || cycleCodes.has(73)) {
        const c = cycleCodes.has(70) ? 'G70' : cycleCodes.has(71) ? 'G71' : cycleCodes.has(72) ? 'G72' : 'G73';
        if (!cycleWarned.has(c)) {
          cycleWarned.add(c);
          diagnostics.push({ line: li + 1, level: 'ok', text: c + ' 轮廓循环：程序段轮廓作为最终精车轮廓计算。' });
        }
      }

      // 进给与主轴
      const fWord = findWord(words, 'F');
      if (fWord && fWord.value > 0) modal.feed = fWord.value;

      // 运动模式
      let motion = null;
      for (const w of gWords) {
        const g = Math.round(Math.abs(w.value));
        if (g >= 0 && g <= 3) motion = g;
      }
      if (motion !== null) modal.motion = motion;

      if (skipBlock) {
        const mWords = words.filter(function (w) { return w.letter === 'M'; });
        if (mWords.some(function (w) { return Math.round(w.value) === 2 || Math.round(w.value) === 30; })) ended = true;
        continue;
      }

      // G92 / G32 螺纹车削按最终坐标直线近似
      const isThread = cycleCodes.has(92) || cycleCodes.has(32);
      if (isThread && !skipBlock) {
        if (!cycleWarned.has('G92')) {
          cycleWarned.add('G92');
          diagnostics.push({ line: li + 1, level: 'ok', text: 'G92/G32 螺纹车削已识别；轮廓按最终小径近似显示（不含牙型细节）。' });
        }
      }

      if (modal.motion === null && !isThread) {
        const mWords = words.filter(function (w) { return w.letter === 'M'; });
        if (mWords.some(function (w) { return Math.round(w.value) === 2 || Math.round(w.value) === 30; })) ended = true;
        continue;
      }

      const gcode = 'G0' + (isThread ? 1 : modal.motion);
      const motionNo = isThread ? 1 : modal.motion;
      if (motionNo === null) continue;

      const xW = findWord(words, 'X');
      const zW = findWord(words, 'Z');
      const uW = findWord(words, 'U');
      const wW = findWord(words, 'W');
      const aW = findWord(words, 'A');
      const rW = findWord(words, 'R');
      const cW = findWord(words, 'C');
      const iW = findWord(words, 'I');
      const kW = findWord(words, 'K');

      if (!xW && !zW && !uW && !wW) {
        if (aW && (motionNo === 1 || motionNo === 0)) {
          diagnostics.push({ line: li + 1, level: 'warn', text: 'A 角度需与 X/U 或 Z/W 之一配合才能确定终点，已忽略本段。' });
        }
        const mWords = words.filter(function (w) { return w.letter === 'M'; });
        if (mWords.some(function (w) { return Math.round(w.value) === 2 || Math.round(w.value) === 30; })) ended = true;
        continue;
      }

      if (pos === null) {
        if (motionNo === 0) {
          const tgt = targetOf(modal, null, xW, zW, uW, wW, aW, li);
          if (tgt) pos = tgt;
          continue;
        } else {
          diagnostics.push({ line: li + 1, level: 'warn', text: '初始刀具位置未知，按 X0 Z0 起算。' });
          pos = { d: 0, z: 0 };
        }
      }

      const tgt = targetOf(modal, pos, xW, zW, uW, wW, aW, li);
      if (!tgt) continue;
      if (tgt.d < -1e-6) {
        diagnostics.push({ line: li + 1, level: 'warn', text: 'X 坐标为负值（' + tgt.d.toFixed(3) + '），请确认直径编程是否正确。' });
      }

      const start = { d: pos.d, z: pos.z };
      const end = { d: Math.max(0, tgt.d), z: tgt.z };
      const startR = { z: start.z, r: start.d / 2 };
      const endR = { z: end.z, r: end.d / 2 };

      let cornerC = 0, cornerR = 0;
      if (motionNo !== 0) {
        if (cW && cW.value > 0) cornerC = cW.value * modal.unit;
        if (motionNo === 1 && rW && rW.value > 0) cornerR = rW.value * modal.unit;
        if (cornerC > 0 && cornerR > 0) {
          diagnostics.push({ line: li + 1, level: 'warn', text: '同一程序段同时指定 C 与 R，拐角优先按 C 倒角处理。' });
          cornerR = 0;
        }
      }

      let feature = {
        id: features.length,
        blockIndex: li,
        line: li + 1,
        lineNo: lineNo,
        gcode: gcode,
        motion: motionNo,
        type: motionNo === 0 ? 'rapid' : (motionNo === 2 || motionNo === 3 ? 'arc' : 'line'),
        rapid: motionNo === 0,
        start: start,
        end: end,
        feed: modal.feed,
        toolNo: modal.toolNo,
        tool: modal.tool,
        comp: modal.comp,
        cw: false,
        center: null,
        radius: 0,
        thread: isThread,
        blockText: raw,
        unit: modal.unit,
        xAbs: modal.abs,
        zAbs: modal.abs,
        xLetter: xW ? 'X' : (uW ? 'U' : null),
        zLetter: zW ? 'Z' : (wW ? 'W' : null),
        arcMode: null,
        angleA: (aW && motionNo === 1) ? aW.value : null,
        cornerC: cornerC,
        cornerR: cornerR
      };

      if (motionNo === 2 || motionNo === 3) {
        feature.cw = motionNo === 2;
        if (rW) {
          const Rraw = Math.abs(rW.value) * modal.unit;
          const signed = rW.value < 0 ? -Rraw : Rraw;
          let arc = Geometry.arcFromRS(startR, endR, signed, feature.cw);
          const chord = Geometry.dist(startR, endR);
          if (chord < 1e-5) {
            diagnostics.push({ line: li + 1, level: 'err', text: '圆弧起点与终点重合，无法生成圆弧。' });
            feature.type = 'line';
          } else if (arc) {
            if (chord > 2 * Math.abs(Rraw) - 1e-4) {
              diagnostics.push({ line: li + 1, level: 'warn', text: '圆弧 R' + Math.abs(rW.value).toFixed(3) + ' 小于弦长一半，已按最小可行半径计算。' });
            }
            feature.center = arc.center;
            feature.radius = arc.radius;
            feature.arcMode = 'R';
          } else {
            feature.type = 'line';
          }
        } else if (iW || kW) {
          const I = (iW ? iW.value : 0) * modal.unit; // X 方向为半径增量
          const K = (kW ? kW.value : 0) * modal.unit;
          const center = { z: startR.z + K, r: startR.r + I };
          const rs = Geometry.dist(startR, center);
          const re = Geometry.dist(endR, center);
          feature.center = center;
          feature.radius = rs;
          feature.arcMode = 'IK';
          if (Math.abs(re - rs) > 0.02) {
            diagnostics.push({ line: li + 1, level: 'warn', text: '圆弧 I/K 圆心与终点半径不匹配（差 ' + Math.abs(re - rs).toFixed(3) + ' mm），请检查程序。' });
          }
        } else {
          diagnostics.push({ line: li + 1, level: 'warn', text: 'G02/G03 缺少 R 或 I/K，按直线处理。' });
          feature.type = 'line';
        }
      }

      features.push(feature);
      pos = { d: end.d, z: end.z };

      const mWords = words.filter(function (w) { return w.letter === 'M'; });
      if (mWords.some(function (w) { return Math.round(w.value) === 2 || Math.round(w.value) === 30; })) ended = true;
    }

    /* 计算程序段终点：X/U/W/Z 增量、G90/G91、A 角度（自 -Z 轴，真实半径平面） */
    function targetOf(m, p, xW, zW, uW, wW, aW, li) {
      const startD = p ? p.d : 0, startZ = p ? p.z : 0;
      let d = startD, z = startZ;
      const hasX = !!(xW || uW), hasZ = !!(zW || wW);
      if (!hasX && !hasZ) return null;

      if (xW) d = (m.abs ? xW.value : startD / m.unit + xW.value) * m.unit;
      else if (uW) d = startD + uW.value * m.unit;
      if (zW) z = m.abs ? zW.value * m.unit : startZ + zW.value * m.unit;
      else if (wW) z = startZ + wW.value * m.unit;

      if (aW) {
        const Ad = aW.value;
        const rad = Ad * Math.PI / 180;
        const tanA = Math.tan(rad);
        const cosA = Math.cos(rad);
        const dx = d - startD;
        const dz = z - startZ;
        if (hasX && hasZ) {
          if (Math.abs(cosA) < 1e-6) {
            if (Math.abs(dz) > 0.005) {
              diagnostics.push({ line: li + 1, level: 'warn', text: 'A' + Ad + '° 为纯径向，但程序同时给出了 Z 位移，已保留 X/Z 坐标。' });
            }
          } else {
            const expectDx = -2 * dz * tanA;
            if (Math.abs(dx - expectDx) > 0.02) {
              diagnostics.push({ line: li + 1, level: 'warn', text: 'A' + Ad + '° 与 X/Z 坐标不一致（角度推算 ΔX=' + expectDx.toFixed(3) + '，程序 ΔX=' + dx.toFixed(3) + '），已按程序坐标计算。' });
            }
          }
        } else if (hasZ) {
          if (Math.abs(cosA) < 1e-6) {
            diagnostics.push({ line: li + 1, level: 'warn', text: 'A' + Ad + '° 接近纯径向，仅给出 Z 无法确定 X，已按终点 X 不变处理。' });
          } else {
            d = startD - 2 * dz * tanA;
          }
        } else if (hasX) {
          if (Math.abs(cosA) < 1e-6) {
            z = startZ;
          } else if (Math.abs(tanA) < 1e-7) {
            diagnostics.push({ line: li + 1, level: 'warn', text: 'A' + Ad + '° 接近纯轴向，仅给出 X 无法确定 Z，已按终点 Z 不变处理。' });
            z = startZ;
          } else {
            z = startZ - dx / (2 * tanA);
          }
        }
      }
      return { d: d, z: z };
    }

    // 段末 C/R 必须由下一段连续切削轮廓承接，否则不构成拐角
    const contourOrder = features.filter(function (f) { return !f.rapid; });
    for (let i = 0; i < contourOrder.length; i++) {
      const f = contourOrder[i];
      if (!(f.cornerC > 0 || f.cornerR > 0)) continue;
      const nf = contourOrder[i + 1];
      const joined = nf &&
        Math.abs(nf.start.d - f.end.d) < 1e-4 && Math.abs(nf.start.z - f.end.z) < 1e-4;
      if (!joined) {
        diagnostics.push({ line: f.line, level: 'warn', text: '段末 C/R 没有连续的下一条切削轮廓，已忽略该拐角处理。' });
        f.cornerC = 0;
        f.cornerR = 0;
      }
    }

    const cutting = features.filter(function (f) { return !f.rapid; });
    const arcs = cutting.filter(function (f) { return f.type === 'arc'; });
    const chamfers = cutting.filter(function (f) { return f.cornerC > 0; });
    const rounds = cutting.filter(function (f) { return f.cornerR > 0; });
    const angleBlocks = cutting.filter(function (f) { return f.angleA !== null; });
    const threads = cutting.filter(function (f) { return f.thread; });
    let dMax = 0, zMin = Infinity, zMax = -Infinity;
    for (const f of features) {
      dMax = Math.max(dMax, f.start.d, f.end.d);
      zMin = Math.min(zMin, f.start.z, f.end.z);
      zMax = Math.max(zMax, f.start.z, f.end.z);
      if (f.type === 'arc' && f.center) {
        dMax = Math.max(dMax, 2 * (f.center.r + f.radius));
      }
    }
    if (!features.length) { zMin = -50; zMax = 0; dMax = 50; }

    const totalCounted = Math.max(1, totalWords);
    const unknownCount = unknownG.size * 2 + unknownWords;
    const coverage = Math.min(1, Math.max(0, (totalCounted - unknownCount) / totalCounted));
    const compUsed = [];

    if (!cutting.length) {
      diagnostics.push({ line: 0, level: 'err', text: '未找到有效切削运动（G01/G02/G03），无法生成轮廓。' });
    } else if (!diagnostics.some(function (d) { return d.level === 'err' || d.level === 'warn'; })) {
      diagnostics.push({ line: 0, level: 'ok', text: '程序段解析完成，未发现语法问题。' });
    }

    return {
      features: features,
      cutting: cutting,
      rapid: features.filter(function (f) { return f.rapid; }),
      diagnostics: diagnostics,
      coverage: coverage,
      stats: {
        lines: rawLines.length,
        blocks: blockCount,
        segments: cutting.length,
        arcs: arcs.length,
        threads: threads.length,
        chamfers: chamfers.length,
        rounds: rounds.length,
        angles: angleBlocks.length,
        rapids: features.filter(function (f) { return f.rapid; }).length,
        dMax: dMax,
        zMin: zMin,
        zMax: zMax,
        compUsed: compUsed,
        toolsUsed: Array.from(new Set(features.map(function (f) { return f.toolNo; }))).sort(),
        unknownG: Array.from(unknownG),
        words: totalWords,
        coverage: coverage
      }
    };
  }

  /* ================= 双向编辑：回写程序段 ================= */
  function splitForEdit(line) {
    let code = line, tail = '';
    const pi = code.indexOf('(');
    const si = code.indexOf(';');
    let cut = -1;
    if (pi >= 0) cut = pi;
    if (si >= 0 && (cut < 0 || si < cut)) cut = si;
    if (cut >= 0) { tail = code.slice(cut); code = code.slice(0, cut); }
    return { code: code, tail: tail };
  }

  function fmt(n) {
    if (!isFinite(n)) n = 0;
    let s = n.toFixed(3);
    if (s === '-0.000') s = '0.000';
    return s;
  }

  function replaceWord(code, letter, valueText) {
    const re = new RegExp('(' + letter + ')(\\s*)([+-]?(?:\\d+\\.?\\d*|\\.\\d+))');
    if (re.test(code)) return code.replace(re, letter + valueText);
    return code.replace(/\s+$/, '') + ' ' + letter + valueText + ' ';
  }

  function hasNumberWord(code, letter) {
    return new RegExp(letter + '\\s*[+-]?(?:\\d+\\.?\\d*|\\.\\d+)').test(code);
  }

  function stripWords(code, letters) {
    let out = code;
    for (const l of letters) {
      out = out.replace(new RegExp('\\s*' + l + '\\s*[+-]?(?:\\d+\\.?\\d*|\\.\\d+)', 'g'), '');
    }
    return out;
  }

  /**
   * @param {string} program
   * @param {object} feature 解析后的特征
   * @param {{x?:number, z?:number, radius?:number, cw?:boolean}} changes 绝对 mm 值
   */
  function applyFeatureEdit(program, feature, changes) {
    const lines = program.replace(/\r/g, '').split('\n');
    const idx = feature.blockIndex;
    if (idx < 0 || idx >= lines.length) return program;
    const parts = splitForEdit(lines[idx]);
    let code = parts.code;
    const unit = feature.unit || 1;

    if (changes.x !== undefined) {
      const newD = changes.x;
      const startD = feature.start.d;
      const valMm = feature.xLetter === 'U' || feature.xAbs === false ? (newD - startD) : newD;
      const val = valMm / unit;
      if (feature.xLetter === 'U') code = replaceWord(code, 'U', fmt(val));
      else if (feature.xLetter === 'X') code = replaceWord(code, 'X', fmt(feature.xAbs ? newD / unit : (newD - startD) / unit));
      else {
        if (hasNumberWord(code, 'X')) {
          code = replaceWord(code, 'X', fmt(feature.xAbs ? newD / unit : (newD - startD) / unit));
        } else {
          code = replaceWord(code, 'X', fmt(feature.xAbs ? newD / unit : (newD - startD) / unit));
        }
      }
    }

    if (changes.z !== undefined) {
      const newZ = changes.z;
      const startZ = feature.start.z;
      if (feature.zLetter === 'W') code = replaceWord(code, 'W', fmt((newZ - startZ) / unit));
      else code = replaceWord(code, 'Z', fmt(feature.zAbs ? newZ / unit : (newZ - startZ) / unit));
    }

    if (changes.radius !== undefined && feature.type === 'arc') {
      const big = Geometry.arcSweep(feature) > Math.PI + 1e-4;
      const R = Math.abs(changes.radius) / unit;
      const signed = (big ? -R : R);
      code = stripWords(code, ['I', 'K']);
      code = replaceWord(code, 'R', fmt(signed));
    }

    if (changes.cw !== undefined && feature.type === 'arc') {
      const target = changes.cw ? 'G02' : 'G03';
      if (new RegExp('G0?2\\b').test(code) || new RegExp('G0?3\\b').test(code)) {
        code = code.replace(/G0?2\b/g, target).replace(/G0?3\b/g, target);
      } else {
        code = target + ' ' + code;
      }
    }

    lines[idx] = code.replace(/\s+$/, '') + parts.tail;
    return lines.join('\n');
  }

  /** 读取某程序段的实时文本块，便于定位 */
  function featureLineText(program, feature) {
    const lines = program.replace(/\r/g, '').split('\n');
    return lines[feature.blockIndex] || '';
  }

  global.ProgramParser = {
    parse: parse,
    applyFeatureEdit: applyFeatureEdit,
    featureLineText: featureLineText,
    fmt: fmt
  };
})(window);
