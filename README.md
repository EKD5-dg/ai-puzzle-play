# 🧩 PuzzlePlay 益智乐园

> 可扩展的网页版益智游戏合集 —— 七款经典游戏，一触即玩，成绩永久保存。

**线上地址：https://puzzle-play.pages.dev**

![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5-646cff?logo=vite&logoColor=white)
![Deploy](https://img.shields.io/badge/Cloudflare-Pages-f38020?logo=cloudflare&logoColor=white)

## 🎮 游戏列表

| 游戏 | 分类 | 难度 | 玩法亮点 |
|------|------|------|---------|
| 🔢 2048 | 逻辑 | 中等 | 合并数字冲击 2048，键盘/触屏滑动 |
| 💣 扫雷 | 逻辑 | 中等 | 三档难度、首次点击安全、右键插旗 |
| 🃏 记忆翻牌 | 记忆 | 简单 | 3D 翻牌动画、三档难度、计时计步 |
| 🧩 数字华容道 | 逻辑 | 中等 | 3×3~5×5、可解洗牌、平滑滑动动画 |
| 🔢 数独 | 逻辑 | 困难 | 唯一解谜题生成、键盘输入、错误检测 |
| 🧱 俄罗斯方块 | 反应 | 困难 | 7-bag 随机、等级加速、下一个预览 |
| 🐉 勇者斗恶龙 | 策略 | 中等 | 回合制 RPG：十层迷宫、升级打怪、击败恶龙 |

## ✨ 特性

- **可扩展架构**：注册表（Registry）模式，新增游戏只需一行注册，大厅/路由/存档自动生效
- **成绩持久化**：最佳分数/步数/时间自动存入 localStorage，大厅实时展示
- **音效系统**：Web Audio 合成音效，零音频资源，一键静音
- **Toast 通知**：新纪录、胜利、失败即时反馈
- **响应式设计**：桌面键盘 + 移动触屏双支持，暗色主题
- **Hash 路由**：`#/game/xxx` 链接可直接分享

## 🚀 本地运行

需要 Node.js 18+。

```bash
npm install        # 安装依赖
npm run dev        # 启动开发服务器（默认 http://localhost:5173）
npm run build      # 类型检查 + 生产构建（输出 dist/）
npm run preview    # 本地预览生产构建
```

## 📁 项目结构

```
src/
├── core/               # 核心框架
│   ├── types.ts        # GameDefinition 类型契约
│   ├── registry.tsx    # ★ 游戏注册表（新增游戏唯一入口）
│   ├── GameShell.tsx   # 统一游戏外壳（标题/统计/返回）
│   ├── useLocalStorage.ts  # 成绩持久化
│   ├── sound.ts        # Web Audio 音效系统
│   └── Toast.tsx       # Toast 通知系统
├── games/              # 各游戏独立模块
│   ├── Game2048.tsx
│   ├── Minesweeper.tsx
│   ├── MemoryMatch.tsx
│   ├── SlidingPuzzle.tsx
│   ├── Sudoku.tsx
│   ├── Tetris.tsx
│   └── DragonQuest.tsx  # 勇者斗恶龙（回合制 RPG）
└── App.tsx             # 大厅（搜索/筛选/统计）
```

## 🛠 如何新增游戏

1. 在 `src/games/` 下新建组件文件（如 `MyGame.tsx`），导出 `meta` 元信息与默认组件：

```tsx
import { GameShell } from '../core/GameShell';
import type { GameMeta } from '../core/types';

export const meta: GameMeta = {
  id: 'my-game',            // 唯一 id（用作路由与存档 key）
  title: '我的游戏',
  description: '一句话介绍',
  icon: '🎲',               // emoji 图标
  difficulty: '简单',       // 简单 | 中等 | 困难
  category: '逻辑',         // 逻辑 | 记忆 | 策略 | 反应 | 经典
  tags: ['标签'],
  bestScoreLabel: '最高分',
};

export default function MyGame() {
  return <GameShell meta={meta} onBack={() => (window.location.hash = '#/')}>{/* 游戏内容 */}</GameShell>;
}
```

2. 在 `src/core/registry.tsx` 注册一行：

```tsx
import MyGame, { meta as metaMyGame } from '../games/MyGame';

export const games: GameDefinition[] = [
  // ...已有游戏
  { meta: metaMyGame, component: MyGame },
];
```

完成！大厅卡片、路由、成绩存档全部自动生效。

## ☁️ 部署（Cloudflare Pages）

### 自动部署（推荐）

推送代码到 `main` 分支后，GitHub Actions 会自动构建并发布，无需任何手动操作。

首次配置：在 GitHub 仓库 **Settings → Secrets and variables → Actions** 添加两个密钥：

| 密钥 | 值 |
|------|-----|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（需 Pages Edit 权限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID（dash 首页 URL 中可查） |

### 手动部署

```bash
npm run build
npx wrangler pages deploy dist --project-name=puzzle-play --branch=main
```

## 📄 技术栈

React 18 · TypeScript 5 · Vite 5 · 无任何 UI 框架依赖

## 🙏 素材致谢

- 勇者与怪物像素精灵：[DawnLike - 16x16 Universal Rogue-like tileset](https://opengameart.org/content/dawnlike-16x16-universal-rogue-like-tileset-v181) by DragonDePlatino（[CC-BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)）
- 楼层场景、血条、光效等 UI 为项目原创代码绘制

## 📜 许可

本项目代码可自由使用与修改，保留原作者署名即可。
第三方素材（DawnLike）遵循其各自的 CC-BY-SA 3.0 许可。
