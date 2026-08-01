/* ============ 楼层场景主题 ============ */
export interface SceneTheme {
  cls: string;
  deco: string[];
  label: string;
}

export function sceneTheme(floor: number): SceneTheme {
  if (floor >= 10) return { cls: 'scene-throne', deco: ['👑', '🔥', '🏰', '⚜️'], label: '王座之间' };
  if (floor >= 9) return { cls: 'scene-volcano', deco: ['🌋', '🔥', '🪨', '💥'], label: '火焰山麓' };
  if (floor >= 7) return { cls: 'scene-shadow', deco: ['👁️', '🌑', '🕸️', '💜'], label: '暗影领域' };
  if (floor >= 5) return { cls: 'scene-grave', deco: ['⚰️', '🌫️', '🕯️', '🦉'], label: '幽暗墓地' };
  if (floor >= 3) return { cls: 'scene-cave', deco: ['🪨', '🕯️', '🦇', '🧱'], label: '地下洞穴' };
  return { cls: 'scene-forest', deco: ['🌲', '🌳', '🍄', '🌿'], label: '翠绿森林' };
}
