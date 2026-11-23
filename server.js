"use strict";
/* Tank Arena - authoritative game server: standalone Node.js version (one room per 5-char code) */

/* ============ SHARED (identical in worker.js and index.html): constants, seeded arena, tank physics ============ */
var TICK_HZ = 20, DT = 0.05;
var ARENA_CELLS = 30, CELL_SIZE = 60, ARENA_SIZE = ARENA_CELLS * CELL_SIZE;
var TANK_RADIUS = 18, BULLET_RADIUS = 4;
var TANK_SPEED = 180, BULLET_SPEED = 420;
var MAX_HEALTH = 6, RELOAD_SECONDS = 0.5;
var RESPAWN_SECONDS = 3;
var MATCH_SECONDS = 180;
var ITEM_RESPAWN_SECONDS = 15;
var ITEM_SLOTS_MAX = 8;
var DROP_CHANCE = 0.55;
var TRAP_CAP = 3;
var TRAP_TRIGGER_RADIUS = 26;

// Item types (perks 1..15, traps 16..26)
var ITEM_SPEED = 1, ITEM_RAPID = 2, ITEM_SHIELD = 3, ITEM_HEALTH = 4;
var ITEM_TRIPLE = 5, ITEM_RICOCHET = 6, ITEM_RAILGUN = 7, ITEM_STEALTH = 8, ITEM_EMP = 9, ITEM_VAMPIRE = 10;
var TRAP_LANDMINE = 16, TRAP_SLOW = 17, TRAP_POISON = 18, TRAP_SMOKE = 19;
var TRAP_MIMIC = 20, TRAP_WORMHOLE = 21, TRAP_BUNGEE = 22, TRAP_SHOCK = 23;
var TRAP_GRAVITY = 24, TRAP_GLITCH = 25, TRAP_NAPALM = 26, TRAP_REPULSOR = 27;
var TRAP_DECOY = 28, TRAP_SENTRY = 29, TRAP_WORMHOLE_B = 30;

function seededRng(seed) {
  var s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function generateArena(seed) {
  var rng = seededRng(seed);
  var N = ARENA_CELLS, grid = new Uint8Array(N * N);
  for (var x = 0; x < N; x++) { grid[x] = 1; grid[(N - 1) * N + x] = 1; }
  for (var y = 0; y < N; y++) { grid[y * N] = 1; grid[y * N + (N - 1)] = 1; }
  for (var x = 2; x < N - 2; x += 2) {
    for (var y = 2; y < N - 2; y += 2) {
      if (rng() < 0.38) {
        grid[y * N + x] = 1;
        var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        var d = dirs[Math.floor(rng() * 4)];
        grid[(y + d[1]) * N + (x + d[0])] = 1;
      }
    }
  }
  // Clear bases
  for (var cx = 1; cx <= 4; cx++) {
    for (var cy = 1; cy <= 4; cy++) {
      grid[cy * N + cx] = 0;
      grid[(N - 1 - cy) * N + (N - 1 - cx)] = 0;
    }
  }
  return grid;
}

function cleanName(n) {
  if (!n) return "PILOT";
  n = String(n).replace(/[^a-zA-Z0-9_\- ]/g, "").trim().slice(0, 12);
  return n || "PILOT";
}

/* ============ AUTHORITATIVE GAME ENGINE ============ */
function Engine(net) {
  var grid = generateArena(1337);
  var tanks = new Map();
  var bullets = [];
  var items = [];
  var traps = [];
  var nextBulletId = 1;
  var nextTrapId = 1;
  var nextItemId = 1;
  var scores = { cyan: 0, pink: 0 };
  var matchTime = MATCH_SECONDS;
  var matchEnded = false;
  var tickCount = 0;

  function canJoin(isNew) {
    if (tanks.size >= 8) return { code: 4001, r: "full" };
    return null;
  }

  function pickSpawn(team) {
    var N = ARENA_CELLS;
    if (team === "cyan") {
      return { x: (2 + Math.random() * 2) * CELL_SIZE, y: (2 + Math.random() * 2) * CELL_SIZE, angle: 0 };
    } else {
      return { x: (N - 4 + Math.random() * 2) * CELL_SIZE, y: (N - 4 + Math.random() * 2) * CELL_SIZE, angle: Math.PI };
    }
  }

  function join(id, name) {
    var cyanCount = 0, pinkCount = 0;
    tanks.forEach(function (t) { if (t.team === "cyan") cyanCount++; else pinkCount++; });
    var team = cyanCount <= pinkCount ? "cyan" : "pink";
    var sp = pickSpawn(team);
    tanks.set(id, {
      id: id, name: name, team: team,
      x: sp.x, y: sp.y, vx: 0, vy: 0, angle: sp.angle,
      hp: MAX_HEALTH, dead: false, respawnTimer: 0,
      kills: 0, deaths: 0, streak: 0,
      reloadTimer: 0, trapCooldown: 0,
      traps: [TRAP_MIMIC, TRAP_WORMHOLE, TRAP_LANDMINE],
      perk: 0, perkTimer: 0,
      speedBoost: 1, rapidFire: 0, shield: false,
      slowTimer: 0, poisonTimer: 0, glitchTimer: 0, shockTimer: 0,
      stealthTimer: 0, tetherX: 0, tetherY: 0, tetherTimer: 0,
      wormholePair: null,
      input: { mx: 0, my: 0, aim: sp.angle, shoot: false, trap: false }
    });
    net.all("j|" + id + "|" + team + "|" + name);
  }

  function leave(id) {
    if (!tanks.has(id)) return;
    tanks.delete(id);
    net.all("l|" + id);
  }

  function onMsg(id, d) {
    var t = tanks.get(id);
    if (!t) return;
    var parts = d.split("|");
    var cmd = parts[0];

    if (cmd === "i") { // Input: i|mx|my|aim|shoot|trap
      t.input.mx = parseFloat(parts[1]) || 0;
      t.input.my = parseFloat(parts[2]) || 0;
      t.input.aim = parseFloat(parts[3]) || 0;
      t.input.shoot = parts[4] === "1";
      if (parts[5] === "1" && !t.input.trap) dropTrap(t);
      t.input.trap = parts[5] === "1";
    } else if (cmd === "q") { // Team quick comms
      var emoteId = parts[1] || "";
      tanks.forEach(function (other, otherId) {
        if (other.team === t.team) net.to(otherId, "q|" + id + "|" + emoteId);
      });
    }
  }

  function collidesWithWall(x, y, r) {
    var minCX = Math.floor((x - r) / CELL_SIZE);
    var maxCX = Math.floor((x + r) / CELL_SIZE);
    var minCY = Math.floor((y - r) / CELL_SIZE);
    var maxCY = Math.floor((y + r) / CELL_SIZE);
    var N = ARENA_CELLS;
    for (var cy = minCY; cy <= maxCY; cy++) {
      for (var cx = minCX; cx <= maxCX; cx++) {
        if (cx < 0 || cy < 0 || cx >= N || cy >= N || grid[cy * N + cx]) return true;
      }
    }
    return false;
  }

  function dropTrap(t) {
    if (t.dead || t.trapCooldown > 0 || t.traps.length === 0) return;
    var trapType = t.traps.shift();
    t.trapCooldown = 1.0;
    var trId = nextTrapId++;

    if (trapType === TRAP_WORMHOLE) {
      if (!t.wormholePair) {
        t.wormholePair = { idA: trId, xA: t.x, yA: t.y, idB: 0, xB: 0, yB: 0 };
        traps.push({ id: trId, type: TRAP_WORMHOLE, team: t.team, ownerId: t.id, x: t.x, y: t.y, pair: t.wormholePair, isA: true });
        t.traps.unshift(TRAP_WORMHOLE_B);
      }
    } else if (trapType === TRAP_WORMHOLE_B && t.wormholePair) {
      t.wormholePair.idB = trId;
      t.wormholePair.xB = t.x;
      t.wormholePair.yB = t.y;
      traps.push({ id: trId, type: TRAP_WORMHOLE_B, team: t.team, ownerId: t.id, x: t.x, y: t.y, pair: t.wormholePair, isA: false });
      t.wormholePair = null;
    } else {
      traps.push({ id: trId, type: trapType, team: t.team, ownerId: t.id, x: t.x, y: t.y, timer: 30 });
    }
    net.all("trd|" + trId + "|" + trapType + "|" + Math.round(t.x) + "|" + Math.round(t.y) + "|" + t.team);
  }

  function fireBullet(t, angleOffset, isRailgun) {
    var ang = t.input.aim + (angleOffset || 0);
    var bx = t.x + Math.cos(ang) * (TANK_RADIUS + 8);
    var by = t.y + Math.sin(ang) * (TANK_RADIUS + 8);
    var bId = nextBulletId++;
    bullets.push({
      id: bId, ownerId: t.id, team: t.team,
      x: bx, y: by,
      vx: Math.cos(ang) * (isRailgun ? BULLET_SPEED * 1.6 : BULLET_SPEED),
      vy: Math.sin(ang) * (isRailgun ? BULLET_SPEED * 1.6 : BULLET_SPEED),
      life: isRailgun ? 0.7 : 2.5,
      bounces: t.perk === ITEM_RICOCHET ? 2 : 0,
      railgun: isRailgun || false,
      vampire: t.perk === ITEM_VAMPIRE
    });
  }

  function spawnItem() {
    if (items.length >= ITEM_SLOTS_MAX) return;
    var N = ARENA_CELLS;
    for (var tries = 0; tries < 20; tries++) {
      var cx = 1 + Math.floor(Math.random() * (N - 2));
      var cy = 1 + Math.floor(Math.random() * (N - 2));
      if (!grid[cy * N + cx]) {
        var itId = nextItemId++;
        var pool = [
          ITEM_SPEED, ITEM_RAPID, ITEM_SHIELD, ITEM_HEALTH,
          ITEM_TRIPLE, ITEM_RICOCHET, ITEM_RAILGUN, ITEM_STEALTH, ITEM_EMP, ITEM_VAMPIRE,
          TRAP_LANDMINE, TRAP_SLOW, TRAP_POISON, TRAP_SMOKE,
          TRAP_MIMIC, TRAP_WORMHOLE, TRAP_BUNGEE, TRAP_SHOCK,
          TRAP_GRAVITY, TRAP_GLITCH, TRAP_NAPALM, TRAP_REPULSOR,
          TRAP_DECOY, TRAP_SENTRY
        ];
        var type = pool[Math.floor(Math.random() * pool.length)];
        var it = { id: itId, type: type, x: (cx + 0.5) * CELL_SIZE, y: (cy + 0.5) * CELL_SIZE };
        items.push(it);
        net.all("it+" + itId + "|" + type + "|" + Math.round(it.x) + "|" + Math.round(it.y));
        break;
      }
    }
  }

  function tick(now) {
    if (matchEnded) return;
    tickCount++;
    matchTime -= DT;
    if (matchTime <= 0) {
      matchTime = 0;
      matchEnded = true;
      var winner = scores.cyan > scores.pink ? "cyan" : (scores.pink > scores.cyan ? "pink" : "draw");
      net.all("end|" + winner + "|" + scores.cyan + "|" + scores.pink);
      return;
    }

    if (tickCount % (TICK_HZ * 5) === 0) spawnItem();

    // 1. Tanks update
    tanks.forEach(function (t) {
      if (t.dead) {
        t.respawnTimer -= DT;
        if (t.respawnTimer <= 0) {
          t.dead = false;
          t.hp = MAX_HEALTH;
          var sp = pickSpawn(t.team);
          t.x = sp.x; t.y = sp.y; t.vx = 0; t.vy = 0;
          t.slowTimer = 0; t.poisonTimer = 0; t.glitchTimer = 0; t.shockTimer = 0;
          net.all("rsp|" + t.id + "|" + Math.round(t.x) + "|" + Math.round(t.y));
        }
        return;
      }

      // Timers & effects
      if (t.reloadTimer > 0) t.reloadTimer -= DT;
      if (t.trapCooldown > 0) t.trapCooldown -= DT;
      if (t.perkTimer > 0) {
        t.perkTimer -= DT;
        if (t.perkTimer <= 0) { t.perk = 0; t.speedBoost = 1; t.rapidFire = 0; }
      }
      if (t.slowTimer > 0) t.slowTimer -= DT;
      if (t.glitchTimer > 0) t.glitchTimer -= DT;
      if (t.shockTimer > 0) t.shockTimer -= DT;
      if (t.stealthTimer > 0) t.stealthTimer -= DT;

      if (t.tetherTimer > 0) {
        t.tetherTimer -= DT;
        var tdx = t.x - t.tetherX, tdy = t.y - t.tetherY;
        var tdist = Math.hypot(tdx, tdy);
        if (tdist > 170) {
          t.x = t.tetherX + (tdx / tdist) * 160;
          t.y = t.tetherY + (tdy / tdist) * 160;
          t.vx *= -0.5; t.vy *= -0.5;
        }
      }

      if (t.poisonTimer > 0) {
        t.poisonTimer -= DT;
        if (tickCount % TICK_HZ === 0) {
          t.hp -= 0.5;
          if (t.hp <= 0) killTank(t, null);
        }
      }

      // Movement
      if (t.shockTimer <= 0) {
        var mx = t.input.mx, my = t.input.my;
        if (t.glitchTimer > 0) { mx = -mx; my = -my; }
        var spd = TANK_SPEED * t.speedBoost;
        if (t.slowTimer > 0) spd *= 0.5;
        var len = Math.hypot(mx, my);
        if (len > 1) { mx /= len; my /= len; }

        var nx = t.x + mx * spd * DT;
        var ny = t.y + my * spd * DT;
        if (!collidesWithWall(nx, t.y, TANK_RADIUS)) t.x = nx;
        if (!collidesWithWall(t.x, ny, TANK_RADIUS)) t.y = ny;
        t.angle = t.input.aim;
      }

      // Firing
      if (t.input.shoot && t.reloadTimer <= 0) {
        var rTime = RELOAD_SECONDS;
        if (t.rapidFire > 0) rTime *= 0.45;
        t.reloadTimer = rTime;

        if (t.perk === ITEM_TRIPLE) {
          fireBullet(t, 0);
          fireBullet(t, -0.22);
          fireBullet(t, 0.22);
        } else if (t.perk === ITEM_RAILGUN) {
          fireBullet(t, 0, true);
        } else {
          fireBullet(t, 0);
        }
      }

      // Pick up items
      for (var i = items.length - 1; i >= 0; i--) {
        var it = items[i];
        if (Math.hypot(t.x - it.x, t.y - it.y) < TANK_RADIUS + 14) {
          applyItem(t, it.type);
          net.all("it-|" + it.id + "|" + t.id);
          items.splice(i, 1);
        }
      }
    });

    // 2. Traps logic
    for (var ti = traps.length - 1; ti >= 0; ti--) {
      var tr = traps[ti];
      var triggered = false;

      // Sentry gun behavior
      if (tr.type === TRAP_SENTRY) {
        tr.sentryReload = (tr.sentryReload || 0) - DT;
        if (tr.sentryReload <= 0) {
          tanks.forEach(function (tgt) {
            if (tgt.dead || tgt.team === tr.team || tr.sentryReload > 0) return;
            var d = Math.hypot(tgt.x - tr.x, tgt.y - tr.y);
            if (d < 300) {
              tr.sentryReload = 0.8;
              var ang = Math.atan2(tgt.y - tr.y, tgt.x - tr.x);
              bullets.push({
                id: nextBulletId++, ownerId: tr.ownerId, team: tr.team,
                x: tr.x + Math.cos(ang) * 16, y: tr.y + Math.sin(ang) * 16,
                vx: Math.cos(ang) * BULLET_SPEED * 0.9, vy: Math.sin(ang) * BULLET_SPEED * 0.9,
                life: 1.5, bounces: 0
              });
            }
          });
        }
      }

      tanks.forEach(function (t) {
        if (t.dead || triggered) return;
        var dist = Math.hypot(t.x - tr.x, t.y - tr.y);

        // Gravity Well pulls
        if (tr.type === TRAP_GRAVITY && t.team !== tr.team && dist < 180) {
          var pAngle = Math.atan2(tr.y - t.y, tr.x - t.x);
          t.x += Math.cos(pAngle) * 90 * DT;
          t.y += Math.sin(pAngle) * 90 * DT;
        }

        if (dist < TRAP_TRIGGER_RADIUS) {
          if (tr.type === TRAP_WORMHOLE || tr.type === TRAP_WORMHOLE_B) {
            if (tr.pair && tr.pair.idA && tr.pair.idB && (!t.lastWormhole || now - t.lastWormhole > 1200)) {
              t.lastWormhole = now;
              var destX = tr.isA ? tr.pair.xB : tr.pair.xA;
              var destY = tr.isA ? tr.pair.yB : tr.pair.yA;
              t.x = destX; t.y = destY;
              net.all("fx|wh|" + Math.round(destX) + "|" + Math.round(destY));
            }
            return;
          }

          if (t.team !== tr.team) {
            triggered = true;
            triggerTrap(tr, t);
          }
        }
      });

      if (triggered && tr.type !== TRAP_WORMHOLE && tr.type !== TRAP_WORMHOLE_B) {
        net.all("trx|" + tr.id + "|" + tr.type);
        traps.splice(ti, 1);
      }
    }

    // 3. Bullets update
    for (var bi = bullets.length - 1; bi >= 0; bi--) {
      var b = bullets[bi];
      b.life -= DT;
      if (b.life <= 0) { bullets.splice(bi, 1); continue; }

      var nbx = b.x + b.vx * DT;
      var nby = b.y + b.vy * DT;

      if (collidesWithWall(nbx, nby, BULLET_RADIUS)) {
        if (b.bounces > 0) {
          b.bounces--;
          if (collidesWithWall(nbx, b.y, BULLET_RADIUS)) b.vx = -b.vx;
          if (collidesWithWall(b.x, nby, BULLET_RADIUS)) b.vy = -b.vy;
          continue;
        } else {
          bullets.splice(bi, 1);
          continue;
        }
      }
      b.x = nbx; b.y = nby;

      // Wormhole bullet teleport
      for (var wi = 0; wi < traps.length; wi++) {
        var wh = traps[wi];
        if ((wh.type === TRAP_WORMHOLE || wh.type === TRAP_WORMHOLE_B) && wh.pair && wh.pair.idA && wh.pair.idB) {
          if (Math.hypot(b.x - wh.x, b.y - wh.y) < 22 && (!b.lastWh || now - b.lastWh > 800)) {
            b.lastWh = now;
            b.x = wh.isA ? wh.pair.xB : wh.pair.xA;
            b.y = wh.isA ? wh.pair.yB : wh.pair.yA;
            break;
          }
        }
      }

      // Check hit tanks
      var hit = false;
      tanks.forEach(function (t) {
        if (hit || t.dead || t.team === b.team) return;
        if (Math.hypot(t.x - b.x, t.y - b.y) < TANK_RADIUS + BULLET_RADIUS) {
          hit = true;
          damageTank(t, b.railgun ? 3 : 2, b.ownerId, b.vampire);
        }
      });
      if (hit && !b.railgun) bullets.splice(bi, 1);
    }

    // Broadcast state to all clients
    if (tickCount % 1 === 0) broadcastState();
  }

  function applyItem(t, type) {
    if (type === ITEM_SPEED) { t.speedBoost = 1.4; t.perkTimer = 8; t.perk = ITEM_SPEED; }
    else if (type === ITEM_RAPID) { t.rapidFire = 1; t.perkTimer = 8; t.perk = ITEM_RAPID; }
    else if (type === ITEM_SHIELD) { t.shield = true; }
    else if (type === ITEM_HEALTH) { t.hp = Math.min(MAX_HEALTH, t.hp + 3); }
    else if (type === ITEM_TRIPLE) { t.perk = ITEM_TRIPLE; t.perkTimer = 10; }
    else if (type === ITEM_RICOCHET) { t.perk = ITEM_RICOCHET; t.perkTimer = 12; }
    else if (type === ITEM_RAILGUN) { t.perk = ITEM_RAILGUN; t.perkTimer = 10; }
    else if (type === ITEM_STEALTH) { t.perk = ITEM_STEALTH; t.perkTimer = 8; t.stealthTimer = 8; }
    else if (type === ITEM_EMP) {
      tanks.forEach(function (other) {
        if (other.team !== t.team && Math.hypot(other.x - t.x, other.y - t.y) < 280) {
          other.shockTimer = 2.5;
          other.glitchTimer = 3.5;
        }
      });
      net.all("fx|emp|" + Math.round(t.x) + "|" + Math.round(t.y));
    }
    else if (type === ITEM_VAMPIRE) { t.perk = ITEM_VAMPIRE; t.perkTimer = 12; }
    else if (type >= 16) {
      if (t.traps.length < TRAP_CAP) t.traps.push(type);
    }
  }

  function triggerTrap(tr, victim) {
    if (tr.type === TRAP_LANDMINE) {
      damageTank(victim, 3, tr.ownerId, false);
      net.all("fx|exp|" + Math.round(tr.x) + "|" + Math.round(tr.y));
    } else if (tr.type === TRAP_SLOW) {
      victim.slowTimer = 8;
    } else if (tr.type === TRAP_POISON) {
      victim.poisonTimer = 8;
    } else if (tr.type === TRAP_SMOKE) {
      net.all("fx|smk|" + Math.round(tr.x) + "|" + Math.round(tr.y));
    } else if (tr.type === TRAP_MIMIC) {
      damageTank(victim, 2, tr.ownerId, false);
      victim.shockTimer = 1.0;
      net.all("fx|mimic|" + Math.round(tr.x) + "|" + Math.round(tr.y));
    } else if (tr.type === TRAP_BUNGEE) {
      victim.tetherX = tr.x; victim.tetherY = tr.y; victim.tetherTimer = 5;
    } else if (tr.type === TRAP_SHOCK) {
      victim.shockTimer = 1.5;
    } else if (tr.type === TRAP_GLITCH) {
      victim.glitchTimer = 4.0;
    } else if (tr.type === TRAP_NAPALM) {
      victim.hp -= 1.5; victim.slowTimer = 4.0;
      net.all("fx|fire|" + Math.round(tr.x) + "|" + Math.round(tr.y));
    } else if (tr.type === TRAP_REPULSOR) {
      var ang = Math.atan2(victim.y - tr.y, victim.x - tr.x);
      victim.x += Math.cos(ang) * 90;
      victim.y += Math.sin(ang) * 90;
      if (collidesWithWall(victim.x, victim.y, TANK_RADIUS)) damageTank(victim, 2, tr.ownerId, false);
    } else if (tr.type === TRAP_DECOY) {
      net.all("fx|flash|" + victim.id);
    }
  }

  function damageTank(t, amt, killerId, vampire) {
    if (t.shield) { t.shield = false; return; }
    t.hp -= amt;
    if (vampire && killerId) {
      var killer = tanks.get(killerId);
      if (killer && killer.hp < MAX_HEALTH) killer.hp = Math.min(MAX_HEALTH, killer.hp + 1);
    }
    if (t.hp <= 0) killTank(t, killerId);
  }

  function killTank(t, killerId) {
    t.dead = true;
    t.hp = 0;
    t.deaths++;
    t.streak = 0;
    t.respawnTimer = RESPAWN_SECONDS;

    var oppTeam = t.team === "cyan" ? "pink" : "cyan";
    scores[oppTeam]++;

    if (killerId) {
      var killer = tanks.get(killerId);
      if (killer) {
        killer.kills++;
        killer.streak++;
        if (killer.streak === 2) net.all("ks|" + killer.name + "|DOUBLE KILL!");
        else if (killer.streak === 3) net.all("ks|" + killer.name + "|TRIPLE KILL!");
        else if (killer.streak >= 5) net.all("ks|" + killer.name + "|UNSTOPPABLE!");
      }
    }
    net.all("k|" + (killerId || "") + "|" + t.id + "|" + scores.cyan + "|" + scores.pink);
  }

  function broadcastState() {
    var out = "s|" + Math.round(matchTime) + "|" + scores.cyan + "|" + scores.pink + "~";
    var first = true;
    tanks.forEach(function (t) {
      if (!first) out += ";";
      first = false;
      out += t.id + "," + Math.round(t.x) + "," + Math.round(t.y) + "," +
             Math.round(t.angle * 100) / 100 + "," + Math.round(t.hp) + "," +
             (t.dead ? 1 : 0) + "," + (t.shield ? 1 : 0) + "," +
             (t.stealthTimer > 0 ? 1 : 0) + "," + t.perk;
    });
    net.all(out);
  }

  return { canJoin: canJoin, join: join, leave: leave, onMsg: onMsg, tick: tick };
}

/* ============ STANDALONE SERVER (Node.js): same Engine, hosted in India / Singapore for low ping ============
   Run:  npm install  &&  node server.js        (PORT env var, default 8080)
   Players connect to  ws(s)://this-server/r/CODE  exactly like the Cloudflare worker.
   If index.html sits next to this file, opening this server's address in a browser plays the game on THIS server. */
var http = require("http");
var fs = require("fs");
var path = require("path");
var WebSocketServer = require("ws").WebSocketServer;

var PORT = parseInt(process.env.PORT || "8080", 10);
var IDLE_MS = 15000;     // a socket silent this long is dropped (clients ping every 2 s)
var EMPTY_MS = 30000;    // an empty room is deleted after this long
var rooms = new Map();   // code -> room

function makeRoom(code) {
  var room = { code: code, socks: new Map(), seen: new Map(), timer: null, ticks: 0, emptyAt: 0, eng: null };
  function send(id, s) {
    var ws = room.socks.get(id);
    if (!ws || ws.readyState !== 1) return;
    if (ws.bufferedAmount > 65536) return;   // a stalled phone must not grow server memory; the next tick resends state
    try { ws.send(s); } catch (e) { drop(id); }
  }
  function drop(id) {
    if (!room.socks.has(id)) return;
    room.socks.delete(id);
    room.seen.delete(id);
    room.eng.leave(id);
    if (room.socks.size === 0) { stop(); room.emptyAt = Date.now(); }
  }
  function stop() { if (room.timer !== null) { clearInterval(room.timer); room.timer = null; } }
  function loop() {
    var now = Date.now();
    room.eng.tick(now);
    if (++room.ticks % 20 === 0) {
      var stale = [];
      room.seen.forEach(function (t, id) { if (now - t > IDLE_MS) stale.push(id); });
      for (var i = 0; i < stale.length; i++) {
        var ws = room.socks.get(stale[i]);
        if (ws) { try { ws.close(4008, "idle"); } catch (e) {} }
        drop(stale[i]);
      }
    }
  }
  room.send = send;
  room.drop = drop;
  room.start = function () { if (room.timer === null) room.timer = setInterval(loop, 50); };
  room.eng = Engine({
    all: function (s) { room.socks.forEach(function (ws, id) { send(id, s); }); },
    to: function (id, s) { send(id, s); },
    kick: function (id, code, reason) {
      var ws = room.socks.get(id);
      if (ws) { try { ws.close(code, reason); } catch (e) {} }
      drop(id);
    }
  });
  return room;
}

function newId(room) {
  var id = "";
  do { id = Math.random().toString(36).slice(2, 6); } while (id.length < 4 || room.socks.has(id));
  return id;
}

/* The game page: served with its server address pointed back at this machine. */
var page = null;
try {
  page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8")
    .replace(/const DEFAULT_SERVER='[^']*';/, "const DEFAULT_SERVER=(location.protocol==='https:'?'wss://':'ws://')+location.host;");
} catch (e) { page = null; }

var server = http.createServer(function (req, res) {
  var p = (req.url || "/").split("?")[0];
  if (page && (p === "/" || p === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(page);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Tank Arena server OK - rooms: " + rooms.size);
});

var wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 512 });

server.on("upgrade", function (req, socket, head) {
  var u = new URL(req.url || "/", "http://x");
  var m = u.pathname.match(/^\/r\/([A-Za-z0-9]{5})$/);
  if (!m) { socket.destroy(); return; }
  try { socket.setNoDelay(true); } catch (e) {}
  wss.handleUpgrade(req, socket, head, function (ws) {
    var code = m[1].toUpperCase();
    var isNew = u.searchParams.get("new") === "1";
    var name = cleanName(u.searchParams.get("n"));
    var room = rooms.get(code);
    if (!room) { room = makeRoom(code); rooms.set(code, room); room.emptyAt = Date.now(); }
    var why = room.eng.canJoin(isNew);
    if (why) { try { ws.close(why.code, why.r); } catch (e) {} return; }
    var id = newId(room);
    room.socks.set(id, ws);
    room.seen.set(id, Date.now());
    room.emptyAt = 0;
    ws.on("message", function (data, isBinary) {
      if (isBinary) return;
      var d = data.toString();
      if (d.length === 0 || d.length > 160) return;
      room.seen.set(id, Date.now());
      if (d.charCodeAt(0) === 112 && d.charCodeAt(1) === 124) {   // "p|ts": answer the ping right away
        try { ws.send("o|" + d.slice(2, 22)); } catch (x) {}
        return;
      }
      room.eng.onMsg(id, d);
    });
    ws.on("close", function () { room.drop(id); });
    ws.on("error", function () { room.drop(id); });
    room.eng.join(id, name);
    room.start();
  });
});

/* Delete rooms nobody has used for a while. */
setInterval(function () {
  var now = Date.now(), dead = [];
  rooms.forEach(function (r, code) { if (r.socks.size === 0 && r.emptyAt && now - r.emptyAt > EMPTY_MS) dead.push(code); });
  for (var i = 0; i < dead.length; i++) rooms.delete(dead[i]);
}, 10000);

server.listen(PORT, "0.0.0.0", function () {
  console.log("Tank Arena server listening on port " + PORT + (page ? " (serving the game page too)" : ""));
});
