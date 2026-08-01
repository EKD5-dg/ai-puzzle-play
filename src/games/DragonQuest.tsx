import { useCallback, useEffect, useState } from 'react';
import { GameShell } from '../core/GameShell';
import { useLocalStorage } from '../core/useLocalStorage';
import { useToast } from '../core/Toast';
import { sfx } from '../core/sound';
import { Portrait } from './Portrait';
import { sceneTheme } from './pixelart';
import type { GameMeta } from '../core/types';

/** 角色立绘素材映射（AI 生成，深蓝底自动抠图） */
const PORTRAITS = '/portraits';
const HERO_PORTRAIT = `${PORTRAITS}/hero.png`;
const MONSTER_PORTRAITS: Record<string, string> = {
  史莱姆: `${PORTRAITS}/slime.png`,
  骷髅兵: `${PORTRAITS}/skeleton.png`,
  僵尸: `${PORTRAITS}/zombie.png`,
  暗影幽魂: `${PORTRAITS}/ghost.png`,
  火焰魔: `${PORTRAITS}/firedemon.png`,
  恶龙: `${PORTRAITS}/dragon.png`,
};

export const meta: GameMeta = {
  id: 'dragon-quest',
  title: '勇者斗恶龙',
  description: '挑战十层迷宫，升级变强，击败恶龙救出公主！',
  icon: '🐉',
  difficulty: '中等',
  category: '策略',
  tags: ['RPG', '回合制'],
  bestScoreLabel: '最高层数',
};

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

type Phase = 'menu' | 'battle' | 'idle' | 'dead' | 'victory';

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
    return { name: '恶龙', emoji: '🐉', hp: 130, maxHp: 130, atk: 15, def: 7, xp: 180, gold: 300, isBoss: true };
  }
  const base = MONSTERS[Math.floor((floor - 1) / 2)] ?? MONSTERS[MONSTERS.length - 1];
  const scale = 1 + floor * 0.35;
  return {
    name: base.name,
    emoji: base.emoji,
    hp: Math.round((16 + floor * 7) * scale),
    maxHp: Math.round((16 + floor * 7) * scale),
    atk: 2 + floor * 2,
    def: 1 + floor,
    xp: 8 + floor * 7,
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
}

function clearSave(): void {
  try {
    localStorage.removeItem(`pp:${SAVE_KEY}`);
  } catch {
    /* ignore */
  }
}

const rand = (n: number) => Math.floor(Math.random() * (n + 1));

export default function DragonQuest() {
  const [phase, setPhase] = useState<Phase>('menu');
  const [floor, setFloor] = useState(1);
  const [player, setPlayer] = useState<PlayerState>(PLAYER_START);
  const [monster, setMonster] = useState<Monster | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [battleNo, setBattleNo] = useState(0);
  const [heroAnim, setHeroAnim] = useState<'idle' | 'attack' | 'hurt'>('idle');
  const [monsterAnim, setMonsterAnim] = useState<'idle' | 'hit' | 'dead'>('idle');
  const [saveExists, setSaveExists] = useState(loadSave() !== null);
  const best = useLocalStorage<number>(`best:${meta.id}`);
  const { toast } = useToast();

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
    if (!monster) return;
    let dmg = Math.max(1, monster.atk + rand(2) - player.def);
    if (dmgReduction > 1) dmg = Math.max(1, Math.floor(dmg / dmgReduction));
    const hp = player.hp - dmg;
    pushLog(`${monster.emoji} ${monster.name} 攻击了你，造成 ${dmg} 点伤害`);
    sfx.move();
    setHeroAnim('hurt');
    window.setTimeout(() => setHeroAnim('idle'), 320);
    if (hp <= 0) {
      sfx.lose();
      setPhase('dead');
      clearSave();
      setSaveExists(false);
      setPlayer({ ...player, hp: 0 });
    } else {
      setPlayer({ ...player, hp });
    }
    setBusy(false);
  };

  /** 攻击 */
  const doAttack = () => {
    if (busy || !monster || phase !== 'battle') return;
    setBusy(true);
    sfx.move();
    pushLog('你挥剑斩向怪物！');
    setHeroAnim('attack');
    const dmg = Math.max(1, player.atk + rand(3) - monster.def);
    window.setTimeout(() => {
      sfx.merge();
      setHeroAnim('idle');
      const newHp = monster.hp - dmg;
      setMonster({ ...monster, hp: newHp });
      if (newHp > 0) {
        setMonsterAnim('hit');
        window.setTimeout(() => setMonsterAnim('idle'), 300);
        monsterAttack(); // 怪物反击
      } else {
        setMonsterAnim('dead');
      }
    }, 380);
  };

  /** 魔法（火球术 / 治疗术） */
  const doMagic = (kind: 'fire' | 'heal') => {
    if (busy || !monster || phase !== 'battle') return;
    if (kind === 'fire' && player.mp < 5) {
      toast('魔法值不足！', 'info');
      return;
    }
    if (kind === 'heal' && player.mp < 4) {
      toast('魔法值不足！', 'info');
      return;
    }
    setBusy(true);
    setPlayer({ ...player, mp: player.mp - (kind === 'fire' ? 5 : 4) });
    if (kind === 'fire') {
      sfx.merge();
      pushLog('你施放了火球术！🔥');
      setHeroAnim('attack');
      const dmg = Math.max(1, 10 + player.level * 2 + rand(3) - Math.floor(monster.def / 2));
      window.setTimeout(() => {
        setHeroAnim('idle');
        const newHp = monster.hp - dmg;
        setMonster({ ...monster, hp: newHp });
        if (newHp > 0) {
          setMonsterAnim('hit');
          window.setTimeout(() => setMonsterAnim('idle'), 300);
          monsterAttack(); // 怪物反击
        } else {
          setMonsterAnim('dead');
        }
      }, 380);
    } else {
      sfx.flip();
      const before = player.hp;
      const heal = Math.min(player.maxHp, before + 12 + player.level * 2);
      pushLog(`你施放了治疗术，恢复了 ${heal - before} 点生命 ✨`);
      setPlayer({ ...player, hp: heal });
      window.setTimeout(() => monsterAttack(), 350);
    }
  };

  /** 防御 */
  const doDefend = () => {
    if (busy || !monster || phase !== 'battle') return;
    setBusy(true);
    sfx.click();
    pushLog('你举盾防御，本回合伤害减半 🛡');
    window.setTimeout(() => monsterAttack(2), 350);
  };

  /** 逃跑（Boss 战不可逃跑） */
  const doFlee = () => {
    if (busy || !monster || phase !== 'battle') return;
    if (monster.isBoss) {
      toast('恶龙挡住了去路，无法逃跑！', 'info');
      return;
    }
    if (Math.random() < 0.55) {
      sfx.flip();
      pushLog('你成功逃跑了！');
      toast('逃回上一层', 'info');
      const f = Math.max(1, floor - 1);
      setFloor(f);
      saveGame(f, player);
      window.setTimeout(() => startBattle(f, player), 300);
    } else {
      sfx.mismatch();
      pushLog('逃跑失败！');
      setBusy(true);
      window.setTimeout(() => monsterAttack(), 350);
    }
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
    // 升级判定
    let { level, maxHp, maxMp, atk, def } = player;
    let hp = player.hp;
    let mp = player.mp;
    let leveled = false;
    while (xp >= xpNeed(level)) {
      leveled = true;
      level++;
      maxHp += 10;
      maxMp += 4;
      atk += 2;
      def += 1;
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
    const next: PlayerState = { ...player, level, xp, gold, kills, maxHp, maxMp, atk, def, hp, mp };
    setPlayer(next);
    const nextFloorNum = floor + 1 <= FLOORS ? floor + 1 : FLOORS;
    saveGame(nextFloorNum, next);
    setSaveExists(true);
    setPhase('idle');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monster, phase]);

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

  // 键盘支持：1 攻击 2 火球 3 治疗 4 防御 5 逃跑
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase !== 'battle' || busy) return;
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
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const hpPct = monster ? Math.max(0, (monster.hp / monster.maxHp) * 100) : 0;
  const playerHpPct = Math.max(0, (player.hp / player.maxHp) * 100);
  const playerMpPct = Math.max(0, (player.mp / player.maxMp) * 100);
  const xpPct = Math.min(100, (player.xp / xpNeed(player.level)) * 100);

  return (
    <GameShell
      meta={meta}
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
            <span>{meta.bestScoreLabel}</span>
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
              <p>快捷键：1 攻击 · 2 火球 · 3 治疗 · 4 防御 · 5 逃跑</p>
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
                <div className={`dq-hero ${heroAnim}`}>
                  <Portrait src={HERO_PORTRAIT} className="dq-hero-canvas" />
                  {heroAnim === 'attack' && <span className="dq-slash" aria-hidden />}
                </div>
                <div className={`dq-monster ${monsterAnim}`}>
                  <Portrait
                    src={MONSTER_PORTRAITS[monster.name] ?? MONSTER_PORTRAITS['史莱姆']}
                    className="dq-monster-canvas"
                  />
                </div>
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
                  5 · 逃跑<span>{monster.isBoss ? 'Boss 不可逃跑' : '55% 成功率'}</span>
                </button>
              </div>
            )}
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
