import { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useBestScore, getSyncCode, pushProgress } from '../core/sync';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { Portrait, preloadPortraits } from './Portrait';
import { sceneTheme } from './pixelart';
import { metaDragon } from '../core/gameMetas';

/** 角色立绘素材映射（AI 生成，深蓝底自动抠图；WebP 压缩版约为原 PNG 的 1/10） */
const PORTRAITS = '/portraits';
const HERO_PORTRAIT = `${PORTRAITS}/hero.webp`;
interface PortraitRef {
  src: string;
  /** 立绘显示高度（px），体现体型差异 */
  height: number;
  /** 是否水平镜像（让侧身角色面朝勇者） */
  flip?: boolean;
}
const MONSTER_PORTRAITS: Record<string, PortraitRef> = {
  史莱姆: { src: `${PORTRAITS}/slime.webp`, height: 120 },
  骷髅兵: { src: `${PORTRAITS}/skeleton.webp`, height: 155, flip: true },
  僵尸: { src: `${PORTRAITS}/zombie.webp`, height: 160, flip: true },
  暗影幽魂: { src: `${PORTRAITS}/ghost.webp`, height: 150 },
  火焰魔: { src: `${PORTRAITS}/firedemon.webp`, height: 190 },
  恶龙: { src: `${PORTRAITS}/dragon.webp`, height: 215 },
};

// 进入游戏即并发预下载+处理全部立绘（共约 40KB）：玩家看菜单的时间足够加载完，开战零等待
preloadPortraits([HERO_PORTRAIT, ...Object.values(MONSTER_PORTRAITS).map((p) => p.src)]);



const FLOORS = 10;
const SAVE_KEY = 'dq:save';

interface PlayerState {
  level: number;
  xp: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  atk: number;
  def: number;
  gold: number;
  kills: number;
}

interface Monster {
  name: string;
  emoji: string;
  hp: number;
  maxHp: number;
  atk: number;
  def: number;
  xp: number;
  gold: number;
  isBoss: boolean;
}

type Phase = 'menu' | 'battle' | 'idle' | 'town' | 'dead' | 'victory';

const PLAYER_START: PlayerState = {
  level: 1,
  xp: 0,
  hp: 60,
  maxHp: 60,
  mp: 10,
  maxMp: 10,
  atk: 8,
  def: 3,
  gold: 0,
  kills: 0,
};

const MONSTERS = [
  { name: '史莱姆', emoji: '🟢' },
  { name: '骷髅兵', emoji: '💀' },
  { name: '僵尸', emoji: '🧟' },
  { name: '暗影幽魂', emoji: '👻' },
  { name: '火焰魔', emoji: '👹' },
];

/** 按楼层生成怪物（第 10 层为恶龙 Boss） */
function makeMonster(floor: number): Monster {
  if (floor >= FLOORS) {
    return { name: '恶龙', emoji: '🐉', hp: 130, maxHp: 130, atk: 15, def: 7, xp: 200, gold: 300, isBoss: true };
  }
  const base = MONSTERS[Math.floor((floor - 1) / 2)] ?? MONSTERS[MONSTERS.length - 1];
  // 成长曲线放缓：5-9 层有压力但配合升级/治疗可过（过陡会让第 9 层变成必死墙）
  const scale = 1 + floor * 0.25;
  return {
    name: base.name,
    emoji: base.emoji,
    hp: Math.round((14 + floor * 5) * scale),
    maxHp: Math.round((14 + floor * 5) * scale),
    atk: Math.round(2 + floor * 1.6),
    def: Math.round(1 + floor * 0.7),
    xp: 10 + floor * 8,
    gold: 10 + floor * 8,
    isBoss: false,
  };
}

function xpNeed(level: number): number {
  return level * 22;
}

function loadSave(): { floor: number; player: PlayerState } | null {
  try {
    const raw = localStorage.getItem(`pp:${SAVE_KEY}`);
    return raw ? (JSON.parse(raw) as { floor: number; player: PlayerState }) : null;
  } catch {
    return null;
  }
}

function saveGame(floor: number, player: PlayerState): void {
  try {
    localStorage.setItem(`pp:${SAVE_KEY}`, JSON.stringify({ floor, player }));
  } catch {
    /* ignore */
  }
  // 已连接云同步时自动上传存档（服务端按优劣合并）
  const code = getSyncCode();
  if (code) pushProgress(code).catch(() => { /* 离线静默 */ });
}

function clearSave(): void {
  try {
    localStorage.removeItem(`pp:${SAVE_KEY}`);
  } catch {
    /* ignore */
  }
  // 通关/死亡/新开局时同步上传本机存档状态（云端始终保留多设备中最优存档，不会因某台设备清档而被删除）
  const code = getSyncCode();
  if (code) pushProgress(code).catch(() => { /* 离线静默 */ });
}

const rand = (n: number) => Math.floor(Math.random() * (n + 1));

export default function DragonQuest() {
  const [phase, setPhase] = useState<Phase>('menu');
  const [floor, setFloor] = useState(1);
  const [player, setPlayer] = useState<PlayerState>(PLAYER_START);
  const [monster, setMonster] = useState<Monster | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // player 的实时快照：治疗链 350ms 后调用的 monsterAttack 若读渲染闭包里的旧 hp，
  // 会用"回血前"的 HP 判死（HP5→治疗后19→被打12→闭包算出-7 误杀），必须读最新值
  const playerRef = useRef(player);
  playerRef.current = player;
  // busy 的同步 ref 守卫：setBusy 后到重渲染完成前，state 闭包里的 busy 仍是旧值，
  // 键盘 auto-repeat（约 30 次/秒）可在同一帧内双触发战斗动作，造成双倍反击/结算覆盖
  const busyRef = useRef(false);
  // phase 的实时快照：定时器链（反击延迟 450ms+）里的闭包 phase 已过期，
  // 怪物死亡切幕后迟到的 monsterAttack 必须靠它拦截
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [battleNo, setBattleNo] = useState(0);
  const [heroAnim, setHeroAnim] = useState<'idle' | 'attack' | 'hurt'>('idle');
  const [monsterAnim, setMonsterAnim] = useState<'idle' | 'attack' | 'hit' | 'dead'>('idle');
  const [floaters, setFloaters] = useState<Array<{ id: number; text: string; kind: 'hero' | 'monster' }>>([]);
  const [saveExists, setSaveExists] = useState(loadSave() !== null);
  const best = useBestScore(metaDragon.id);
  const { toast } = useToast();

  /** 飘字定时器句柄（卸载时清理，避免对已卸载组件 setState） */
  const floaterTimersRef = useRef<number[]>([]);
  /** 战斗链定时器句柄 + 挂载守卫：中途离页后迟到回调不得再结算音效/弹层/抹档 */
  const chainTimersRef = useRef<number[]>([]);
  const mountedRef = useRef(true);
  const later = (fn: () => void, ms: number) => {
    const t = window.setTimeout(() => {
      if (mountedRef.current) fn();
    }, ms);
    chainTimersRef.current.push(t);
  };
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      floaterTimersRef.current.forEach((t) => window.clearTimeout(t));
      floaterTimersRef.current = [];
      chainTimersRef.current.forEach((t) => window.clearTimeout(t));
      chainTimersRef.current = [];
    };
  }, []);

  /** 伤害飘字（monster=怪物受击，hero=勇者受击） */
  const addFloater = useCallback((text: string, kind: 'hero' | 'monster') => {
    const id = Date.now() + Math.random();
    setFloaters((prev) => [...prev.slice(-5), { id, text, kind }]);
    const t = window.setTimeout(() => setFloaters((prev) => prev.filter((f) => f.id !== id)), 950);
    floaterTimersRef.current.push(t);
  }, []);

  const pushLog = useCallback((msg: string) => {
    setLog((prev) => [...prev.slice(-5), msg]);
  }, []);

  /** 开始新冒险 */
  const newGame = () => {
    clearSave();
    setSaveExists(false);
    setPlayer(PLAYER_START);
    setFloor(1);
    setLog([]);
    startBattle(1, PLAYER_START);
  };

  /** 继续冒险 */
  const continueGame = () => {
    const save = loadSave();
    if (!save) return;
    setPlayer(save.player);
    setFloor(save.floor);
    setLog([]);
    pushLog(`欢迎回来！从第 ${save.floor} 层继续冒险`);
    startBattle(save.floor, save.player);
  };

  /** 进入战斗 */
  const startBattle = (f: number, _p: PlayerState) => {
    busyRef.current = false;
    setMonster(makeMonster(f));
    setBattleNo((n) => n + 1);
    setPhase('battle');
    setBusy(false);
    setHeroAnim('idle');
    setMonsterAnim('idle');
    sfx.flip();
  };

  /** 进入新楼层并记录最高层数 */
  const nextFloor = () => {
    const f = floor + 1;
    setFloor(f);
    const isNew = best.updateBest(f, (a, b) => a > b);
    if (isNew) {
      sfx.record();
      toast(`新纪录！到达第 ${f} 层`, 'record');
    }
    pushLog(`你来到了第 ${f} 层……`);
    startBattle(f, player);
  };

  /** 怪物回合（统一入口，从渲染闭包读取最新状态） */
  const monsterAttack = (dmgReduction = 1) => {
    // 战斗已结束（胜利/死亡/逃回城镇）时，定时器链里迟到的反击直接作废
    if (phaseRef.current !== 'battle' || !monster) return;
    const cur = playerRef.current;
    let dmg = Math.max(1, monster.atk + rand(2) - cur.def);
    if (dmgReduction > 1) dmg = Math.max(1, Math.floor(dmg / dmgReduction));
    const newHp = cur.hp - dmg;
    pushLog(`${monster.emoji} ${monster.name} 攻击了你，造成 ${dmg} 点伤害`);
    sfx.move();
    // 怪物前冲攻击动画 + 勇者受击
    setMonsterAnim('attack');
    later(() => setMonsterAnim('idle'), 560);
    setHeroAnim('hurt');
    later(() => setHeroAnim('idle'), 380);
    addFloater(`-${dmg}`, 'hero');
    if (newHp <= 0) {
      sfx.lose();
      setPhase('dead');
      clearSave();
      setSaveExists(false);
      setPlayer((prev) => ({ ...prev, hp: 0 }));
    } else {
      // 函数式更新，避免覆盖同帧内 MP/HP 的其他变更
      setPlayer((prev) => ({ ...prev, hp: prev.hp - dmg }));
    }
    setBusy(false);
    busyRef.current = false;
  };

  /** 攻击 */
  const doAttack = () => {
    if (busy || busyRef.current || !monster || phaseRef.current !== 'battle') return;
    busyRef.current = true;
    setBusy(true);
    sfx.move();
    pushLog('你挥剑斩向怪物！');
    setHeroAnim('attack');
    const dmg = Math.max(1, player.atk + rand(3) - monster.def);
    later(() => {
      sfx.merge();
      setHeroAnim('idle');
      const newHp = monster.hp - dmg;
      setMonster({ ...monster, hp: newHp });
      addFloater(`-${dmg}`, 'monster');
      if (newHp > 0) {
        // 阶段 2：怪物受击动画结束后，短暂僵直停顿再进入阶段 3 反击
        setMonsterAnim('hit');
        later(() => {
          setMonsterAnim('idle');
          later(() => monsterAttack(), 450); // 受击僵直
        }, 320);
      } else {
        setMonsterAnim('dead');
      }
    }, 380);
  };

  /** 魔法（火球术 / 治疗术） */
  const doMagic = (kind: 'fire' | 'heal') => {
    if (busy || busyRef.current || !monster || phaseRef.current !== 'battle') return;
    if (kind === 'fire' && player.mp < 5) {
      toast('魔法值不足！', 'info');
      return;
    }
    if (kind === 'heal' && player.mp < 4) {
      toast('魔法值不足！', 'info');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    // 函数式扣减 MP，避免与其他状态更新互相覆盖
    setPlayer((prev) => ({ ...prev, mp: prev.mp - (kind === 'fire' ? 5 : 4) }));
    if (kind === 'fire') {
      sfx.merge();
      pushLog('你施放了火球术！🔥');
      setHeroAnim('attack');
      const dmg = Math.max(1, 10 + player.level * 2 + rand(3) - Math.floor(monster.def / 2));
      later(() => {
        setHeroAnim('idle');
        const newHp = monster.hp - dmg;
        setMonster({ ...monster, hp: newHp });
        addFloater(`-${dmg}`, 'monster');
        if (newHp > 0) {
          // 阶段 2：受击动画结束后短暂僵直再反击
          setMonsterAnim('hit');
          later(() => {
            setMonsterAnim('idle');
            later(() => monsterAttack(), 450); // 受击僵直
          }, 320);
        } else {
          setMonsterAnim('dead');
        }
      }, 380);
    } else {
      sfx.flip();
      const before = player.hp;
      pushLog(`你施放了治疗术，恢复了 ${Math.min(player.maxHp, before + 12 + player.level * 2) - before} 点生命 ✨`);
      // 函数式恢复 HP（不覆盖 MP 扣减）
      setPlayer((prev) => ({ ...prev, hp: Math.min(prev.maxHp, prev.hp + 12 + prev.level * 2) }));
      later(() => monsterAttack(), 350);
    }
  };

  /** 防御 */
  const doDefend = () => {
    if (busy || busyRef.current || !monster || phaseRef.current !== 'battle') return;
    busyRef.current = true;
    setBusy(true);
    sfx.click();
    pushLog('你举盾防御，本回合伤害减半 🛡');
    later(() => monsterAttack(2), 350);
  };

  /** 逃跑（Boss 战不可逃跑；成功则逃回城镇满血重来） */
  const doFlee = () => {
    if (busy || busyRef.current || !monster || phaseRef.current !== 'battle') return;
    if (monster.isBoss) {
      toast('恶龙挡住了去路，无法逃跑！', 'info');
      return;
    }
    if (Math.random() < 0.6) {
      busyRef.current = false;
      sfx.flip();
      pushLog('你成功逃回了城镇！');
      toast('逃回城镇，体力完全恢复！', 'success');
      // 恢复满状态，保留等级/金币/击杀
      const rested = { ...playerRef.current, hp: playerRef.current.maxHp, mp: playerRef.current.maxMp };
      setPlayer(rested);
      // 同步落盘：存档层数与城镇"再次出发（第 1 层）"一致，否则旧档会让"继续冒险"拿到深层进度配逃跑前的低 HP
      saveGame(1, rested);
      setSaveExists(true);
      setPhase('town');
    } else {
      busyRef.current = true;
      sfx.mismatch();
      pushLog('逃跑失败！');
      setBusy(true);
      later(() => monsterAttack(), 350);
    }
  };

  /** 从城镇再次出发：保留等级/金币，回到第 1 层 */
  const leaveTown = () => {
    setFloor(1);
    setLog([]);
    pushLog('你再次踏上了冒险之旅！');
    startBattle(1, player);
  };

  /** 怪物死亡结算（胜利 / 升级 / 存档） */
  useEffect(() => {
    if (phase !== 'battle' || !monster || monster.hp > 0) return;
    if (monster.isBoss) {
      sfx.win();
      pushLog('🏆 恶龙倒下了！你救出了公主！');
      best.updateBest(FLOORS, (a, b) => a > b);
      clearSave();
      setSaveExists(false);
      setPhase('victory');
      return;
    }
    const gainedXp = monster.xp;
    const gainedGold = monster.gold;
    pushLog(`你击败了 ${monster.emoji} ${monster.name}！获得 ${gainedXp} 经验、${gainedGold} 金币`);
    const xp = player.xp + gainedXp;
    const gold = player.gold + gainedGold;
    const kills = player.kills + 1;
    // 升级判定（每级消耗对应经验，避免等级膨胀到全程碾压）
    let { level, maxHp, maxMp, atk, def } = player;
    let hp = player.hp;
    let mp = player.mp;
    let leveled = false;
    let remainingXp = xp;
    while (remainingXp >= xpNeed(level)) {
      leveled = true;
      remainingXp -= xpNeed(level);
      level++;
      maxHp += 12;
      maxMp += 5;
      atk += 3;
      def += 2;
      hp = maxHp;
      mp = maxMp;
      pushLog(`⭐ 升级！你现在是 Lv.${level}，状态完全恢复！`);
    }
    if (leveled) {
      sfx.record();
      toast(`升级到 Lv.${level}！`, 'success');
    } else {
      sfx.win();
    }
    const next: PlayerState = { ...player, level, xp: remainingXp, gold, kills, maxHp, maxMp, atk, def, hp, mp };
    setPlayer(next);
    const nextFloorNum = floor + 1 <= FLOORS ? floor + 1 : FLOORS;
    saveGame(nextFloorNum, next);
    setSaveExists(true);
    setPhase('idle');
  }, [monster, phase, player, floor]);

  // 战斗胜利后的过渡：进入下一层
  useEffect(() => {
    if (phase === 'idle') {
      const t = window.setTimeout(() => {
        if (floor >= FLOORS) {
          setPhase('victory');
        } else {
          nextFloor();
        }
      }, 500);
      return () => window.clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // 键盘支持：战斗中 1-5 行动，其余阶段 Enter/空格 触发当前主按钮
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase === 'battle') {
        if (busy) return;
        switch (e.key) {
          case '1':
            doAttack();
            break;
          case '2':
            doMagic('fire');
            break;
          case '3':
            doMagic('heal');
            break;
          case '4':
            doDefend();
            break;
          case '5':
            doFlee();
            break;
        }
        return;
      }
      if (e.key !== 'Enter' && e.key !== ' ') return;
      // 焦点在按钮上时交给浏览器原生激活（Enter/空格会点中它），避免与按钮 click 双触发
      const el = e.target;
      if (el instanceof HTMLElement && el.closest('button')) return;
      e.preventDefault(); // 阻止空格滚动页面
      if (phase === 'menu') (saveExists ? continueGame : newGame)();
      else if (phase === 'town') leaveTown();
      else if (phase === 'dead' || phase === 'victory') newGame();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const hpPct = monster ? Math.max(0, (monster.hp / monster.maxHp) * 100) : 0;
  const playerHpPct = Math.max(0, (player.hp / player.maxHp) * 100);
  const playerMpPct = Math.max(0, (player.mp / player.maxMp) * 100);
  const xpPct = Math.min(100, (player.xp / xpNeed(player.level)) * 100);

  // 攻击前冲距离：按当前怪物体型自适应（保证砍到又不穿透）
  const monH = monster ? (MONSTER_PORTRAITS[monster.name]?.height ?? 160) : 160;
  const sceneW = 640;
  const sidePad = sceneW * 0.12;
  const heroW = 155;
  const gap = Math.max(20, sceneW - sidePad * 2 - heroW - monH);
  const reach = Math.min(150, gap + 14);

  return (
    <GameShell
      meta={metaDragon}
      onBack={() => (window.location.hash = '#/')}
      stats={
        <>
          <div className="stat-box">
            <span>层数</span>
            <strong>{floor}/{FLOORS}</strong>
          </div>
          <div className="stat-box">
            <span>等级</span>
            <strong>Lv.{player.level}</strong>
          </div>
          <div className="stat-box">
            <span>{metaDragon.bestScoreLabel}</span>
            <strong>{best.value ?? '--'}</strong>
          </div>
        </>
      }
    >
      <div className="dq">
        {/* 勇者状态面板 */}
        <div className="dq-player">
          <div className="dq-avatar">⚔️</div>
          <div className="dq-bars">
            <div className="dq-statline">
              <span>勇者 Lv.{player.level}</span>
              <span className="dq-gold">🪙 {player.gold}</span>
              <span className="dq-kills">💀 {player.kills}</span>
            </div>
            <div className="dq-bar hp">
              <div style={{ width: `${playerHpPct}%` }} />
              <span>HP {player.hp}/{player.maxHp}</span>
            </div>
            <div className="dq-bar mp">
              <div style={{ width: `${playerMpPct}%` }} />
              <span>MP {player.mp}/{player.maxMp}</span>
            </div>
            <div className="dq-bar xp">
              <div style={{ width: `${xpPct}%` }} />
              <span>EXP {player.xp}/{xpNeed(player.level)}</span>
            </div>
          </div>
        </div>

        {phase === 'menu' && (
          <div className="dq-menu">
            <div className="dq-menu-icon">🏰</div>
            <h2>勇者斗恶龙</h2>
            <p>恶魔占据了十层迷宫，公主被困在最深处……</p>
            {saveExists && (
              <button className="btn btn-primary dq-btn" onClick={continueGame}>
                ▶ 继续冒险（第 {loadSave()?.floor} 层）
              </button>
            )}
            <button className="btn dq-btn" onClick={newGame}>
              ⚔️ {saveExists ? '新的冒险（清空进度）' : '开始冒险'}
            </button>
            <div className="dq-help">
              <p>每层一个敌人，第 10 层是恶龙 Boss</p>
              <p>任何行动后怪物必反击一次；防御让这次反击伤害减半</p>
              <p>MP 只能靠升级或逃回城镇恢复 · 火球术 5 MP · 治疗术 4 MP</p>
              <p>逃跑约 60% 成功（Boss 不可逃）：回城镇满血满 MP，但要从第 1 层重新出发</p>
              <p>倒下会清空存档，最高层数纪录保留</p>
              <p>快捷键：1 攻击 · 2 火球 · 3 治疗 · 4 防御 · 5 逃跑 · Enter/空格 确认主按钮</p>
            </div>
          </div>
        )}

        {(phase === 'battle' || phase === 'idle') && monster && (
          <div className="dq-battle" key={battleNo}>
            <div className="dq-scene-wrap">
              <div className={`dq-scene ${sceneTheme(floor).cls}`}>
                <div className="dq-scene-deco" aria-hidden>
                  {sceneTheme(floor).deco.map((d, i) => (
                    <span key={i}>{d}</span>
                  ))}
                </div>
                <div className="dq-scene-label">{sceneTheme(floor).label} · 第 {floor} 层</div>
                <div className={`dq-hero ${heroAnim} flip`} style={{ ['--reach' as string]: `${reach}px` }}>
                  <Portrait src={HERO_PORTRAIT} className="dq-hero-canvas" fallback="⚔️" />
                  {heroAnim === 'attack' && <span className="dq-slash" aria-hidden />}
                </div>
                <div
                  className={`dq-monster ${monsterAnim} ${MONSTER_PORTRAITS[monster.name]?.flip ? 'flip' : ''}`}
                  style={{ ['--mh' as string]: `${MONSTER_PORTRAITS[monster.name]?.height ?? 160}px` }}
                >
                  <Portrait
                    src={MONSTER_PORTRAITS[monster.name]?.src ?? MONSTER_PORTRAITS['史莱姆'].src}
                    className="dq-monster-canvas"
                    fallback={monster.emoji}
                  />
                </div>
                {floaters.map((f) => (
                  <span key={f.id} className={`dq-floater ${f.kind}`}>
                    {f.text}
                  </span>
                ))}
                <div className="dq-monster-bar">
                  <span className="dq-monster-name">
                    {monster.isBoss ? '👑 ' : ''}{monster.name}
                  </span>
                  <div className="dq-bar mhp">
                    <div style={{ width: `${hpPct}%` }} />
                    <span>HP {Math.max(0, monster.hp)}/{monster.maxHp}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="dq-log">
              {log.map((m, i) => (
                <p key={i} className={m.includes('升级') || m.includes('恶龙倒') ? 'hl' : ''}>
                  {m}
                </p>
              ))}
            </div>

            {phase === 'battle' && (
              <div className="dq-actions">
                <button className="btn dq-action" onClick={doAttack} disabled={busy}>
                  1 · 攻击<span>ATK {player.atk}</span>
                </button>
                <button className="btn dq-action" onClick={() => doMagic('fire')} disabled={busy || player.mp < 5}>
                  2 · 火球术<span>MP 5 · 高伤害</span>
                </button>
                <button className="btn dq-action" onClick={() => doMagic('heal')} disabled={busy || player.mp < 4}>
                  3 · 治疗术<span>MP 4 · 恢复生命</span>
                </button>
                <button className="btn dq-action" onClick={doDefend} disabled={busy}>
                  4 · 防御<span>伤害减半</span>
                </button>
                <button className="btn dq-action flee" onClick={doFlee} disabled={busy || monster.isBoss}>
                  5 · 逃跑<span>{monster.isBoss ? 'Boss 不可逃跑' : '回城恢复 · 60%'}</span>
                </button>
              </div>
            )}
          </div>
        )}

        {phase === 'town' && (
          <div className="dq-overlay">
            <div className="dq-town-icon">⛺</div>
            <h2>平安回到城镇</h2>
            <p>你休整了一夜，体力完全恢复 ✨</p>
            <p>
              当前 Lv.{player.level} · 金币 🪙 {player.gold} · 击杀 💀 {player.kills}
            </p>
            <button className="btn btn-primary" onClick={leaveTown}>
              ⚔️ 再次出发（第 1 层）
            </button>
          </div>
        )}

        {phase === 'dead' && (
          <div className="dq-overlay">
            <h2>💀 你倒下了……</h2>
            <p>你止步于第 {floor} 层 · Lv.{player.level} · 击杀 {player.kills} 只怪物</p>
            <button className="btn btn-primary" onClick={newGame}>
              再次挑战
            </button>
          </div>
        )}

        {phase === 'victory' && (
          <div className="dq-overlay">
            <h2>🏆 勇者凯旋！</h2>
            <p>你击败了恶龙，救出了公主！王国为你欢呼！</p>
            <p>
              最终等级 Lv.{player.level} · 击杀 {player.kills} 只怪物 · 金币 🪙 {player.gold}
            </p>
            <button className="btn btn-primary" onClick={newGame}>
              开启新一轮冒险
            </button>
          </div>
        )}
      </div>
    </GameShell>
  );
}
