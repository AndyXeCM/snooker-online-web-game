(() => {
  "use strict";

  const canvas = document.getElementById("tableCanvas");
  const ctx = canvas.getContext("2d");

  const ui = {
    scoreStrip: document.getElementById("scoreStrip"),
    statusText: document.getElementById("statusText"),
    targetText: document.getElementById("targetText"),
    roomBadge: document.getElementById("roomBadge"),
    modeButtons: [...document.querySelectorAll(".mode-button")],
    powerFill: document.getElementById("powerFill"),
    powerValue: document.getElementById("powerValue"),
    shootButton: document.getElementById("shootButton"),
    resetButton: document.getElementById("resetButton"),
    playerName: document.getElementById("playerName"),
    roomCodeInput: document.getElementById("roomCodeInput"),
    createRoomButton: document.getElementById("createRoomButton"),
    joinRoomButton: document.getElementById("joinRoomButton"),
    leaveRoomButton: document.getElementById("leaveRoomButton"),
    roomInfo: document.getElementById("roomInfo"),
    playersList: document.getElementById("playersList"),
    shotLog: document.getElementById("shotLog"),
  };

  const TABLE = {
    width: 1000,
    height: 520,
    left: 58,
    right: 942,
    top: 58,
    bottom: 462,
    midX: 500,
    midY: 260,
    rail: 36,
    pocketR: 25,
    ballR: 11.5,
  };

  const FEEL = {
    stopSpeed: 3.4,
    collisionIterations: 3,
    collisionRestitution: 0.986,
    collisionThrow: 0.018,
    rollDecayPerFrame: 0.989,
    rollDrag: 14,
    shotMinSpeed: 95,
    shotMaxSpeed: 1600,
    shotPowerCurve: 1.65,
    breakBoost: 80,
    aimPowerDistance: 420,
    aimPowerCurve: 1.12,
    cushionBaseBounce: 0.855,
    cushionMaxBounce: 0.925,
    cushionTangentialDrag: 0.982,
    pocketPull: 360,
    pocketTangentialDamp: 4.2,
    guideLength: 460,
  };

  const MODES = {
    eight: { label: "8 球", players: 2 },
    nine: { label: "9 球", players: 2 },
    snooker: { label: "斯诺克", players: 2 },
    practice: { label: "练习", players: 1 },
  };

  const COLORS = {
    cue: "#f3ecd8",
    red: "#c83235",
    yellow: "#ead15d",
    blue: "#2f64c6",
    purple: "#7049a8",
    orange: "#dd8d2a",
    green: "#23885b",
    maroon: "#7b2837",
    black: "#18191d",
    pink: "#d86ca8",
    brown: "#8b5a34",
    stripeBase: "#f6f0df",
  };

  const POCKETS = [
    { x: TABLE.left, y: TABLE.top, kind: "corner" },
    { x: TABLE.midX, y: TABLE.top - 2, kind: "middle" },
    { x: TABLE.right, y: TABLE.top, kind: "corner" },
    { x: TABLE.left, y: TABLE.bottom, kind: "corner" },
    { x: TABLE.midX, y: TABLE.bottom + 2, kind: "middle" },
    { x: TABLE.right, y: TABLE.bottom, kind: "corner" },
  ];

  const state = {
    mode: "eight",
    players: [],
    turnIndex: 0,
    balls: [],
    shotLog: [],
    shotInProgress: false,
    pottedThisShot: [],
    shotNumber: 0,
    targetAtShot: null,
    gameOver: false,
    winnerId: null,
    message: "准备开球",
    groups: {},
    aim: {
      angle: 0,
      power: 0.55,
      dragging: false,
      pointerId: null,
    },
    keys: new Set(),
    online: {
      active: false,
      socket: null,
      socketId: null,
      roomCode: null,
      isHost: false,
      lastSnapshotAt: 0,
      waitingForHost: false,
    },
  };

  const defaultName = localStorage.getItem("break-room-name") || "Player";
  ui.playerName.value = defaultName;
  const stateMirror = document.createElement("script");
  stateMirror.type = "application/json";
  stateMirror.id = "gameStateMirror";
  document.body.append(stateMirror);

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function makeBody(x, y) {
    return {
      position: { x, y },
      velocity: { x: 0, y: 0 },
      angularVelocity: 0,
    };
  }

  function setPosition(body, position) {
    body.position.x = position.x;
    body.position.y = position.y;
  }

  function setVelocity(body, velocity) {
    body.velocity.x = velocity.x;
    body.velocity.y = velocity.y;
  }

  function setAngularVelocity(body, value) {
    body.angularVelocity = value;
  }

  function currentPlayer() {
    return state.players[state.turnIndex] || state.players[0] || null;
  }

  function opponentIndex(index = state.turnIndex) {
    if (state.players.length <= 1) return index;
    return (index + 1) % state.players.length;
  }

  function opponentPlayer() {
    return state.players[opponentIndex()] || currentPlayer();
  }

  function playerLabel(player) {
    if (!player) return "玩家";
    return player.host ? `${player.name} · 房主` : player.name;
  }

  function modeLabel(mode = state.mode) {
    return MODES[mode]?.label || "台球";
  }

  function makeIcon(name) {
    const icon = document.createElement("i");
    icon.dataset.lucide = name;
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }

  function refreshIcons() {
    window.lucide?.createIcons();
  }

  function getBall(id) {
    return state.balls.find((ball) => ball.id === id);
  }

  function cueBall() {
    return getBall("cue");
  }

  function visibleBalls() {
    return state.balls.filter((ball) => !ball.pocketed);
  }

  function objectBalls() {
    return state.balls.filter((ball) => ball.id !== "cue" && !ball.pocketed);
  }

  function ballSpeed(ball) {
    if (ball.pocketed) return 0;
    const velocity = ball.body.velocity;
    return Math.hypot(velocity.x, velocity.y);
  }

  function allStopped() {
    return state.balls.every((ball) => ball.pocketed || ballSpeed(ball) < FEEL.stopSpeed);
  }

  function shouldSimulate() {
    return !state.online.active || state.online.isHost;
  }

  function canControlCurrentPlayer() {
    if (state.gameOver || state.shotInProgress || !allStopped()) return false;
    if (!state.online.active) return true;
    const player = currentPlayer();
    return Boolean(player && player.id === state.online.socketId);
  }

  function makeLocalPlayers(mode = state.mode) {
    if (mode === "practice") {
      return [{ id: "local-1", name: "练习", score: 0, group: null, host: true }];
    }
    return [
      { id: "local-1", name: "Player 1", score: 0, group: null, host: true },
      { id: "local-2", name: "Player 2", score: 0, group: null, host: false },
    ];
  }

  function resetScores() {
    state.players.forEach((player) => {
      player.score = 0;
      player.group = null;
    });
    state.groups = {};
  }

  function clearWorld() {
    state.balls = [];
  }

  function addBall({
    id,
    number = null,
    x,
    y,
    color,
    stripe = false,
    kind = "object",
    points = 1,
  }) {
    const ball = {
      id,
      number,
      kind,
      points,
      color,
      stripe,
      pocketed: false,
      body: makeBody(x, y),
    };
    state.balls.push(ball);
    return ball;
  }

  function setPocketed(ball, pocketed) {
    ball.pocketed = pocketed;
    if (pocketed) {
      setVelocity(ball.body, { x: 0, y: 0 });
      setAngularVelocity(ball.body, 0);
      setPosition(ball.body, { x: -120, y: -120 });
    }
  }

  function findOpenCueSpot() {
    const candidates = [
      { x: 248, y: TABLE.midY },
      { x: 224, y: TABLE.midY - 34 },
      { x: 224, y: TABLE.midY + 34 },
      { x: 274, y: TABLE.midY - 54 },
      { x: 274, y: TABLE.midY + 54 },
    ];
    return (
      candidates.find((candidate) =>
        objectBalls().every(
          (ball) => distance(candidate, ball.body.position) > TABLE.ballR * 2.25,
        ),
      ) || candidates[0]
    );
  }

  function resetCueBall() {
    const cue = cueBall();
    if (!cue) return;
    const spot = findOpenCueSpot();
    cue.pocketed = false;
    setPosition(cue.body, spot);
    setVelocity(cue.body, { x: 0, y: 0 });
    setAngularVelocity(cue.body, 0);
  }

  function rackTriangle(apexX, centerY, rows, ballDefs) {
    const diameter = TABLE.ballR * 2 + 0.8;
    const xStep = diameter * 0.88;
    let index = 0;
    for (let row = 0; row < rows; row += 1) {
      const x = apexX + row * xStep;
      const startY = centerY - (row * diameter) / 2;
      for (let col = 0; col <= row; col += 1) {
        const def = ballDefs[index];
        if (def) addBall({ ...def, x, y: startY + col * diameter });
        index += 1;
      }
    }
  }

  function rackEightBall() {
    addBall({ id: "cue", x: 246, y: TABLE.midY, color: COLORS.cue, kind: "cue" });
    const poolColors = {
      1: COLORS.yellow,
      2: COLORS.blue,
      3: COLORS.red,
      4: COLORS.purple,
      5: COLORS.orange,
      6: COLORS.green,
      7: COLORS.maroon,
      8: COLORS.black,
      9: COLORS.yellow,
      10: COLORS.blue,
      11: COLORS.red,
      12: COLORS.purple,
      13: COLORS.orange,
      14: COLORS.green,
      15: COLORS.maroon,
    };
    const order = [1, 11, 4, 6, 8, 15, 13, 3, 10, 7, 2, 12, 5, 14, 9];
    rackTriangle(
      650,
      TABLE.midY,
      5,
      order.map((number) => ({
        id: String(number),
        number,
        color: poolColors[number],
        stripe: number > 8,
        kind: number === 8 ? "eight" : number < 8 ? "solid" : "stripe",
        points: 1,
      })),
    );
  }

  function rackNineBall() {
    addBall({ id: "cue", x: 246, y: TABLE.midY, color: COLORS.cue, kind: "cue" });
    const poolColors = {
      1: COLORS.yellow,
      2: COLORS.blue,
      3: COLORS.red,
      4: COLORS.purple,
      5: COLORS.orange,
      6: COLORS.green,
      7: COLORS.maroon,
      8: COLORS.black,
      9: COLORS.yellow,
    };
    const d = TABLE.ballR * 2 + 0.8;
    const x = 676;
    const positions = [
      [0, 0, 1],
      [0.88, -0.5, 2],
      [0.88, 0.5, 3],
      [1.76, -1, 4],
      [1.76, 0, 9],
      [1.76, 1, 5],
      [2.64, -0.5, 6],
      [2.64, 0.5, 7],
      [3.52, 0, 8],
    ];
    positions.forEach(([dx, dy, number]) => {
      addBall({
        id: String(number),
        number,
        x: x + dx * d,
        y: TABLE.midY + dy * d,
        color: poolColors[number],
        stripe: number === 9,
        kind: number === 9 ? "nine" : "object",
        points: 1,
      });
    });
  }

  function rackPractice() {
    addBall({ id: "cue", x: 246, y: TABLE.midY, color: COLORS.cue, kind: "cue" });
    const defs = [
      { number: 1, color: COLORS.yellow },
      { number: 2, color: COLORS.blue },
      { number: 3, color: COLORS.red },
      { number: 4, color: COLORS.purple },
      { number: 5, color: COLORS.orange },
      { number: 6, color: COLORS.green },
      { number: 7, color: COLORS.maroon },
      { number: 8, color: COLORS.black },
      { number: 9, color: COLORS.yellow, stripe: true },
      { number: 10, color: COLORS.blue, stripe: true },
    ];
    rackTriangle(
      670,
      TABLE.midY,
      4,
      defs.map((def) => ({
        id: String(def.number),
        ...def,
        kind: def.number === 8 ? "eight" : "object",
        points: 1,
      })),
    );
  }

  function rackSnooker() {
    addBall({ id: "cue", x: 232, y: TABLE.midY + 58, color: COLORS.cue, kind: "cue" });
    const colorBalls = [
      ["yellow", "黄", COLORS.yellow, 2, 214, TABLE.midY + 72],
      ["green", "绿", COLORS.green, 3, 214, TABLE.midY - 72],
      ["brown", "棕", COLORS.brown, 4, 214, TABLE.midY],
      ["blue", "蓝", COLORS.blue, 5, TABLE.midX, TABLE.midY],
      ["pink", "粉", COLORS.pink, 6, 682, TABLE.midY],
      ["black", "黑", COLORS.black, 7, 822, TABLE.midY],
    ];
    colorBalls.forEach(([id, label, color, points, x, y]) => {
      addBall({ id, number: label, x, y, color, kind: "color", points });
    });
    const reds = Array.from({ length: 15 }, (_, index) => ({
      id: `red-${index + 1}`,
      number: null,
      color: COLORS.red,
      kind: "red",
      points: 1,
    }));
    rackTriangle(706, TABLE.midY, 5, reds);
  }

  function rackMode(mode, options = {}) {
    const { keepPlayers = false, keepScores = false, quiet = false } = options;
    state.mode = mode;
    clearWorld();
    state.turnIndex = 0;
    state.shotInProgress = false;
    state.pottedThisShot = [];
    state.shotNumber = 0;
    state.targetAtShot = null;
    state.gameOver = false;
    state.winnerId = null;
    state.groups = {};
    state.aim.angle = 0;
    state.aim.power = 0.55;

    if (!keepPlayers && !state.online.active) {
      state.players = makeLocalPlayers(mode);
    } else if (!keepScores) {
      resetScores();
    }

    if (mode === "nine") rackNineBall();
    else if (mode === "snooker") rackSnooker();
    else if (mode === "practice") rackPractice();
    else rackEightBall();

    if (!quiet) {
      state.shotLog = [`${modeLabel(mode)} 已重摆`];
      state.message = `${modeLabel(mode)} 准备开球`;
    }
    updateHud();
    broadcastSnapshot(true);
  }

  function numberedPoolGroup(ball) {
    if (!ball || ball.number === null) return null;
    if (ball.number >= 1 && ball.number <= 7) return "solid";
    if (ball.number >= 9 && ball.number <= 15) return "stripe";
    if (ball.number === 8) return "eight";
    return null;
  }

  function groupName(group) {
    if (group === "solid") return "实色";
    if (group === "stripe") return "花色";
    return "未分组";
  }

  function remainingGroupBalls(group) {
    return state.balls.filter(
      (ball) => !ball.pocketed && numberedPoolGroup(ball) === group,
    );
  }

  function lowestNineBall() {
    const numbers = objectBalls()
      .map((ball) => ball.number)
      .filter((number) => typeof number === "number");
    return numbers.length ? Math.min(...numbers) : null;
  }

  function snookerRemainingPoints() {
    return objectBalls().reduce((sum, ball) => sum + (ball.points || 0), 0);
  }

  function setWinner(player, message) {
    state.gameOver = true;
    state.winnerId = player?.id || null;
    state.message = message || `${playerLabel(player)} 获胜`;
  }

  function addLog(line) {
    state.shotLog.unshift(line);
    state.shotLog = state.shotLog.slice(0, 8);
  }

  function advanceTurn() {
    if (state.players.length > 1) {
      state.turnIndex = opponentIndex();
    }
  }

  function scorePlayer(player, points) {
    if (!player || !points) return;
    player.score += points;
  }

  function pocketBall(ball) {
    if (ball.pocketed) return;
    setPocketed(ball, true);
    state.pottedThisShot.push(ball.id);
  }

  function pocketCatchRadius(pocket, speed) {
    const base = pocket.kind === "middle" ? TABLE.pocketR - 8 : TABLE.pocketR - 6;
    const slowAssist = clamp((220 - speed) / 220, 0, 1) * 3.5;
    return base + slowAssist;
  }

  function handlePockets() {
    for (const ball of state.balls) {
      if (ball.pocketed) continue;
      const position = ball.body.position;
      const speed = ballSpeed(ball);
      const pocket = POCKETS.find(
        (target) => distance(position, target) < pocketCatchRadius(target, speed),
      );
      if (pocket) pocketBall(ball);
    }
  }

  function applyPocketForces(dt) {
    for (const ball of state.balls) {
      if (ball.pocketed) continue;
      const position = ball.body.position;
      const velocity = ball.body.velocity;
      const speed = ballSpeed(ball);

      for (const pocket of POCKETS) {
        const dx = pocket.x - position.x;
        const dy = pocket.y - position.y;
        const dist = Math.hypot(dx, dy);
        const pullRadius = pocket.kind === "middle" ? 40 : 45;
        if (dist <= 0.001 || dist > pullRadius) continue;

        const catchRadius = pocketCatchRadius(pocket, speed);
        if (dist < catchRadius) {
          pocketBall(ball);
          break;
        }

        const falloff = (pullRadius - dist) / (pullRadius - catchRadius);
        const slowBias = 0.55 + clamp((520 - speed) / 520, 0, 1) * 0.45;
        const accel = FEEL.pocketPull * falloff * falloff * slowBias;
        const nx = dx / dist;
        const ny = dy / dist;
        velocity.x += nx * accel * dt;
        velocity.y += ny * accel * dt;

        const tx = -ny;
        const ty = nx;
        const tangent = velocity.x * tx + velocity.y * ty;
        const damp = clamp(falloff * FEEL.pocketTangentialDamp * dt, 0, 0.24);
        velocity.x -= tx * tangent * damp;
        velocity.y -= ty * tangent * damp;
      }
    }
  }

  function inHorizontalPocketOpening(x) {
    const gap = TABLE.pocketR + TABLE.ballR * 1.05;
    return [TABLE.left, TABLE.midX, TABLE.right].some((targetX) => Math.abs(x - targetX) < gap);
  }

  function inVerticalPocketOpening(y) {
    const gap = TABLE.pocketR + TABLE.ballR * 1.05;
    return [TABLE.top, TABLE.bottom].some((targetY) => Math.abs(y - targetY) < gap);
  }

  function resolveCushion(ball) {
    if (ball.pocketed) return;
    const body = ball.body;
    const p = body.position;
    const v = body.velocity;
    const r = TABLE.ballR;
    const bounce = clamp(
      FEEL.cushionBaseBounce + ballSpeed(ball) * 0.000055,
      FEEL.cushionBaseBounce,
      FEEL.cushionMaxBounce,
    );

    if (p.y - r < TABLE.top && !inHorizontalPocketOpening(p.x)) {
      p.y = TABLE.top + r;
      if (v.y < 0) {
        v.y = -v.y * bounce;
        v.x *= FEEL.cushionTangentialDrag;
      }
    }
    if (p.y + r > TABLE.bottom && !inHorizontalPocketOpening(p.x)) {
      p.y = TABLE.bottom - r;
      if (v.y > 0) {
        v.y = -v.y * bounce;
        v.x *= FEEL.cushionTangentialDrag;
      }
    }
    if (p.x - r < TABLE.left && !inVerticalPocketOpening(p.y)) {
      p.x = TABLE.left + r;
      if (v.x < 0) {
        v.x = -v.x * bounce;
        v.y *= FEEL.cushionTangentialDrag;
      }
    }
    if (p.x + r > TABLE.right && !inVerticalPocketOpening(p.y)) {
      p.x = TABLE.right - r;
      if (v.x > 0) {
        v.x = -v.x * bounce;
        v.y *= FEEL.cushionTangentialDrag;
      }
    }
  }

  function containLooseBalls() {
    for (const ball of state.balls) {
      if (ball.pocketed) continue;
      const position = ball.body.position;
      if (
        position.x < TABLE.left - 58 ||
        position.x > TABLE.right + 58 ||
        position.y < TABLE.top - 58 ||
        position.y > TABLE.bottom + 58
      ) {
        setPosition(ball.body, {
          x: clamp(position.x, TABLE.left + TABLE.ballR, TABLE.right - TABLE.ballR),
          y: clamp(position.y, TABLE.top + TABLE.ballR, TABLE.bottom - TABLE.ballR),
        });
        setVelocity(ball.body, {
          x: -ball.body.velocity.x * 0.6,
          y: -ball.body.velocity.y * 0.6,
        });
      }
    }
  }

  function resolveBallCollisions() {
    const minDistance = TABLE.ballR * 2;
    for (let pass = 0; pass < FEEL.collisionIterations; pass += 1) {
      const balls = visibleBalls();
      for (let i = 0; i < balls.length; i += 1) {
        for (let j = i + 1; j < balls.length; j += 1) {
          const a = balls[i];
          const b = balls[j];
          const pa = a.body.position;
          const pb = b.body.position;
          let dx = pb.x - pa.x;
          let dy = pb.y - pa.y;
          let dist = Math.hypot(dx, dy);
          if (dist <= 0.0001) {
            dx = 1;
            dy = 0;
            dist = 1;
          }
          if (dist >= minDistance) continue;

          const nx = dx / dist;
          const ny = dy / dist;
          const overlap = minDistance - dist;
          const correction = overlap * 0.5;
          pa.x -= nx * correction;
          pa.y -= ny * correction;
          pb.x += nx * correction;
          pb.y += ny * correction;

          const va = a.body.velocity;
          const vb = b.body.velocity;
          const rel = (va.x - vb.x) * nx + (va.y - vb.y) * ny;
          if (rel <= 0) continue;

          const impulse = rel * FEEL.collisionRestitution;
          va.x -= impulse * nx;
          va.y -= impulse * ny;
          vb.x += impulse * nx;
          vb.y += impulse * ny;

          const tx = -ny;
          const ty = nx;
          const tangentRel = (va.x - vb.x) * tx + (va.y - vb.y) * ty;
          const throwImpulse = tangentRel * FEEL.collisionThrow;
          va.x -= throwImpulse * tx;
          va.y -= throwImpulse * ty;
          vb.x += throwImpulse * tx;
          vb.y += throwImpulse * ty;
        }
      }
    }
  }

  function applyDamping(dt) {
    const decay = Math.pow(FEEL.rollDecayPerFrame, dt * 60);
    for (const ball of state.balls) {
      if (ball.pocketed) continue;
      const velocity = ball.body.velocity;
      const speed = Math.hypot(velocity.x, velocity.y);
      if (speed < FEEL.stopSpeed) {
        setVelocity(ball.body, { x: 0, y: 0 });
        setAngularVelocity(ball.body, 0);
      } else {
        const nextSpeed = Math.max(0, speed * decay - FEEL.rollDrag * dt);
        if (nextSpeed < FEEL.stopSpeed) {
          setVelocity(ball.body, { x: 0, y: 0 });
          setAngularVelocity(ball.body, 0);
          continue;
        }
        const scale = nextSpeed / speed;
        velocity.x *= scale;
        velocity.y *= scale;
        ball.body.angularVelocity = (ball.body.angularVelocity * decay + nextSpeed / 180) * 0.5;
      }
    }
  }

  function simulatePhysics(dt) {
    applyPocketForces(dt);
    for (const ball of state.balls) {
      if (ball.pocketed) continue;
      ball.body.position.x += ball.body.velocity.x * dt;
      ball.body.position.y += ball.body.velocity.y * dt;
    }
    handlePockets();
    for (const ball of state.balls) resolveCushion(ball);
    resolveBallCollisions();
    containLooseBalls();
    applyDamping(dt);
    handlePockets();
  }

  function resolvePractice(pottedObjects, cueDown) {
    const player = currentPlayer();
    scorePlayer(player, pottedObjects.length);
    if (cueDown) {
      resetCueBall();
      state.message = "白球落袋，已复位";
    } else if (pottedObjects.length) {
      state.message = `进 ${pottedObjects.length} 球`;
    } else {
      state.message = "继续练习";
    }
    if (!objectBalls().length) {
      setWinner(player, "清台完成");
    }
  }

  function resolveEightBall(pottedObjects, cueDown) {
    const player = currentPlayer();
    const opponent = opponentPlayer();
    const eightDown = pottedObjects.some((ball) => ball.kind === "eight");
    const regularPotted = pottedObjects.filter((ball) => ball.kind !== "eight");

    if (!state.groups[player.id]) {
      const firstGroup = regularPotted
        .map(numberedPoolGroup)
        .find((group) => group === "solid" || group === "stripe");
      if (firstGroup && state.players.length > 1) {
        state.groups[player.id] = firstGroup;
        state.groups[opponent.id] = firstGroup === "solid" ? "stripe" : "solid";
        player.group = state.groups[player.id];
        opponent.group = state.groups[opponent.id];
        addLog(`${player.name} 选择 ${groupName(firstGroup)}`);
      }
    }

    if (eightDown) {
      const ownGroup = state.groups[player.id];
      const cleared = ownGroup && remainingGroupBalls(ownGroup).length === 0;
      if (cleared && !cueDown) {
        scorePlayer(player, 8);
        setWinner(player, `${player.name} 打进 8 号获胜`);
      } else {
        setWinner(opponent, `8 号过早落袋，${opponent.name} 获胜`);
      }
      return;
    }

    const ownGroup = state.groups[player.id];
    const ownPotted = regularPotted.filter((ball) => {
      if (!ownGroup) return ball.kind === "solid" || ball.kind === "stripe";
      return numberedPoolGroup(ball) === ownGroup;
    });

    scorePlayer(player, ownPotted.length);
    if (cueDown) {
      resetCueBall();
      advanceTurn();
      state.message = "白球落袋，交换球权";
    } else if (ownPotted.length) {
      state.message = `${player.name} 继续出杆`;
    } else {
      advanceTurn();
      state.message = "未进目标球，交换球权";
    }
  }

  function resolveNineBall(pottedObjects, cueDown) {
    const player = currentPlayer();
    const opponent = opponentPlayer();
    const nineDown = pottedObjects.some((ball) => ball.number === 9);
    const points = pottedObjects.length;
    scorePlayer(player, points);

    if (nineDown && !cueDown) {
      setWinner(player, `${player.name} 打进 9 号获胜`);
      return;
    }

    if (cueDown) {
      scorePlayer(opponent, 1);
      resetCueBall();
      advanceTurn();
      state.message = "白球落袋，交换球权";
      return;
    }

    if (points) {
      const next = lowestNineBall();
      state.message = next ? `${player.name} 继续，目标 ${next} 号` : "清台完成";
    } else {
      advanceTurn();
      state.message = "未进球，交换球权";
    }

    if (!objectBalls().length) {
      setWinner(player, `${player.name} 清台获胜`);
    }
  }

  function resolveSnooker(pottedObjects, cueDown) {
    const player = currentPlayer();
    const opponent = opponentPlayer();
    const points = pottedObjects.reduce((sum, ball) => sum + (ball.points || 0), 0);
    scorePlayer(player, points);

    if (cueDown) {
      scorePlayer(opponent, 4);
      resetCueBall();
      advanceTurn();
      state.message = `白球落袋，${opponent.name} 加 4 分`;
    } else if (points) {
      state.message = `${player.name} 得 ${points} 分`;
    } else {
      advanceTurn();
      state.message = "未进球，交换球权";
    }

    if (!objectBalls().length || snookerRemainingPoints() === 0) {
      const winner =
        state.players.reduce((best, playerItem) =>
          playerItem.score > best.score ? playerItem : best,
        ) || player;
      setWinner(winner, `${winner.name} 得分领先`);
    }
  }

  function resolveShot() {
    const ids = [...new Set(state.pottedThisShot)];
    const pottedObjects = ids
      .map(getBall)
      .filter((ball) => ball && ball.id !== "cue");
    const cueDown = ids.includes("cue");
    const player = currentPlayer();
    const potText = pottedObjects.length
      ? pottedObjects
          .map((ball) => ball.number || ball.id.replace("-", " "))
          .join(", ")
      : "无";

    state.shotInProgress = false;
    state.pottedThisShot = [];
    addLog(`${player?.name || "玩家"}: ${potText}`);

    if (state.mode === "practice") resolvePractice(pottedObjects, cueDown);
    else if (state.mode === "nine") resolveNineBall(pottedObjects, cueDown);
    else if (state.mode === "snooker") resolveSnooker(pottedObjects, cueDown);
    else resolveEightBall(pottedObjects, cueDown);

    if (!state.gameOver && currentPlayer() && !state.message.includes("出杆")) {
      state.message += ` · ${currentPlayer().name} 出杆`;
    }
    updateHud();
    broadcastSnapshot(true);
  }

  function shotTargetLabel() {
    if (state.mode === "nine") {
      const target = lowestNineBall();
      return target ? `目标 ${target} 号` : "等待清台";
    }
    if (state.mode === "eight") {
      const player = currentPlayer();
      const group = player ? state.groups[player.id] : null;
      return group ? `${groupName(group)}目标` : "开放球台";
    }
    if (state.mode === "snooker") return "冲分";
    return "自由练习";
  }

  function applyShot(shot, playerId = currentPlayer()?.id) {
    const player = currentPlayer();
    const cue = cueBall();
    if (!cue || !player || state.gameOver || state.shotInProgress || !allStopped()) {
      return false;
    }
    if (playerId && player.id !== playerId && state.players.length > 1) {
      return false;
    }

    const angle = Number.isFinite(shot?.angle) ? shot.angle : state.aim.angle;
    const power = clamp(Number.isFinite(shot?.power) ? shot.power : state.aim.power, 0.08, 1);
    const shapedPower = Math.pow(power, FEEL.shotPowerCurve);
    const openingBoost = state.shotNumber === 0 && power > 0.92 ? FEEL.breakBoost : 0;
    const speed = FEEL.shotMinSpeed + shapedPower * (FEEL.shotMaxSpeed - FEEL.shotMinSpeed) + openingBoost;

    state.aim.angle = angle;
    state.aim.power = power;
    state.shotInProgress = true;
    state.pottedThisShot = [];
    state.shotNumber += 1;
    state.targetAtShot = shotTargetLabel();
    state.message = `${player.name} 出杆`;
    setVelocity(cue.body, {
      x: Math.cos(angle) * speed,
      y: Math.sin(angle) * speed,
    });
    setAngularVelocity(cue.body, power * 7);
    updateHud();
    broadcastSnapshot(true);
    return true;
  }

  function shootCurrent() {
    if (!canControlCurrentPlayer()) return;
    const player = currentPlayer();
    const shot = {
      angle: state.aim.angle,
      power: state.aim.power,
      shotNumber: state.shotNumber + 1,
    };

    if (state.online.active && !state.online.isHost) {
      state.online.socket?.emit("game:shot", { shot });
      state.message = "出杆已发送";
      updateHud();
      return;
    }
    applyShot(shot, player?.id);
  }

  function step(dt) {
    handleKeyboardAim(dt);
    if (!shouldSimulate()) return;

    const capped = Math.min(dt, 0.05);
    const substeps = Math.max(1, Math.ceil(capped / (1 / 240)));
    for (let i = 0; i < substeps; i += 1) {
      simulatePhysics(capped / substeps);
    }

    if (state.shotInProgress && allStopped()) {
      resolveShot();
    }
    broadcastSnapshot(false);
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * TABLE.width,
      y: ((event.clientY - rect.top) / rect.height) * TABLE.height,
    };
  }

  function updateAimFromPoint(point) {
    const cue = cueBall();
    if (!cue || cue.pocketed) return;
    const cuePos = cue.body.position;
    state.aim.angle = Math.atan2(point.y - cuePos.y, point.x - cuePos.x);
    state.aim.power = clamp(
      Math.pow(distance(point, cuePos) / FEEL.aimPowerDistance, FEEL.aimPowerCurve),
      0.08,
      1,
    );
    updateHud();
  }

  function handleKeyboardAim(dt) {
    if (!canControlCurrentPlayer()) return;
    const precision = state.keys.has("ShiftLeft") || state.keys.has("ShiftRight") ? 0.35 : 1;
    const turnSpeed = 2.3 * precision;
    const powerSpeed = 0.68 * precision;
    if (state.keys.has("ArrowLeft")) state.aim.angle -= turnSpeed * dt;
    if (state.keys.has("ArrowRight")) state.aim.angle += turnSpeed * dt;
    if (state.keys.has("ArrowUp")) {
      state.aim.power = clamp(state.aim.power + powerSpeed * dt, 0.08, 1);
    }
    if (state.keys.has("ArrowDown")) {
      state.aim.power = clamp(state.aim.power - powerSpeed * dt, 0.08, 1);
    }
  }

  function serializeSnapshot() {
    return {
      version: 1,
      mode: state.mode,
      turnIndex: state.turnIndex,
      players: state.players.map((player) => ({
        id: player.id,
        name: player.name,
        score: player.score,
        group: player.group || null,
        host: Boolean(player.host),
      })),
      groups: state.groups,
      shotNumber: state.shotNumber,
      shotInProgress: state.shotInProgress,
      gameOver: state.gameOver,
      winnerId: state.winnerId,
      message: state.message,
      aim: { ...state.aim, dragging: false, pointerId: null },
      balls: state.balls.map((ball) => ({
        id: ball.id,
        x: ball.body.position.x,
        y: ball.body.position.y,
        vx: ball.body.velocity.x,
        vy: ball.body.velocity.y,
        pocketed: ball.pocketed,
      })),
      log: state.shotLog.slice(0, 8),
    };
  }

  function applySnapshot(snapshot) {
    if (!snapshot || snapshot.version !== 1) return;
    if (
      snapshot.mode !== state.mode ||
      snapshot.balls.length !== state.balls.length ||
      snapshot.balls.some((ball) => !getBall(ball.id))
    ) {
      rackMode(snapshot.mode, {
        keepPlayers: true,
        keepScores: true,
        quiet: true,
      });
    }

    state.mode = snapshot.mode;
    state.turnIndex = snapshot.turnIndex || 0;
    state.groups = snapshot.groups || {};
    state.shotNumber = snapshot.shotNumber || 0;
    state.shotInProgress = Boolean(snapshot.shotInProgress);
    state.gameOver = Boolean(snapshot.gameOver);
    state.winnerId = snapshot.winnerId || null;
    state.message = snapshot.message || state.message;
    state.shotLog = snapshot.log || state.shotLog;
    state.aim.angle = snapshot.aim?.angle ?? state.aim.angle;
    state.aim.power = snapshot.aim?.power ?? state.aim.power;

    if (Array.isArray(snapshot.players) && snapshot.players.length) {
      state.players = snapshot.players.map((player) => ({ ...player }));
    }

    snapshot.balls.forEach((remote) => {
      const ball = getBall(remote.id);
      if (!ball) return;
      if (remote.pocketed) {
        setPocketed(ball, true);
      } else {
        ball.pocketed = false;
        setPosition(ball.body, { x: remote.x, y: remote.y });
        setVelocity(ball.body, { x: remote.vx, y: remote.vy });
      }
    });
    state.online.waitingForHost = false;
    updateHud();
  }

  function broadcastSnapshot(force = false) {
    const online = state.online;
    if (!online.active || !online.isHost || !online.socket?.connected) return;
    const now = performance.now();
    if (!force && now - online.lastSnapshotAt < 80) return;
    online.socket.emit("game:snapshot", { snapshot: serializeSnapshot() });
    online.lastSnapshotAt = now;
  }

  function createRoomSocket() {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    let nextRequestId = 1;
    const handlers = new Map();
    const pending = new Map();
    const api = {
      connected: false,
      on(type, handler) {
        handlers.set(type, handler);
      },
      emit(type, payload = {}) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type, payload }));
      },
      request(type, payload = {}) {
        const requestId = String(nextRequestId);
        nextRequestId += 1;
        return new Promise((resolve) => {
          pending.set(requestId, resolve);
          if (ws.readyState !== WebSocket.OPEN) {
            pending.delete(requestId);
            resolve({ ok: false, error: "联机未连接" });
            return;
          }
          ws.send(JSON.stringify({ type, payload, requestId }));
          window.setTimeout(() => {
            if (!pending.has(requestId)) return;
            pending.delete(requestId);
            resolve({ ok: false, error: "联机响应超时" });
          }, 5000);
        });
      },
    };

    ws.addEventListener("open", () => {
      api.connected = true;
      updateHud();
    });
    ws.addEventListener("close", () => {
      api.connected = false;
      state.online.active = false;
      state.online.isHost = false;
      state.online.roomCode = null;
      state.online.waitingForHost = false;
      state.message = "联机已断开";
      updateHud();
    });
    ws.addEventListener("message", (event) => {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "reply" && message.requestId && pending.has(message.requestId)) {
        const resolve = pending.get(message.requestId);
        pending.delete(message.requestId);
        resolve(message.payload);
        return;
      }
      const handler = handlers.get(message.type);
      if (handler) handler(message.payload);
    });
    return api;
  }

  function applyRoom(room) {
    if (!room) return;
    const online = state.online;
    online.active = true;
    online.roomCode = room.code;
    online.isHost = room.hostId === online.socketId;

    const previous = new Map(state.players.map((player) => [player.id, player]));
    state.players = room.players.map((player) => ({
      id: player.id,
      name: player.name,
      host: player.host,
      score: previous.get(player.id)?.score || 0,
      group: previous.get(player.id)?.group || null,
    }));
    if (state.turnIndex >= state.players.length) state.turnIndex = 0;

    if (room.mode !== state.mode) {
      rackMode(room.mode, {
        keepPlayers: true,
        keepScores: false,
        quiet: !online.isHost,
      });
      if (!online.isHost) online.waitingForHost = true;
    }

    if (online.isHost) {
      broadcastSnapshot(true);
    }
    updateHud();
  }

  function setupNetwork() {
    if (!("WebSocket" in window)) {
      ui.roomInfo.textContent = "当前浏览器不支持联机";
      return;
    }
    const socket = createRoomSocket();
    state.online.socket = socket;

    socket.on("hello", ({ socketId }) => {
      state.online.socketId = socketId;
      updateHud();
    });

    socket.on("room:update", (room) => {
      applyRoom(room);
    });

    socket.on("room:host", () => {
      state.online.isHost = true;
      state.message = "你现在是房主";
      broadcastSnapshot(true);
      updateHud();
    });

    socket.on("game:remote-shot", ({ playerId, shot }) => {
      if (!state.online.isHost) return;
      applyShot(shot, playerId);
    });

    socket.on("game:snapshot", (snapshot) => {
      if (state.online.isHost) return;
      applySnapshot(snapshot);
    });
  }

  async function createRoom() {
    const socket = state.online.socket;
    if (!socket?.connected) return;
    localStorage.setItem("break-room-name", ui.playerName.value.trim() || "Player");
    const reply = await socket.request("room:create", {
      name: ui.playerName.value,
      mode: state.mode,
    });
    if (!reply?.ok) {
      state.message = reply?.error || "创建房间失败";
      updateHud();
      return;
    }
    state.online.socketId = reply.socketId;
    applyRoom(reply.room);
  }

  async function joinRoom() {
    const socket = state.online.socket;
    if (!socket?.connected) return;
    const code = ui.roomCodeInput.value.trim().toUpperCase();
    if (!code) return;
    localStorage.setItem("break-room-name", ui.playerName.value.trim() || "Player");
    const reply = await socket.request("room:join", {
      code,
      name: ui.playerName.value,
    });
    if (!reply?.ok) {
      state.message = reply?.error || "加入房间失败";
      updateHud();
      return;
    }
    state.online.socketId = reply.socketId;
    applyRoom(reply.room);
  }

  function leaveRoom() {
    state.online.socket?.emit("room:leave");
    state.online.active = false;
    state.online.isHost = false;
    state.online.roomCode = null;
    state.online.waitingForHost = false;
    rackMode(state.mode);
  }

  function changeMode(mode) {
    if (!MODES[mode]) return;
    if (state.online.active && !state.online.isHost) return;
    rackMode(mode);
    if (state.online.active && state.online.isHost) {
      state.online.socket?.emit("room:mode", { mode });
      broadcastSnapshot(true);
    }
  }

  function updateHud() {
    const player = currentPlayer();
    ui.statusText.textContent =
      state.online.waitingForHost && !state.online.isHost
        ? "等待房主同步球台"
        : state.gameOver
          ? state.message
          : state.message;
    ui.targetText.textContent = shotTargetLabel();
    ui.roomBadge.textContent = state.online.active
      ? `${state.online.roomCode} · ${state.online.isHost ? "房主" : "客人"}`
      : "本地";

    ui.powerFill.style.width = `${Math.round(state.aim.power * 100)}%`;
    ui.powerValue.textContent = `${Math.round(state.aim.power * 100)}%`;
    ui.shootButton.disabled = !canControlCurrentPlayer();
    ui.leaveRoomButton.disabled = !state.online.active;

    ui.modeButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === state.mode);
      button.disabled = state.online.active && !state.online.isHost;
    });

    ui.scoreStrip.replaceChildren(
      ...state.players.map((playerItem, index) => {
        const chip = document.createElement("div");
        chip.className = `score-chip${index === state.turnIndex ? " active" : ""}`;
        const head = document.createElement("span");
        head.className = "score-head";
        head.append(makeIcon(index === state.turnIndex ? "crosshair" : "circle"));
        const score = document.createElement("strong");
        score.textContent = String(playerItem.score);
        head.append(score);
        const name = document.createElement("span");
        name.className = "score-name";
        const group = playerItem.group ? ` · ${groupName(playerItem.group)}` : "";
        name.textContent = `${playerLabel(playerItem)}${group}`;
        chip.append(head, name);
        return chip;
      }),
    );

    ui.playersList.replaceChildren(
      ...state.players.map((playerItem, index) => {
        const row = document.createElement("div");
        row.className = `player-row${index === state.turnIndex ? " active" : ""}`;
        row.append(makeIcon(index === state.turnIndex ? "crosshair" : "user"));
        const name = document.createElement("strong");
        name.textContent = playerLabel(playerItem);
        const score = document.createElement("span");
        score.textContent = `${playerItem.score} 分`;
        row.append(name, score);
        return row;
      }),
    );

    ui.shotLog.replaceChildren(
      ...state.shotLog.slice(0, 4).map((line) => {
        const item = document.createElement("li");
        item.textContent = line;
        return item;
      }),
    );

    if (state.online.active) {
      const names = state.players.map((item) => item.name).join(" / ");
      ui.roomInfo.textContent = `${state.online.roomCode} · ${names || "等待"}`;
    } else if (state.online.socket?.connected) {
      ui.roomInfo.textContent = "在线服务已连接";
    } else {
      ui.roomInfo.textContent = "连接中";
    }
    stateMirror.textContent = renderGameToText();
    refreshIcons();
  }

  function drawRoundedRect(x, y, width, height, radius) {
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, width, height, radius);
    } else {
      const r = Math.min(radius, width / 2, height / 2);
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + width, y, x + width, y + height, r);
      ctx.arcTo(x + width, y + height, x, y + height, r);
      ctx.arcTo(x, y + height, x, y, r);
      ctx.arcTo(x, y, x + width, y, r);
    }
  }

  function drawTable() {
    ctx.clearRect(0, 0, TABLE.width, TABLE.height);
    ctx.fillStyle = "#0a0d10";
    ctx.fillRect(0, 0, TABLE.width, TABLE.height);

    const railGradient = ctx.createLinearGradient(0, 0, TABLE.width, TABLE.height);
    railGradient.addColorStop(0, "#8b542e");
    railGradient.addColorStop(0.45, "#4d2918");
    railGradient.addColorStop(1, "#9a6438");
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
    ctx.shadowBlur = 28;
    ctx.shadowOffsetY = 16;
    drawRoundedRect(20, 20, 960, 480, 26);
    ctx.fillStyle = railGradient;
    ctx.fill();
    ctx.restore();

    drawRoundedRect(
      TABLE.left - 18,
      TABLE.top - 18,
      TABLE.right - TABLE.left + 36,
      TABLE.bottom - TABLE.top + 36,
      22,
    );
    ctx.fillStyle = "#1b1713";
    ctx.fill();

    const clothGradient = ctx.createLinearGradient(TABLE.left, TABLE.top, TABLE.right, TABLE.bottom);
    clothGradient.addColorStop(0, "#159575");
    clothGradient.addColorStop(0.55, "#0f765f");
    clothGradient.addColorStop(1, "#0b5f54");
    drawRoundedRect(
      TABLE.left,
      TABLE.top,
      TABLE.right - TABLE.left,
      TABLE.bottom - TABLE.top,
      16,
    );
    ctx.fillStyle = clothGradient;
    ctx.fill();

    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(214, TABLE.top + 4);
    ctx.lineTo(214, TABLE.bottom - 4);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(214, TABLE.midY, 72, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 255, 255, 0.24)";
    [
      [214, TABLE.midY],
      [TABLE.midX, TABLE.midY],
      [682, TABLE.midY],
      [822, TABLE.midY],
    ].forEach(([x, y]) => {
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();

    for (const pocket of POCKETS) {
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.72)";
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(pocket.x, pocket.y, TABLE.pocketR + 3, 0, Math.PI * 2);
      ctx.fillStyle = "#07080a";
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(pocket.x, pocket.y, TABLE.pocketR - 7, 0, Math.PI * 2);
      ctx.fillStyle = "#020304";
      ctx.fill();
    }

    ctx.fillStyle = "rgba(247, 239, 226, 0.72)";
    [160, 310, 690, 840].forEach((x) => {
      ctx.beginPath();
      ctx.arc(x, 37, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, 483, 3, 0, Math.PI * 2);
      ctx.fill();
    });
    [142, 260, 380].forEach((y) => {
      ctx.beginPath();
      ctx.arc(38, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(962, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function traceAimPath(origin, dx, dy, maxDistance) {
    const r = TABLE.ballR;
    const bounds = {
      left: TABLE.left + r,
      right: TABLE.right - r,
      top: TABLE.top + r,
      bottom: TABLE.bottom - r,
    };
    let best = {
      type: "free",
      distance: maxDistance,
      x: origin.x + dx * maxDistance,
      y: origin.y + dy * maxDistance,
      ball: null,
    };

    const railHits = [
      dx > 0 ? (bounds.right - origin.x) / dx : Infinity,
      dx < 0 ? (bounds.left - origin.x) / dx : Infinity,
      dy > 0 ? (bounds.bottom - origin.y) / dy : Infinity,
      dy < 0 ? (bounds.top - origin.y) / dy : Infinity,
    ];
    const railDistance = Math.min(...railHits.filter((value) => value > 0));
    if (Number.isFinite(railDistance) && railDistance < best.distance) {
      best = {
        type: "rail",
        distance: railDistance,
        x: origin.x + dx * railDistance,
        y: origin.y + dy * railDistance,
        ball: null,
      };
    }

    for (const ball of visibleBalls()) {
      if (ball.id === "cue") continue;
      const target = ball.body.position;
      const ox = origin.x - target.x;
      const oy = origin.y - target.y;
      const b = 2 * (dx * ox + dy * oy);
      const c = ox * ox + oy * oy - (r * 2) ** 2;
      const discriminant = b * b - 4 * c;
      if (discriminant < 0) continue;
      const hitDistance = (-b - Math.sqrt(discriminant)) / 2;
      if (hitDistance <= r * 1.25 || hitDistance >= best.distance) continue;
      best = {
        type: "ball",
        distance: hitDistance,
        x: origin.x + dx * hitDistance,
        y: origin.y + dy * hitDistance,
        ball,
      };
    }

    return best;
  }

  function drawAim() {
    const cue = cueBall();
    if (!cue || cue.pocketed || !canControlCurrentPlayer()) return;
    const pos = cue.body.position;
    const dx = Math.cos(state.aim.angle);
    const dy = Math.sin(state.aim.angle);
    const power = state.aim.power;
    const guide = traceAimPath(pos, dx, dy, FEEL.guideLength);

    ctx.save();
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.56)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pos.x + dx * 18, pos.y + dy * 18);
    ctx.lineTo(guide.x, guide.y);
    ctx.stroke();
    ctx.setLineDash([]);

    if (guide.type === "ball" && guide.ball) {
      const target = guide.ball.body.position;
      const outDx = target.x - guide.x;
      const outDy = target.y - guide.y;
      const outLength = Math.hypot(outDx, outDy) || 1;
      const nx = outDx / outLength;
      const ny = outDy / outLength;
      ctx.strokeStyle = "rgba(95, 184, 255, 0.48)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(target.x + nx * 16, target.y + ny * 16);
      ctx.lineTo(target.x + nx * (74 + power * 70), target.y + ny * (74 + power * 70));
      ctx.stroke();
      ctx.fillStyle = "rgba(95, 184, 255, 0.18)";
      ctx.beginPath();
      ctx.arc(guide.x, guide.y, TABLE.ballR, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = "#c79652";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(pos.x - dx * (88 + power * 70), pos.y - dy * (88 + power * 70));
    ctx.lineTo(pos.x - dx * 20, pos.y - dy * 20);
    ctx.stroke();
    ctx.strokeStyle = "#e6c88e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pos.x - dx * (84 + power * 70), pos.y - dy * (84 + power * 70));
    ctx.lineTo(pos.x - dx * 22, pos.y - dy * 22);
    ctx.stroke();

    ctx.fillStyle = "rgba(95, 184, 255, 0.22)";
    ctx.beginPath();
    ctx.arc(pos.x + dx * 72, pos.y + dy * 72, 18 + power * 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawBall(ball) {
    if (ball.pocketed) return;
    const { x, y } = ball.body.position;
    const r = TABLE.ballR;

    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 4;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = ball.stripe ? COLORS.stripeBase : ball.color;
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.clip();
    if (ball.stripe) {
      ctx.fillStyle = ball.color;
      ctx.fillRect(x - r, y - r * 0.55, r * 2, r * 1.1);
    }
    const shine = ctx.createRadialGradient(x - r * 0.35, y - r * 0.45, 1, x, y, r);
    shine.addColorStop(0, "rgba(255, 255, 255, 0.82)");
    shine.addColorStop(0.22, "rgba(255, 255, 255, 0.12)");
    shine.addColorStop(1, "rgba(0, 0, 0, 0.25)");
    ctx.fillStyle = shine;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.restore();

    ctx.strokeStyle = "rgba(0, 0, 0, 0.34)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();

    if (ball.number !== null && ball.id !== "cue") {
      ctx.save();
      ctx.fillStyle = ball.kind === "eight" || ball.kind === "black" ? "#f3ecd8" : "#111820";
      ctx.font = "700 9px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(ball.number), x, y + 0.4);
      ctx.restore();
    }
  }

  function drawOverlay() {
    if (!state.online.waitingForHost && !state.gameOver) return;
    ctx.save();
    ctx.fillStyle = "rgba(5, 8, 10, 0.48)";
    ctx.fillRect(TABLE.left, TABLE.top, TABLE.right - TABLE.left, TABLE.bottom - TABLE.top);
    ctx.fillStyle = "#f7efe2";
    ctx.font = "800 26px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(state.message, TABLE.midX, TABLE.midY);
    ctx.restore();
  }

  function render() {
    drawTable();
    drawAim();
    visibleBalls()
      .sort((a, b) => (a.id === "cue" ? 1 : 0) - (b.id === "cue" ? 1 : 0))
      .forEach(drawBall);
    drawOverlay();
  }

  function renderGameToText() {
    const player = currentPlayer();
    const payload = {
      coordinateSystem:
        "table canvas coordinates, origin top-left, x increases right, y increases down, size 1000x520",
      mode: state.mode,
      modeLabel: modeLabel(),
      network: {
        active: state.online.active,
        roomCode: state.online.roomCode,
        isHost: state.online.isHost,
      },
      turn: {
        index: state.turnIndex,
        playerId: player?.id || null,
        playerName: player?.name || null,
        canShoot: canControlCurrentPlayer(),
      },
      aim: {
        angle: Number(state.aim.angle.toFixed(3)),
        power: Number(state.aim.power.toFixed(2)),
      },
      moving: !allStopped(),
      shotInProgress: state.shotInProgress,
      target: shotTargetLabel(),
      scores: state.players.map((item) => ({
        id: item.id,
        name: item.name,
        score: item.score,
        group: item.group || null,
      })),
      balls: state.balls
        .filter((ball) => !ball.pocketed)
        .map((ball) => ({
          id: ball.id,
          number: ball.number,
          kind: ball.kind,
          x: Math.round(ball.body.position.x),
          y: Math.round(ball.body.position.y),
          vx: Number(ball.body.velocity.x.toFixed(2)),
          vy: Number(ball.body.velocity.y.toFixed(2)),
        })),
      pocketed: state.balls
        .filter((ball) => ball.pocketed && ball.id !== "cue")
        .map((ball) => ball.id),
      gameOver: state.gameOver,
      winnerId: state.winnerId,
      message: state.message,
    };
    return JSON.stringify(payload, null, 2);
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (!canControlCurrentPlayer()) return;
    canvas.focus();
    state.aim.dragging = true;
    state.aim.pointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    updateAimFromPoint(canvasPoint(event));
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!state.aim.dragging || state.aim.pointerId !== event.pointerId) return;
    updateAimFromPoint(canvasPoint(event));
  });

  canvas.addEventListener("pointerup", (event) => {
    if (!state.aim.dragging || state.aim.pointerId !== event.pointerId) return;
    updateAimFromPoint(canvasPoint(event));
    state.aim.dragging = false;
    state.aim.pointerId = null;
    shootCurrent();
  });

  canvas.addEventListener("pointercancel", () => {
    state.aim.dragging = false;
    state.aim.pointerId = null;
  });

  window.addEventListener("keydown", (event) => {
    if (
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(event.code)
    ) {
      event.preventDefault();
    }
    if (event.key === "f" || event.key === "F") {
      if (!document.fullscreenElement) canvas.requestFullscreen?.();
      else document.exitFullscreen?.();
      return;
    }
    if (event.code === "Space") {
      shootCurrent();
      return;
    }
    state.keys.add(event.code);
  });

  window.addEventListener("keyup", (event) => {
    state.keys.delete(event.code);
  });

  ui.modeButtons.forEach((button) => {
    button.addEventListener("click", () => changeMode(button.dataset.mode));
  });
  ui.shootButton.addEventListener("click", shootCurrent);
  ui.resetButton.addEventListener("click", () => changeMode(state.mode));
  ui.createRoomButton.addEventListener("click", createRoom);
  ui.joinRoomButton.addEventListener("click", joinRoom);
  ui.leaveRoomButton.addEventListener("click", leaveRoom);
  ui.roomCodeInput.addEventListener("input", () => {
    ui.roomCodeInput.value = ui.roomCodeInput.value.toUpperCase();
  });
  ui.playerName.addEventListener("change", () => {
    localStorage.setItem("break-room-name", ui.playerName.value.trim() || "Player");
  });

  window.render_game_to_text = renderGameToText;
  window.advanceTime = async (ms) => {
    const steps = Math.max(1, Math.round(ms / (1000 / 60)));
    for (let i = 0; i < steps; i += 1) {
      step(1 / 60);
    }
    render();
    updateHud();
  };

  let last = performance.now();
  let hudTick = 0;
  function loop(now) {
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    step(dt);
    render();
    if (now - hudTick > 140) {
      updateHud();
      hudTick = now;
    }
    requestAnimationFrame(loop);
  }

  setupNetwork();
  rackMode("eight", { keepPlayers: false });
  render();
  updateHud();
  requestAnimationFrame(loop);
})();
