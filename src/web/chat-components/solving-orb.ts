// Geometry adapted from thinking-orbs (MIT, Copyright 2026 Jakub Antalik).
// Shared by the boot screen and the small composer activity indicator.
export const SOLVING_ORB_JS = String.raw`
  var BOOT_ORB_PRESET = {
    speed: 1.82,
    count: 0.35,
    size: 1.05
  };
  var BOOT_ORB_BASE = {
    latRings: 15,
    lonDensity: 40,
    moveCount: 14,
    rBase: 0.6,
    rDepth: 1.7,
    rActive: 0.3,
    inkFar: 0.62,
    inkSpan: 0.54,
    rsPow: 0.6,
    rMin: 0.3
  };

  function bootOrbHash(a, b) {
    var h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return h - Math.floor(h);
  }

  function bootOrbMakeMoves(count) {
    var moves = [];
    for (var i = 0; i < count; i += 1) {
      var axis = Math.min(2, Math.floor(bootOrbHash(i, 2.3) * 3));
      var lo = -1 + 0.5 * Math.min(3, Math.floor(bootOrbHash(i, 5.9) * 4));
      var dir = bootOrbHash(i, 7.7) < 0.5 ? 1 : -1;
      moves.push({ axis: axis, lo: lo, hi: lo + 0.5, ang: (dir * Math.PI) / 2 });
    }
    return moves;
  }

  function bootOrbSolveCycle(time, count, slotDur, rest) {
    var cyc = 2 * count * slotDur + rest;
    var tc = time % cyc;
    var amount = [];
    var i;
    for (i = 0; i < count; i += 1) amount.push(0);
    var active = -1;
    if (tc < 2 * count * slotDur) {
      var slot = Math.floor(tc / slotDur);
      var p = (tc - slot * slotDur) / slotDur;
      var cl = Math.min(1, p / 0.7);
      var ep = 1 - Math.pow(1 - cl, 3);
      if (slot < count) {
        for (i = 0; i < slot; i += 1) amount[i] = 1;
        amount[slot] = ep;
        active = slot;
      } else {
        var u = 2 * count - 1 - slot;
        for (i = 0; i < u; i += 1) amount[i] = 1;
        amount[u] = 1 - ep;
        active = u;
      }
    }
    return { amount: amount, active: active };
  }

  function bootOrbApplyMoves(point, moves, cycle) {
    var x = point[0];
    var y = point[1];
    var z = point[2];
    var inActive = false;
    for (var i = 0; i < moves.length; i += 1) {
      if (cycle.amount[i] <= 0) continue;
      var mv = moves[i];
      var coord = mv.axis === 0 ? x : mv.axis === 1 ? y : z;
      if (coord < mv.lo || coord >= mv.hi) continue;
      if (i === cycle.active) inActive = true;
      var a = mv.ang * cycle.amount[i];
      var ca = Math.cos(a);
      var sa = Math.sin(a);
      if (mv.axis === 0) {
        var y2 = y * ca - z * sa;
        z = y * sa + z * ca;
        y = y2;
      } else if (mv.axis === 1) {
        var x2 = x * ca + z * sa;
        z = -x * sa + z * ca;
        x = x2;
      } else {
        var x3 = x * ca - y * sa;
        y = x * sa + y * ca;
        x = x3;
      }
    }
    return [x, y, z, inActive];
  }

  function bootOrbScaleCounts(opts, scale) {
    var out = {};
    for (var key in opts) if (Object.prototype.hasOwnProperty.call(opts, key)) out[key] = opts[key];
    var rt = Math.sqrt(scale);
    if (out.latRings != null && out.lonDensity != null) {
      out.latRings = Math.max(2, Math.round(out.latRings * rt));
      out.lonDensity = Math.max(2, Math.round(out.lonDensity * rt));
    }
    return out;
  }

  function bootOrbScaleRadii(opts, scale) {
    var out = {};
    var radiusKeys = ["rBase", "rDepth", "rActive"];
    for (var key in opts) if (Object.prototype.hasOwnProperty.call(opts, key)) out[key] = opts[key];
    for (var i = 0; i < radiusKeys.length; i += 1) {
      var k = radiusKeys[i];
      if (out[k] != null) out[k] = out[k] * scale;
    }
    return out;
  }

  function bootOrbOptions() {
    var opts = BOOT_ORB_BASE;
    if (BOOT_ORB_PRESET.count !== 1) opts = bootOrbScaleCounts(opts, BOOT_ORB_PRESET.count);
    if (BOOT_ORB_PRESET.size !== 1) opts = bootOrbScaleRadii(opts, BOOT_ORB_PRESET.size);
    return opts;
  }

  // 依据当前主题决定墨色：浅色底用深墨，深色底反相，保持同样的景深语言。
  function bootOrbIsDark() {
    var root = document.documentElement;
    var attr = String(root.getAttribute("data-theme") || "").toLowerCase();
    if (attr === "dark") return true;
    if (attr === "light") return false;
    if (root.classList.contains("dark")) return true;
    if (root.classList.contains("light")) return false;
    return Boolean(
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  }

  function bootOrbFrame(ctx, size, t, dark, opts, inkColor) {
    var cx = size / 2;
    var cy = size / 2;
    var R = (size / 2) * 0.82;
    var yaw = t * 0.55;
    var tilt = 0.35 + 0.1 * Math.sin(t * 0.9);
    var st = Math.sin(tilt);
    var ct = Math.cos(tilt);
    var sy = Math.sin(yaw);
    var cyw = Math.cos(yaw);
    var rs = Math.pow(size / 300, opts.rsPow == null ? 0.6 : opts.rsPow);
    var moveCount = opts.moveCount == null ? 14 : opts.moveCount;
    var moves = bootOrbMakeMoves(moveCount);
    var cycle = bootOrbSolveCycle(t, moveCount, 0.42, 1.2);
    var latRings = opts.latRings == null ? 15 : opts.latRings;
    var lonDensity = opts.lonDensity == null ? 40 : opts.lonDensity;
    var dots = [];
    for (var li = 0; li <= latRings; li += 1) {
      var lat = -Math.PI / 2 + (li / latRings) * Math.PI;
      var cosLat = Math.cos(lat);
      var sinLat = Math.sin(lat);
      var lonCount = Math.max(1, Math.round(Math.abs(cosLat) * lonDensity));
      for (var lj = 0; lj < lonCount; lj += 1) {
        var lon = (lj / lonCount) * 2 * Math.PI;
        var moved = bootOrbApplyMoves(
          [cosLat * Math.cos(lon), sinLat, cosLat * Math.sin(lon)],
          moves,
          cycle
        );
        var x = moved[0];
        var y = moved[1];
        var z = moved[2];
        var inActive = moved[3];
        var x1 = x * cyw + z * sy;
        var z1 = -x * sy + z * cyw;
        var y1 = y * ct - z1 * st;
        var z2 = y * st + z1 * ct;
        var depth = (z2 + 1) / 2;
        var radius = (
          (opts.rBase == null ? 0.6 : opts.rBase) +
          (opts.rDepth == null ? 1.7 : opts.rDepth) * depth +
          (inActive ? (opts.rActive == null ? 0.3 : opts.rActive) : 0)
        ) * rs;
        // The 20px composer mark needs optically larger dots than the 56px
        // boot mark or the sphere reads as a vague smudge on a phone.
        if (inkColor) radius *= 1.16;
        if (radius < (opts.rMin == null ? 0.3 : opts.rMin)) {
          radius = opts.rMin == null ? 0.3 : opts.rMin;
        }
        var white = (opts.inkFar == null ? 0.62 : opts.inkFar) -
          (opts.inkSpan == null ? 0.54 : opts.inkSpan) * depth -
          (inActive ? 0.14 : 0);
        dots.push({
          x: cx + x1 * R,
          y: cy - y1 * R,
          z: z2,
          r: radius,
          white: Math.min(1, Math.max(0, white))
        });
      }
    }
    dots.sort(function (a, b) { return a.z - b.z; });
    ctx.clearRect(0, 0, size, size);
    for (var i = 0; i < dots.length; i += 1) {
      var dot = dots[i];
      var g = Math.round((dark ? 1 - dot.white : dot.white) * 255);
      ctx.fillStyle = inkColor
        ? "rgba(" + inkColor[0] + "," + inkColor[1] + "," + inkColor[2] + "," + (g / 255) + ")"
        : "rgb(" + g + "," + g + "," + g + ")";
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

`;
