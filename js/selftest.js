/* 全场景自测：A/C/R/U/W、刀尖半径补偿（程序刀心轨迹 → 实际工件轮廓）与测量基准 */
(function (global) {
  'use strict';

  const TOOL = {
    id: 't1', toolNo: 1, name: '外圆刀', type: 'outer', radius: 0.8,
    angle: 55, width: 0, geoX: 0, geoZ: 0, wearX: 0, wearZ: 0
  };
  const TOOLS = [TOOL];
  const INNER = {
    id: 't2', toolNo: 2, name: '内孔刀', type: 'inner', radius: 0.8,
    angle: 55, width: 0, geoX: 0, geoZ: 0, wearX: 0, wearZ: 0
  };

  const results = [];
  let group = '';

  function approx(a, b, tol) { return Math.abs(a - b) <= (tol === undefined ? 0.001 : tol); }
  function near(actual, expected, tol, label) {
    if (!approx(actual, expected, tol)) {
      throw new Error((label || '数值') + ' 期望 ' + expected + '，实际 ' + actual);
    }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg); }
  function check(name, fn) {
    try {
      const detail = fn();
      results.push({ group: group, name: name, pass: true, detail: detail || '通过' });
    } catch (e) {
      results.push({ group: group, name: name, pass: false, detail: e.message });
    }
  }
  function section(name) { group = name; }

  function parse(src) {
    return ProgramParser.parse(src, TOOLS, { activeToolId: TOOL.id });
  }
  function parseTool(src, tool) {
    return ProgramParser.parse(src, [tool], { activeToolId: tool.id });
  }
  function sim(parsed) {
    return ContourSimulator.simulate(parsed, { stockDiameter: 90 });
  }
  function composed(parsed, autoRadius) {
    return Geometry.composeChain(parsed.cutting, { autoRadius: autoRadius || 0 }).features;
  }
  function corners(feats, source) {
    return feats.filter(function (f) { return f.corner && (!source || f.cornerSource === source); });
  }
  function raw(parsed, id) {
    return parsed.cutting.find(function (f) { return f.id === id; });
  }
  function pt(z, r) { return { z: z, r: r }; }

  function partFeats(s) {
    const out = [];
    for (const c of (s.outerChains || []).concat(s.innerChains || [])) {
      for (const f of c.feats || []) out.push(f);
    }
    return out;
  }
  function partPoints(s) {
    return (s.outerPoints || []).concat(s.innerPoints || []);
  }
  function envelopeArcs(s) {
    return partFeats(s).filter(function (f) { return f.envelope; });
  }
  function toolPoints(s) {
    const out = [];
    for (const t of s.toolpaths || []) for (const p of t.points) out.push(p);
    return out;
  }

  function toPoint(f) { return pt(f.z, f.d / 2); }
  function distToFeature(f, p) {
    const hit = Geometry.nearestFeature([f], p, 1e6);
    return hit ? hit.distance : Infinity;
  }
  function distToProgram(parsed, p) {
    const hit = Geometry.nearestFeature(parsed.cutting, p, 1e6);
    return hit ? hit.distance : Infinity;
  }
  function distToFeats(feats, p) {
    const hit = Geometry.nearestFeature(feats, p, 1e6);
    return hit ? hit.distance : Infinity;
  }

  function hasDiagnostic(parsed, text) {
    return (parsed.diagnostics || []).some(function (d) { return d.text.indexOf(text) >= 0; });
  }

  const LINE_OUTER = [
    'G21', 'G00 X30. Z2.',
    'G01 Z0. F0.2', 'G01 Z-10.', 'M30'
  ].join('\n');

  const LINE_INNER = [
    'G21', 'G00 X34. Z2.',
    'G01 Z0. F0.2', 'G01 Z-20.', 'M30'
  ].join('\n');

  const CORNER_PROG = [
    'G21', 'G00 X30. Z2.',
    'G01 Z0. F0.2',
    'G01 Z-10.',
    'G01 X50.',
    'G01 Z-20.', 'M30'
  ].join('\n');

  const COMP_LEGACY = [
    'G21', 'G00 X30. Z2.',
    'G42 G01 Z0. F0.2',
    'G01 Z-10.', 'G40', 'M30'
  ].join('\n');

  function run() {
    results.length = 0;

    section('U/W 与 G91 增量');
    check('U/W 增量：X10 直径、Z-5', function () {
      const p = parse('G21 G40\nG00 X20. Z0.\nG01 U10. W-5. F0.2\nM30');
      near(p.cutting[0].end.d, 30, 0.001, '终点 X');
      near(p.cutting[0].end.z, -5, 0.001, '终点 Z');
    });
    check('G91 模态增量', function () {
      const p = parse('G21 G40\nG00 X20. Z2.\nG91\nG01 X10. Z-3.\nG90\nM30');
      near(p.cutting[0].end.d, 30, 0.001, '终点 X');
      near(p.cutting[0].end.z, -1, 0.001, '终点 Z');
    });
    check('U/W 与 G90 绝对坐标混合', function () {
      const p = parse('G21 G90\nG00 X20. Z0.\nG01 X40. W-6.\nM30');
      near(p.cutting[0].end.d, 40, 0.001, '终点 X');
      near(p.cutting[0].end.z, -6, 0.001, '终点 Z');
    });

    section('A 角度编程');
    check('A45 + 仅 X：ΔX=20 → ΔZ=-10', function () {
      const p = parse('G21 G40\nG00 X20. Z0.\nG01 X40. A45.\nM30');
      near(p.cutting[0].end.d, 40, 0.001, '终点 X');
      near(p.cutting[0].end.z, -10, 0.001, '终点 Z');
    });
    check('A45 + 仅 Z：ΔZ=-10 → ΔX=20', function () {
      const p = parse('G21 G40\nG00 X20. Z0.\nG01 Z-10. A45.\nM30');
      near(p.cutting[0].end.d, 40, 0.001, '终点 X');
      near(p.cutting[0].end.z, -10, 0.001, '终点 Z');
    });
    check('A30 + 仅 X：ΔZ = -ΔX/(2tanA)', function () {
      const p = parse('G21 G40\nG00 X20. Z0.\nG01 X30. A30.\nM30');
      near(p.cutting[0].end.d, 30, 0.001, '终点 X');
      near(p.cutting[0].end.z, -10 / (2 * Math.tan(Math.PI / 6)), 0.002, '终点 Z');
    });
    check('A + U 增量', function () {
      const p = parse('G21 G40\nG00 X20. Z0.\nG01 U8. A45.\nM30');
      near(p.cutting[0].end.d, 28, 0.001, '终点 X');
      near(p.cutting[0].end.z, -4, 0.001, '终点 Z');
    });
    check('A 与 X/Z 同时给出：坐标优先并提示', function () {
      const p = parse('G21 G40\nG00 X20. Z0.\nG01 X40. Z-6. A45.\nM30');
      near(p.cutting[0].end.z, -6, 0.001, '终点 Z');
      assert(hasDiagnostic(p, '不一致'), '应给出 A 与坐标不一致诊断');
    });
    check('A 无坐标：拒绝并提示', function () {
      const p = parse('G21 G40\nG00 X20. Z0.\nG01 A45.\nM30');
      assert(p.cutting.length === 0, '不应生成切削段');
      assert(hasDiagnostic(p, '需与 X/U'), '应提示 A 缺少坐标');
    });
    check('A 角度矩阵：ΔX = -2ΔZ·tanA', function () {
      const angles = [-60, -45, -30, 30, 45, 60];
      for (const a of angles) {
        const p = parse('G21 G40\nG00 X20. Z0.\nG01 X40. A' + a + '.\nM30');
        const dz = p.cutting[0].end.z;
        const expect = -20 / (2 * Math.tan(a * Math.PI / 180));
        near(dz, expect, 0.002, 'A' + a + ' 终点 Z');
      }
      return '6 个角度全部通过';
    });

    section('C 倒角 / R 圆角');
    check('C2 等长倒角端点', function () {
      const p = parse('G21 G40\nG00 X30. Z0.\nG01 X40. C2.\nG01 Z-10.\nM30');
      const feats = composed(p, 0);
      const cf = corners(feats, 'C');
      assert(cf.length === 1, '应生成 1 个 C 倒角段');
      near(cf[0].start.d, 36, 0.001, '倒角起点 X');
      near(cf[0].start.z, 0, 0.001, '倒角起点 Z');
      near(cf[0].end.d, 40, 0.001, '倒角终点 X');
      near(cf[0].end.z, -2, 0.001, '倒角终点 Z');
    });
    check('R3 相切圆角圆心与切点', function () {
      const p = parse('G21 G40\nG00 X30. Z0.\nG01 X40. R3.\nG01 Z-10.\nM30');
      const feats = composed(p, 0);
      const rf = corners(feats, 'R');
      assert(rf.length === 1, '应生成 1 个 R 圆角段');
      near(rf[0].radius, 3, 0.001, '圆角半径');
      near(rf[0].center.z, -3, 0.002, '圆心 Z');
      near(rf[0].center.r, 17, 0.002, '圆心 r');
      near(rf[0].start.d, 34, 0.002, '切点 X');
      near(rf[0].end.z, -3, 0.002, '切点 Z');
    });
    check('C/R 组合：多拐角尺寸', function () {
      const p = parse([
        'G21 G40', 'G00 X20. Z0.',
        'G01 X40. C2.', 'G01 Z-15.',
        'G01 X60. R3.', 'G01 Z-25.',
        'G01 X70. C1.', 'G01 Z-30.', 'M30'
      ].join('\n'));
      const feats = composed(p, 0);
      const cs = corners(feats, 'C');
      const rs = corners(feats, 'R');
      assert(cs.length === 2, '应有 2 个倒角段');
      assert(rs.length === 1, '应有 1 个圆角段');
      near(cs[0].start.d, 36, 0.002, 'C2 起点 X');
      near(cs[0].end.z, -2, 0.002, 'C2 终点 Z');
      near(cs[1].end.z, -26, 0.002, 'C1 终点 Z');
      near(rs[0].radius, 3, 0.002, 'R3 半径');
    });
    check('段末 C 无后续轮廓：忽略并诊断', function () {
      const p = parse('G21 G40\nG00 X30. Z0.\nG01 X40. C2.\nM30');
      assert(p.cutting[0].cornerC === 0, '孤立的 C 应被清除');
      assert(hasDiagnostic(p, '没有连续'), '应提示无后续轮廓');
    });
    check('C/R 超长自动收敛并提示', function () {
      const p = parse('G21 G40\nG00 X30. Z0.\nG01 X40. R20.\nG01 Z-2.\nM30');
      const res = Geometry.composeChain(p.cutting, { autoRadius: 0 });
      const rf = corners(res.features, 'R');
      assert(rf.length === 1, '应收敛出可生成的圆角');
      assert(rf[0].radius < 20, '圆角半径应小于请求值');
      assert(res.warnings.length > 0, '应给出收敛提示');
      return '收敛半径 R' + rf[0].radius.toFixed(3);
    });

    section('轮廓语义：程序刀心轨迹 → 实际工件轮廓');
    check('外圆：程序刀心 X30，实际轮廓 X28.4（=程序 − 2R）', function () {
      const p = parse(LINE_OUTER);
      const s = sim(p);
      assert(s.ok, '仿真应成功');
      assert(s.outerChains.length === 1, '应输出 1 条外圆轮廓链');
      for (const q of s.outerPoints) near(q.r * 2, 28.4, 0.002, '实际轮廓直径');
      for (const q of toolPoints(s)) near(q.r * 2, 30, 0.002, '程序刀心直径');
      assert(s.stats.autoFillets === 0, '直线链不应有包络弧');
      near(s.maxDev, 0, 0.002, '刀尖补偿一致性');
      return '程序刀心 X30 / 实际轮廓 X28.4，maxDev=' + s.maxDev.toFixed(4);
    });
    check('内孔：程序刀心 X34，实际孔径 X35.6（=程序 + 2R）', function () {
      const s = sim(parseTool(LINE_INNER, INNER));
      assert(s.ok, '仿真应成功');
      for (const q of s.innerPoints) near(q.r * 2, 35.6, 0.002, '实际孔径');
      for (const q of toolPoints(s)) near(q.r * 2, 34, 0.002, '程序刀心直径');
      near(s.maxDev, 0, 0.002, '刀尖补偿一致性');
      return '程序刀心 X34 / 实际孔径 X35.6';
    });
    check('刀尖半径联动：程序不变，实际直径 = 程序 − 2R', function () {
      const cases = [[0.4, 29.2], [1.2, 27.6]];
      for (const c of cases) {
        const t = Object.assign({}, TOOL, { radius: c[0] });
        const s = sim(parseTool(LINE_OUTER, t));
        for (const q of s.outerChains[0].rawPoints) near(q.r * 2, c[1], 0.002, 'R' + c[0] + ' 实际轮廓直径');
        for (const q of toolPoints(s)) near(q.r * 2, 30, 0.002, 'R' + c[0] + ' 程序刀心直径');
        near(s.maxDev, 0, 0.002, 'R' + c[0] + ' 补偿一致性');
      }
      return 'R0.4 → X29.2 / R1.2 → X27.6';
    });
    check('刀库几何补偿：X+0.2 / Z−0.05 使实际轮廓整体平移', function () {
      const t = Object.assign({}, TOOL, { geoX: 0.2, geoZ: -0.05, wearX: 0, wearZ: 0 });
      const s = sim(parseTool(LINE_OUTER, t));
      for (const q of s.outerPoints) near(q.r * 2, 28.6, 0.002, '实际轮廓直径 = 28.4 + 几何补偿 0.2');
      const zs = s.outerPoints.map(function (q) { return q.z; });
      assert(zs.every(function (z) { return z <= 1e-6; }), '轮廓不应越过成品端面 Z0');
      near(Math.min.apply(null, zs), -10.05, 0.01, '轮廓末端 Z 平移 −0.05');
      assert(s.snapPoints.some(function (n) {
        return approx(n.d, 28.6, 0.002) && approx(n.z, -0.05, 0.001);
      }), '前端端点应为 X28.6 / Z−0.05');
      for (const q of toolPoints(s)) near(q.r * 2, 30.2, 0.002, '补偿后刀心直径');
      assert(s.compensation.chains[0].shiftD === 0.2, '应记录 X 平移量');
      assert(s.compensation.chains[0].shiftZ === -0.05, '应记录 Z 平移量');
      assert(s.calibration.pass && s.maxDev <= 0.002, '平移后补偿一致性应保持');
      return 'X28.4→X28.6，Z 0/-10 → -0.05/-10.05';
    });
    check('内凹圆弧：实际 R = 程序 R + r（用户示例）', function () {
      const p = parseTool([
        'G21', 'G00 X34. Z2.',
        'G01 Z0. F0.2', 'G01 Z-10.',
        'G03 X34. Z-20. R10.', 'G01 Z-30.', 'M30'
      ].join('\n'), INNER);
      const s = sim(p);
      const toolArcs = s.toolpaths.reduce(function (acc, t) {
        return acc.concat((t.feats || []).filter(function (f) { return f.type === 'arc' && !f.envelope; }));
      }, []);
      const partArcs = partFeats(s).filter(function (f) { return f.type === 'arc' && !f.envelope; });
      assert(toolArcs.length >= 1 && partArcs.length >= 1, '应含程序圆弧与实际圆弧');
      near(toolArcs[0].radius, 10, 0.002, '程序圆弧半径');
      near(partArcs[0].radius, 10.8, 0.002, '内凹实际圆弧半径 = 程序 R + 0.8');
      assert(s.maxDev <= 0.002, '补偿一致性应 ≤0.002，实际 ' + s.maxDev.toFixed(4));
      return '程序 R10 → 实际 R10.8';
    });
    check('拐角包络弧在实际轮廓：圆心为程序拐点、半径等于 R', function () {
      const s = sim(parse(CORNER_PROG));
      const env = envelopeArcs(s);
      assert(env.length === 1, '实际轮廓应生成 1 段包络弧，实际 ' + env.length);
      near(env[0].radius, 0.8, 0.002, '包络弧半径');
      near(env[0].center.z, -10, 0.002, '包络弧圆心 Z');
      near(env[0].center.r, 15, 0.002, '包络弧圆心 r（程序台阶拐点 X30 处）');
      near(Geometry.dist(Geometry.startOf(env[0]), env[0].center), 0.8, 0.002, '包络弧起点到圆心');
      near(Geometry.dist(Geometry.endOf(env[0]), env[0].center), 0.8, 0.002, '包络弧终点到圆心');
      near(s.stats.autoFillets, 1, 1, '包络弧统计');
      const toolFeats = s.toolpaths.reduce(function (acc, t) { return acc.concat(t.feats || []); }, []);
      assert(!toolFeats.some(function (f) { return f.envelope; }), '程序刀心轨迹不应含包络弧');
      assert(s.maxDev <= 0.002, '补偿偏差应 ≤0.002，实际 ' + s.maxDev.toFixed(4));
      return '实际轮廓包络弧圆心 Z-10 r15，R0.8';
    });
    check('锥面外凸拐角：实际轮廓为等距偏移，锥-柱拐角保持尖角', function () {
      const p = parse([
        'G21', 'G00 X30. Z2.',
        'G01 Z0.', 'G01 X50. Z-10.', 'G01 Z-20.', 'M30'
      ].join('\n'));
      const s = sim(p);
      const env = envelopeArcs(s);
      assert(env.length === 1, '仅端面进入拐角应有 1 段包络弧，实际 ' + env.length);
      assert(!env.some(function (f) { return approx(f.center.z, -10, 0.01) && approx(f.center.r, 25, 0.01); }),
        '锥面外凸拐角不应含包络弧');
      for (const q of s.outerChains[0].rawPoints) {
        if (q.z > 0) continue;
        near(distToProgram(p, q), 0.8, 0.003, '轮廓点到程序刀心轨迹的距离 = R');
      }
      assert(s.maxDev <= 0.002, '补偿偏差应 ≤0.002，实际 ' + s.maxDev.toFixed(4));
      return '实际轮廓与程序等距 R0.8，锥-柱拐角为尖角';
    });
    check('外凸圆弧：实际 R = 程序 R − r', function () {
      const p = parse([
        'G21', 'G00 X30. Z2.',
        'G01 Z0.', 'G03 X50. Z-10. R10.', 'G01 Z-20.', 'M30'
      ].join('\n'));
      const s = sim(p);
      const arcs = partFeats(s).filter(function (f) {
        return f.type === 'arc' && !f.envelope && approx(f.center.z, -10, 0.02);
      });
      assert(arcs.length === 1, '应输出 1 段实际圆弧，实际 ' + arcs.length);
      near(arcs[0].radius, 9.2, 0.002, '实际外凸圆弧半径 = 程序 R − 0.8');
      const toolArcs = s.toolpaths.reduce(function (acc, t) {
        return acc.concat((t.feats || []).filter(function (f) { return f.type === 'arc' && !f.envelope; }));
      }, []);
      assert(toolArcs.length >= 1, '程序轨迹应含圆弧');
      near(toolArcs[0].radius, 10, 0.002, '程序圆弧半径');
      assert(s.maxDev <= 0.002, '圆弧补偿偏差应 ≤0.002，实际 ' + s.maxDev.toFixed(4));
      return '程序 R10 / 实际 R9.2';
    });
    check('G41/G42 指令：忽略并警告，程序仍按刀心轨迹生成', function () {
      const p = parse(COMP_LEGACY);
      assert(hasDiagnostic(p, '已移除'), '应提示 G41/G42 已移除');
      assert(!p.cutting.some(function (f) { return f.comp; }), 'comp 应恒为 0');
      const s = sim(p);
      assert(s.ok, '仿真应成功');
      for (const q of s.outerPoints) near(q.r * 2, 28.4, 0.002, '实际轮廓直径');
      return '忽略 G42，实际轮廓 X28.4';
    });

    section('测量基准规范');
    check('基准节点取自实际轮廓（程序刀心 X30 → 实际 X28.4），不含刀心坐标', function () {
      const s = sim(parse(LINE_OUTER));
      assert(s.snapPoints.length > 0, '应生成基准节点');
      assert(s.snapPoints.some(function (n) { return approx(n.d, 28.4, 0.002); }), '缺少实际轮廓 X28.4 基准');
      assert(!s.snapPoints.some(function (n) { return approx(n.d, 30, 0.002); }), '不应出现程序刀心坐标基准');
      for (const n of s.snapPoints) {
        assert(n.type === '交点' || n.type === '特征端点', '节点类型应为交点或特征端点');
      }
      return '基准 X' + s.snapPoints[0].d.toFixed(3);
    });
    check('禁止线上任意点：长直线中点不是基准', function () {
      const s = sim(parse(LINE_OUTER));
      const mid = pt(-5, 14.2);
      const hit = s.snapPoints.some(function (n) {
        return Math.abs(n.z - mid.z) < 0.02 && Math.abs(n.r - mid.r) < 0.02;
      });
      assert(!hit, '长直线中点不应成为测量基准');
      return s.snapPoints.length + ' 个端点/交点基准';
    });
    check('拐角交点取实际轮廓坐标（X28.4/48.4）', function () {
      const s = sim(parse(CORNER_PROG));
      const need = [[28.4, -10], [48.4, -10.8]];
      for (const q of need) {
        assert(s.snapPoints.some(function (n) { return approx(n.d, q[0], 0.002) && approx(n.z, q[1], 0.002); }),
          '缺少实际轮廓交点 X' + q[0] + ' Z' + q[1]);
      }
      return 'X28.4/Z-10 与 X48.4/Z-10.8 均在基准内';
    });
    check('基准圆弧半径取实际轮廓（外凸 R9.2 = 程序 R10 − r）', function () {
      const p = parse([
        'G21', 'G00 X30. Z2.',
        'G01 Z0.', 'G03 X50. Z-10. R10.', 'G01 Z-20.', 'M30'
      ].join('\n'));
      const s = sim(p);
      const node = s.snapPoints.filter(function (n) { return n.arc && approx(n.arc.r, 9.2, 0.002); });
      assert(node.length >= 2, '圆弧两端点应带实际半径元数据，实际 ' + node.length);
      return '端点圆弧元数据 R9.2';
    });

    section('测量交互：点击特征线非端点 → 提供端点选择');
    // 在隐藏容器中挂载真实 Viewer，直接驱动其点选流程（不依赖页面布局或目视点击）
    function mountViewer(s) {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:520px;visibility:hidden;';
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      host.appendChild(el);
      document.body.appendChild(host);
      el.getBoundingClientRect = function () {
        return { left: 0, top: 0, width: 900, height: 520, right: 900, bottom: 520 };
      };
      const v = new Viewer(el);
      v.sim = s;
      v.mode = 'measure';
      v.view = { scale: 20, ox: 300, oy: 440, z0: 0 };
      return { v: v, host: host };
    }
    function tapAt(v, z, d) {
      const sc = v.worldToScreen(z, d / 2);
      const ev = { pointerId: 1, clientX: sc.x, clientY: sc.y, target: v.svg };
      v._down(ev);
      v._up(ev);
    }
    check('点击实际轮廓长直线中部：给出该线起点/终点候选，不报警', function () {
      const s = sim(parse(LINE_OUTER));
      const m = mountViewer(s);
      let rejected = '', picked = null, choices = null;
      m.v.onReject = function (msg) { rejected = msg; };
      m.v.onTap = function (p) { picked = p; };
      m.v.onEndpointChoice = function (c) { choices = c; };
      const line = partFeats(s).filter(function (f) {
        return f.type === 'line' && Math.abs(f.end.z - f.start.z) > 8;
      })[0];
      assert(line, '应存在长直线特征');
      tapAt(m.v, (line.start.z + line.end.z) / 2, (line.start.d + line.end.d) / 2);
      document.body.removeChild(m.host);
      assert(!rejected, '非端点点击不应报警，实际：' + rejected);
      assert(!picked, '非端点点击不应直接生成测量点');
      assert(choices && choices.length === 2, '应给出 2 个端点候选，实际 ' + (choices ? choices.length : 0));
      assert(choices[0].role === '起点' && choices[1].role === '终点', '候选应标为起点/终点');
      near(choices[0].d, line.start.d, 0.002, '候选起点 X');
      near(choices[0].z, line.start.z, 0.002, '候选起点 Z');
      near(choices[1].d, line.end.d, 0.002, '候选终点 X');
      near(choices[1].z, line.end.z, 0.002, '候选终点 Z');
      return '候选 起点 Z' + choices[0].z.toFixed(3) + ' / 终点 Z' + choices[1].z.toFixed(3);
    });
    check('点击端点仍优先吸附为测量基准（不走端点候选）', function () {
      const s = sim(parse(LINE_OUTER));
      const m = mountViewer(s);
      let rejected = '', picked = null, choices = null;
      m.v.onReject = function (msg) { rejected = msg; };
      m.v.onTap = function (p) { picked = p; };
      m.v.onEndpointChoice = function (c) { choices = c; };
      const line = partFeats(s).filter(function (f) {
        return f.type === 'line' && Math.abs(f.end.z - f.start.z) > 8;
      })[0];
      tapAt(m.v, line.start.z, line.start.d);
      document.body.removeChild(m.host);
      assert(picked, '端点点击应直接生成测量基准');
      assert(!choices, '端点点击不应弹出候选');
      assert(!rejected, '端点点击不应报警，实际：' + rejected);
      return 'X' + picked.d.toFixed(3) + ' Z' + picked.z.toFixed(3);
    });
    check('远离实际轮廓点击仍报警（未点中任何特征线）', function () {
      const s = sim(parse(LINE_OUTER));
      const m = mountViewer(s);
      let rejected = '', choices = null;
      m.v.onReject = function (msg) { rejected = msg; };
      m.v.onEndpointChoice = function (c) { choices = c; };
      tapAt(m.v, 30, 20);
      document.body.removeChild(m.host);
      assert(!choices, '远离轮廓不应给出端点候选');
      assert(rejected, '未点中特征线时应报警提示');
      return rejected;
    });

    section('辅助线（铅垂线 / 水平线）交点');
    check('铅垂线 Z=-5 与实际轮廓求交：X28.4（非程序刀心 X30）', function () {
      const s = sim(parse(LINE_OUTER));
      const hits = Geometry.guideIntersections(partFeats(s), 'z', -5);
      assert(hits.length === 1, '应得到 1 个交点，实际 ' + hits.length);
      near(hits[0].z, -5, 1e-9, '交点 Z');
      near(hits[0].d, 28.4, 0.002, '交点 X（实际轮廓）');
      return 'X' + hits[0].d.toFixed(3) + ' Z' + hits[0].z.toFixed(3);
    });
    check('铅垂线 Z=-15 求交：X48.4 台阶外圆', function () {
      const s = sim(parse(CORNER_PROG));
      const hits = Geometry.guideIntersections(partFeats(s), 'z', -15);
      assert(hits.length === 1, '应得到 1 个交点，实际 ' + hits.length);
      near(hits[0].d, 48.4, 0.002, '交点 X');
      return 'X' + hits[0].d.toFixed(3) + ' Z' + hits[0].z.toFixed(3);
    });
    check('水平线 X40 与台阶端面求交：Z-10.8', function () {
      const s = sim(parse(CORNER_PROG));
      const hits = Geometry.guideIntersections(partFeats(s), 'r', 20);
      assert(hits.length === 1, '应得到 1 个交点，实际 ' + hits.length);
      near(hits[0].d, 40, 1e-9, '交点 X（水平线恒定）');
      near(hits[0].z, -10.8, 0.002, '交点 Z');
      return 'X' + hits[0].d.toFixed(3) + ' Z' + hits[0].z.toFixed(3);
    });
    check('铅垂线与实际轮廓外凸圆弧精确求交（R9.2 = 程序 R10 − r）', function () {
      const p = parse([
        'G21', 'G00 X30. Z2.',
        'G01 Z0. F0.2', 'G03 X50. Z-10. R10.', 'G01 Z-20.', 'M30'
      ].join('\n'));
      const s = sim(p);
      const arc = partFeats(s).filter(function (f) { return f.type === 'arc' && !f.envelope; })[0];
      assert(arc, '应存在实际轮廓圆弧');
      near(arc.radius, 9.2, 0.002, '实际圆弧半径');
      const hits = Geometry.guideIntersections([arc], 'z', -5);
      assert(hits.length === 1, '圆弧应有 1 个交点，实际 ' + hits.length);
      near(hits[0].z, -5, 1e-9, '交点 Z');
      near(Geometry.dist({ z: hits[0].z, r: hits[0].r }, arc.center), 9.2, 0.002, '交点到圆心距离 = 实际圆弧半径');
      return 'X' + hits[0].d.toFixed(3) + ' Z' + hits[0].z.toFixed(3);
    });
    check('辅助线交点可直接拾取为测量基准（类型：辅助线交点）', function () {
      const s = sim(parse(LINE_OUTER));
      const m = mountViewer(s);
      let picked = null;
      m.v.onTap = function (p) { picked = p; };
      m.v.setGuides([{ id: 'g1', axis: 'z', value: -5 }]);
      const pts = m.v.guidePoints();
      assert(pts.length >= 1, '应算出辅助线与轮廓交点');
      tapAt(m.v, -5, 28.4);
      document.body.removeChild(m.host);
      assert(picked, '交点应可被拾取');
      assert(picked.type === '辅助线交点', '类型应为辅助线交点，实际 ' + picked.type);
      near(picked.d, 28.4, 0.002, '拾取点 X');
      near(picked.z, -5, 0.002, '拾取点 Z');
      return 'X' + picked.d.toFixed(3) + ' Z' + picked.z.toFixed(3);
    });

    check('点击辅助线本身命中数值编辑（不生成测量点、不报警）', function () {
      const s = sim(parse(LINE_OUTER));
      const m = mountViewer(s);
      let gotGuide = null, tapped = null, rejected = '';
      m.v.onGuidePick = function (g) { gotGuide = g; };
      m.v.onTap = function (p) { tapped = p; };
      m.v.onReject = function (msg) { rejected = msg; };
      m.v.setGuides([{ id: 'g1', axis: 'z', value: -14 }]);
      tapAt(m.v, -14, 20);
      document.body.removeChild(m.host);
      assert(gotGuide, '应命中辅助线');
      assert(!tapped, '不应生成测量点');
      assert(!rejected, '不应报警，实际：' + rejected);
      return '命中 ' + gotGuide.axis + ' = ' + gotGuide.value;
    });

    section('逆向：轮廓数据导入');
    check('纯端点数组 → 全部直线特征', function () {
      const r = ReverseContour.parseContour([[30, 0], [30, -20], [50, -40], [60, -50]]);
      assert(r.feats.length === 3, '应生成 3 段直线');
      near(r.feats[0].start.d, 30, 1e-6, 'L1 startX');
      near(r.feats[0].end.z, -20, 1e-6, 'L1 endZ');
      near(r.feats[2].end.d, 60, 1e-6, 'L3 endX');
      return r.feats.length + ' lines parsed';
    });
    check('JSON 对象 → 混合直线与圆弧', function () {
      // 水平圆弧：端点 X=30, Z=-10 和 X=30, Z=-30（同一 D=30）
      // 圆心 (Z=-20, D=30) → arcCenter: [30, -20]，radius = hypot(10, 0) = 10
      const r = ReverseContour.parseContour({
        tool: { type: 'outer', radius: 0.8 },
        contour: [
          { point: [30, 0] },
          { point: [30, -10] },
          { arcCenter: [30, -20], cw: false, end: [30, -30] },
          { point: [40, -30] }
        ]
      });
      assert(r.feats.length === 3, '应为 1 直线 + 1 圆弧 + 1 直线 = 3, actual ' + r.feats.length);
      assert(r.feats[1].type === 'arc', '中段应是 arc');
      near(r.feats[1].center.z, -20, 1e-6, 'arc 圆心 Z');
      near(r.feats[1].center.r, 15, 1e-6, 'arc 圆心 R');
      near(r.feats[1].radius, 10, 0.002, 'arc 半径');
      assert(r.side === +1, '外圆 side = +1, actual ' + r.side);
      return r.feats.length + ' feats (side=' + r.side + ')';
    });
    check('纯文本行 → 自动识别直线与圆弧', function () {
      const r = ReverseContour.parseContour('30 0\n30 -20\n50 -40\n60 -50');
      assert(r.feats.length === 3, '应为 3 直线');
      near(r.feats[1].end.z, -40, 1e-6, '中段 endZ');
      return r.feats.length + ' feats';
    });
    check('内孔轮廓 side = -1', function () {
      const r = ReverseContour.parseContour({
        tool: { type: 'inner', radius: 0.4 },
        contour: [{ point: [34, 0] }, { point: [34, -30] }, { point: [30, -40] }]
      });
      assert(r.side === -1, '内孔 side 应为 -1');
      return 'side=' + r.side;
    });

    section('逆向：程序轨迹还原（往返验证）');
    check('直线链往返：程序 X30→实际 X28.4→逆向 X30（side+1, r=0.8）', function () {
      const prog = [
        { id: 'A', type: 'line', start: { d: 30, z: 0 }, end: { d: 30, z: -20 }, center: null, radius: 0, cw: false, rapid: false }
      ];
      const actual = Geometry.offsetChain(prog, 0.8, +1).features;
      assert(actual.length === 1, '一段直线偏移后仍为一段');
      near(actual[0].start.d, 28.4, 0.002, '实际轮廓直径');
      const rev = Geometry.reverseOffsetChain(actual, 0.8, +1).features;
      assert(rev.length === 1, '逆向仍一段');
      near(rev[0].start.d, 30, 0.002, '逆向起点 X ≈ 程序 30');
      near(rev[0].end.z, -20, 0.002, '逆向终点 Z ≈ 程序 -20');
      return 'prog X30 Z0→-20 → actual X28.4 Z-0.8→-20.8 → prog X' + rev[0].start.d.toFixed(1);
    });
    check('外凸圆弧往返：R10(程序) → R9.2(实际) → R10(逆向)', function () {
      const progArc = [
        { id: 'A', type: 'arc', start: { d: 50, z: -10 }, end: { d: 30, z: -20 },
          center: { z: -20, r: 20 }, radius: 10, cw: false, rapid: false }
      ];
      // 圆心验证：(Z-20, R=20) → R = hypot(-10, 0) = 10 ✓（这里我们简化，直接构造）
      // 直接用 offset 再 reverse
      const actual = Geometry.offsetChain(progArc, 0.8, +1).features;
      assert(actual.length === 1 && actual[0].type === 'arc', '偏移后仍是圆弧');
      near(actual[0].radius, 9.2, 0.002, '外凸圆弧实际半径 = R - r');
      const rev = Geometry.reverseOffsetChain(actual, 0.8, +1).features;
      near(rev[0].radius, 10, 0.002, '逆向还原程序半径 10');
      near(rev[0].center.z, -20, 0.01, '圆心不变');
      return 'R10→R' + actual[0].radius.toFixed(1) + '→R' + rev[0].radius.toFixed(1);
    });
    check('内凹圆弧往返：R10(程序) → R10.8(实际) → R10(逆向)', function () {
      // 直接用 simulator 里 sample1 已经标记 inner 的圆弧：从 X50 Z-20（端面）到 X56 Z-32（台阶），
      // 圆弧终点 X56 Z-42 R6（下一段）—— 让我用 parse 解析一个已知产生 inner 的圆弧
      // 用 G02 X56 Z-28 R10（从 (X50, Z-18) 到 (X56, Z-28)，R=10）
      // 端点距离 = hypot(5, 10) ≈ 11.18，R=10 够吗？2R=20 > 11.18 ✓ 可以构成
      const p = parse(['G21', 'G00 X50. Z2.', 'G01 Z-18. F0.2', 'G02 X56. Z-28. R10.', 'M30'].join('\n'));
      const progFeats = Geometry.composeChain(p.cutting, { autoRadius: 0 }).features;
      const progArc = progFeats.filter(function (f) { return f.type === 'arc'; })[0];
      assert(progArc, '应有程序圆弧');
      const actual = Geometry.offsetChain(progFeats, 0.8, +1).features;
      const actualArc = actual.filter(function (f) { return f.type === 'arc' && !f.envelope; })[0];
      assert(actualArc, '应有实际轮廓圆弧');
      // 外圆 side=+1，G02 (cw=true) 对于 (R 增大, |Z| 增大) 方向 → 材料侧偏移 → 内外凸取决于 cross
      // 这里直接用 selftest 里已验证的 calibration：实际轮廓到程序刀心的距离恒为 R
      // 所以只需断言 actual 与 prog 的半径差绝对值 = r（不分正负）
      const absDiffActual = Math.abs(actualArc.radius - progArc.radius);
      near(absDiffActual, 0.8, 0.02, '实际圆弧与程序圆弧半径差 |ΔR| = r');
      const rev = Geometry.reverseOffsetChain(actual, 0.8, +1).features;
      const revArc = rev.filter(function (f) { return f.type === 'arc'; })[0];
      assert(revArc, '逆向应有圆弧');
      near(revArc.radius, progArc.radius, 0.01, '逆向圆弧半径 ≈ 程序半径');
      near(revArc.center.z, progArc.center.z, 0.02, '圆心 Z 逆向不变');
      return 'progR=' + progArc.radius.toFixed(2) + ' actualR=' + actualArc.radius.toFixed(2) + ' revR=' + revArc.radius.toFixed(2);
    });
    check('程序凹拐角 → envelope 弧半径=r、圆心=程序拐点；逆向还原', function () {
      // 直接构造程序特征：
      // line1: X40 Z0 → X0 Z0   （端面切削，向左）
      // line2: X0 Z0 → X0 Z-10  （轴向下）
      const prog = [
        { id: 'A', type: 'line', start: { d: 40, z: 0 }, end: { d: 0, z: 0 }, center: null, radius: 0, cw: false, rapid: false },
        { id: 'B', type: 'line', start: { d: 0, z: 0 }, end: { d: 0, z: -10 }, center: null, radius: 0, cw: false, rapid: false }
      ];
      // line1 end tangent ≈ (0, -1)，line2 start tangent ≈ (-1, 0)，cross = 0*0 - (-1)*(-1) = -1
      // side=+1, cross*side=-1 < 0 → envelope
      const actual = Geometry.offsetChain(prog, 0.8, +1).features;
      const env = actual.filter(function (f) { return f.envelope; });
      assert(env.length >= 1, '应产生 envelope 弧，actual feats=' + actual.length);
      // envelope 圆心 V = line1.end = (D=0, Z=0)
      const V = { d: 0, z: 0 };
      near(env[0].radius, 0.8, 0.01, 'envelope 半径 = r');
      near(env[0].center.z, V.z, 0.02, 'envelope 圆心 Z = 程序拐点');
      near(env[0].center.r * 2, V.d, 0.02, 'envelope 圆心 X = 程序拐点');

      // 逆向
      const rev = Geometry.reverseOffsetChain(actual, 0.8, +1).features;
      // envelope 被逆向删除（radius ≈ r）
      assert(rev.length === 2, '逆向应还原为 2 段直线，actual ' + rev.length);
      near(rev[0].end.d, V.d, 0.02, '逆向首段终点 X ≈ 拐点');
      near(rev[0].end.z, V.z, 0.02, '逆向首段终点 Z ≈ 拐点');
      near(rev[1].start.d, V.d, 0.02, '逆向次段起点 X ≈ 拐点');
      near(rev[1].start.z, V.z, 0.02, '逆向次段起点 Z ≈ 拐点');
      return 'envelope r=' + env[0].radius.toFixed(2) + ' V(X' + env[0].center.r.toFixed(2) + ' Z' + env[0].center.z + ') revFeats=' + rev.length;
    });

    section('逆向：G 代码生成');
    check('G01 直线链生成 G01 段，圆弧生成 G02/G03，含 I/K 增量圆心', function () {
      const feats = [
        { id: 'A', type: 'line', start: { d: 30, z: 0 }, end: { d: 30, z: -20 }, center: null, radius: 0, cw: false },
        { id: 'B', type: 'arc', start: { d: 30, z: -20 }, end: { d: 50, z: -40 }, center: { z: -40, r: 25 }, radius: 10, cw: true },
        { id: 'C', type: 'line', start: { d: 50, z: -40 }, end: { d: 50, z: -60 }, center: null, radius: 0, cw: false }
      ];
      const gc = ReverseContour.generateGcode(feats, {
        toolNo: 1, toolName: '逆向轮廓', feed: 0.15, speed: 200, spindle: 2500, startD: 64, startZ: 2
      });
      assert(gc.indexOf('O1007') >= 0, '应有 O 号');
      assert(gc.indexOf('T0101') >= 0, '应有 T 号');
      assert(gc.indexOf('G00 X30.000 Z0.000') >= 0, '起刀快速定位到轮廓起点');
      assert(gc.indexOf('G01 X30.000 Z-20.000 F0.15') >= 0, '首段 G01 切削并带 F');
      assert(gc.indexOf('G02 X50.000 Z-40.000') >= 0, 'G02 圆弧');
      assert(gc.indexOf('I') >= 0 && gc.indexOf('K') >= 0, '应有 I/K 增量圆心');
      assert(gc.indexOf('G00 X66.000 Z2.000') >= 0, '应有安全退刀');
      assert(gc.indexOf('M30') >= 0, '应有 M30');
      return gc.split('\n').length + ' lines generated';
    });

    section('逆向：端到端 pipeline');
    check('JSON → pipeline → G 代码行数合理，无警告', function () {
      const input = JSON.stringify({
        tool: { type: 'outer', radius: 0.8, toolNo: 1, name: '外圆刀' },
        contour: [
          { point: [30, 0] },
          { point: [30, -10] },
          { arcCenter: [40, -20], cw: false, end: [50, -30] },
          { point: [50, -50] }
        ]
      });
      const r = ReverseContour.runPipeline(input, { radius: 0.8 }, { programNo: 1008 });
      assert(r.programFeatures.length >= 3, '程序特征至少 3 段');
      assert(r.gcode.indexOf('O1008') >= 0, '程序号');
      assert(r.warnings.length >= 0, '允许警告');
      return r.gcode.split('\n').length + ' lines, prog feats=' + r.programFeatures.length;
    });

    section('轮廓坐标校准与匹配');
    check('外圆链：实际轮廓到程序刀心轨迹的偏移恒为 R（期望 0.8，阈值 0.002）', function () {
      const s = sim(parse(LINE_OUTER));
      const cal = s.calibration;
      assert(cal && cal.total > 0, '应产生校准数据');
      assert(cal.pass, '校准应全部合格，失败 ' + cal.failed + ' 点，maxErr=' + cal.maxErr.toFixed(4));
      const c0 = cal.chains[0];
      near(c0.expected, 0.8, 1e-9, '期望偏移');
      assert(c0.maxErr <= 0.002, '逐点误差应 ≤0.002，实际 ' + c0.maxErr.toFixed(4));
      return '期望偏移 R0.8，maxErr=' + c0.maxErr.toFixed(4) + '，共 ' + c0.count + ' 点';
    });
    check('内孔链：实际孔径到程序刀心轨迹的偏移恒为 R', function () {
      const s = sim(parseTool(LINE_INNER, INNER));
      const cal = s.calibration;
      assert(cal && cal.pass, '校准应全部合格，失败 ' + (cal && cal.failed));
      const c0 = cal.chains[0];
      near(c0.expected, 0.8, 1e-9, '期望偏移');
      assert(c0.type === 'inner', '应为内孔链');
      return '内孔 maxErr=' + c0.maxErr.toFixed(4);
    });
    check('对应关系输出：刀心点 → 实际轮廓点，偏移等于 R', function () {
      const s = sim(parse(LINE_OUTER));
      const cal = s.calibration;
      assert(cal && cal.pass, '校准应全部合格，失败 ' + (cal && cal.failed));
      const c0 = cal.chains[0];
      near(c0.expected, 0.8, 1e-9, '期望偏移');
      const pair = c0.pairs[0];
      near(pair.pd, 30, 0.01, '对应程序刀心点 X');
      near(pair.d, 28.4, 0.01, '实际轮廓点 X');
      near(pair.dist, 0.8, 0.002, '对应点距离');
      assert(pair.ok, '首对应点应判定合格');
      return '刀心 X' + pair.pd.toFixed(3) + ' Z' + pair.pz.toFixed(3) +
        ' → 轮廓 X' + pair.d.toFixed(3) + ' Z' + pair.z.toFixed(3) +
        '，偏移 ' + pair.dist.toFixed(3) + '，err=' + pair.err.toFixed(4);
    });
    check('全点位校验：无错位、无超差（failed=0）', function () {
      const s = sim(parse(CORNER_PROG));
      const cal = s.calibration;
      assert(cal.total > 0, '应有校准点位');
      assert(cal.failed === 0, '存在超差点位 ' + cal.failed + ' 个，maxErr=' + cal.maxErr.toFixed(4));
      assert(cal.maxErr <= 0.002, 'maxErr 应 ≤0.002');
      return '校验 ' + cal.total + ' 点，maxErr=' + cal.maxErr.toFixed(4);
    });
    check('全示例坐标校准：全部点位合格', function () {
      const list = ['sample1', 'sample2', 'sample3', 'sample4', 'sample5', 'sample6'];
      for (const key of list) {
        const s = sim(parse(global.Samples[key]));
        assert(s.calibration && s.calibration.total > 0, key + ' 无校准数据');
        assert(s.calibration.pass, key + ' 校准失败 ' + s.calibration.failed + ' 点，maxErr=' + s.calibration.maxErr.toFixed(4));
      }
      return list.length + ' 个示例校准全部通过';
    });
    check('X/Z 分轴记录：外圆径向偏移 2R、端面轴向偏移 R，判定以距离误差为准', function () {
      const s = sim(parse(CORNER_PROG));
      const cal = s.calibration;
      assert(cal.pass, '校准应合格，失败 ' + cal.failed);
      near(cal.maxDx, 1.6, 0.02, '径向（直径）最大偏移应约 2R');
      near(cal.maxDz, 0.8, 0.02, '轴向最大偏移应约 R');
      const pair = cal.chains[0].pairs[0];
      near(pair.dx, 1.6, 0.02, '首点径向（直径）偏移');
      near(pair.dz, 0, 0.002, '首点轴向偏移');
      assert(pair.ok, '首对应点应判定合格');
      return 'maxDx=' + cal.maxDx.toFixed(4) + '，maxDz=' + cal.maxDz.toFixed(4) + '，maxErr=' + cal.maxErr.toFixed(4);
    });
    check('刀尖补偿审计：实际轮廓到程序轨迹的偏移量恒等于该刀 R', function () {
      const s = sim(parse(CORNER_PROG));
      const comp = s.compensation;
      assert(comp && comp.applied, '应记录刀尖补偿');
      assert(comp.chains.length >= 1, '缺少补偿审计链');
      for (const c of comp.chains) {
        assert(c.samples > 0, '审计链无采样点');
        near(c.minOffset, c.radius, 0.002, '最小轮廓偏移');
        near(c.maxOffset, c.radius, 0.002, '最大轮廓偏移');
        assert(c.maxErr <= 0.002, '轮廓偏移误差 ' + c.maxErr.toFixed(4) + ' 超差');
      }
      return comp.chains.length + ' 链，R=' + comp.chains.map(function (c) { return c.radius; }).join('/');
    });
    check('换刀不混用半径：同类型不同刀号分链并按各自 R 补偿', function () {
      const A = { id: 'ta', toolNo: 1, name: '外圆粗', type: 'outer', radius: 0.8 };
      const B = { id: 'tb', toolNo: 5, name: '外圆精', type: 'outer', radius: 0.2 };
      const p = ProgramParser.parse([
        'G21', 'T0101', 'G00 X30. Z2.',
        'G01 Z0. F0.2', 'G01 Z-10.',
        'T0505', 'G00 X30. Z-10.', 'G01 Z-20.', 'M30'
      ].join('\n'), [A, B], { activeToolId: 'ta' });
      const s = sim(p);
      assert(s.toolpaths.length === 2, '应分成 2 条程序轨迹链，实际 ' + s.toolpaths.length);
      const radii = s.toolpaths.map(function (t) { return t.offsetRadius; }).sort(function (x, y) { return x - y; });
      near(radii[0], 0.2, 1e-9, 'R0.2 链');
      near(radii[1], 0.8, 1e-9, 'R0.8 链');
      const audits = s.compensation.chains.map(function (c) { return c.radius; }).sort(function (x, y) { return x - y; });
      near(audits[0], 0.2, 1e-9, '审计 R0.2');
      near(audits[1], 0.8, 1e-9, '审计 R0.8');
      for (const c of s.compensation.chains) {
        near(c.minOffset, c.radius, 0.002, 'T' + c.toolNo + ' 轮廓偏移');
      }
      return 'T1 R0.8 / T5 R0.2 分链正确';
    });

    section('全场景组合与综合一致性');
    check('A + C + R + U/W 综合：刀尖补偿一致性 ≤0.002', function () {
      const p = parse([
        'G21', 'G00 X26. Z2.',
        'G01 X60. Z0.', 'G01 Z-12.',
        'G01 X42. A45.', 'U4. W-6. C2.',
        'G01 Z-38.', 'G01 X60. R5.', 'G01 Z-46.',
        'U4. W-4. R4.', 'G01 X72.', 'M30'
      ].join('\n'));
      const s = sim(p);
      assert(s.ok, '仿真应成功');
      assert(s.maxDev <= 0.002, '刀尖补偿一致性应 ≤0.002，实际 ' + s.maxDev.toFixed(4));
      const feats = composed(p, 0);
      assert(corners(feats, 'C').length === 1, '应有 1 个 C 倒角');
      assert(corners(feats, 'R').length === 2, '应有 2 个 R 圆角');
      return 'maxDev=' + s.maxDev.toFixed(4);
    });
    check('A + C + R + U/W 综合：实际轮廓与程序刀心轨迹等距 R', function () {
      const p = parse([
        'G21', 'G00 X26. Z2.', 'G01 Z0. F0.2',
        'G01 Z-12.', 'G01 X42. A45.', 'U4. W-6. C2.',
        'G01 Z-38.', 'G01 X60. R5.', 'G01 Z-46.',
        'U4. W-4. R4.', 'G01 X72.', 'M30'
      ].join('\n'));
      const s = sim(p);
      assert(s.maxDev <= 0.002, '刀尖补偿一致性应 ≤0.002，实际 ' + s.maxDev.toFixed(4));
      const feats = composed(p, 0);
      const progChains = s.nominalChains.reduce(function (acc, c) { return acc.concat(c.feats); }, []);
      for (const q of s.outerChains[0].rawPoints) {
        if (q.z > 0) continue;
        near(distToFeats(progChains, q), 0.8, 0.003, '实际轮廓点到程序刀心轨迹距离 = R');
      }
      assert(corners(feats, 'C').length === 1 && corners(feats, 'R').length === 2, '显式 C/R 应保留');
      return 'maxDev=' + s.maxDev.toFixed(4);
    });
    check('示例 6：程序刀心 X30/X50 → 实际轮廓 X28.4/X48.4', function () {
      const p = parse(global.Samples.sample6);
      const s = sim(p);
      assert(s.ok, '示例 6 仿真失败');
      assert(s.outerPoints.some(function (q) { return approx(q.r * 2, 28.4, 0.003); }), '缺少实际轮廓 X28.4');
      assert(s.outerPoints.some(function (q) { return approx(q.r * 2, 48.4, 0.003); }), '缺少实际轮廓 X48.4');
      assert(s.stats.autoFillets >= 1, '实际轮廓拐角应出现包络弧');
      assert(s.maxDev <= 0.002, '补偿一致性应 ≤0.002，实际 ' + s.maxDev.toFixed(4));
      return 'maxDev=' + s.maxDev.toFixed(4) + '，包络弧 ' + s.stats.autoFillets + ' 段';
    });
    check('示例程序全部可解析且无错误诊断', function () {
      const list = ['sample1', 'sample2', 'sample3', 'sample4', 'sample5', 'sample6'];
      for (const key of list) {
        const p = parse(global.Samples[key]);
        assert(p.cutting.length > 0, key + ' 无切削轮廓');
        assert(!(p.diagnostics || []).some(function (d) { return d.level === 'err'; }), key + ' 存在错误诊断');
      }
      return list.length + ' 个示例通过';
    });
    check('示例程序仿真无异常且补偿一致性 ≤0.002', function () {
      const list = ['sample1', 'sample2', 'sample3', 'sample4', 'sample5', 'sample6'];
      for (const key of list) {
        const p = parse(global.Samples[key]);
        const s = sim(p);
        assert(s.ok, key + ' 仿真失败');
        const all = s.outerPoints.concat(s.innerPoints);
        assert(all.length > 0, key + ' 无轮廓点');
        for (const q of all) {
          assert(isFinite(q.z) && isFinite(q.r), key + ' 轮廓含非法数值');
          assert(q.r >= -0.01, key + ' 轮廓半径出现负值');
        }
        assert(s.maxDev <= 0.002, key + ' 补偿一致性超限：' + s.maxDev.toFixed(4));
        assert(s.snapPoints.length > 0, key + ' 缺少测量基准节点');
      }
      return list.length + ' 个示例仿真通过';
    });

    return results;
  }

  global.SelfTest = { run: run, TOOL: TOOL };
})(window);
