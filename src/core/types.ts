/**
 * 游戏定义类型 - 可扩展架构的核心契约。
 *
 * 新增一个游戏只需：
 * 1. 在 src/games/ 下新建一个组件，导出默认组件；
 * 2. 在 src/core/registry.tsx 中注册一条 GameDefinition；
 * 3. 首页卡片、路由、统计将全部自动生效。
 */
import type { ComponentType, LazyExoticComponent } from 'react';

/** 游戏难度分级 */
export type Difficulty = '简单' | '中等' | '困难';

/** 游戏分类 */
export type Category = '逻辑' | '记忆' | '策略' | '反应' | '经典';

/** 游戏元信息 */
export interface GameMeta {
  /** 唯一 id，用作路由标识与本地存储 key */
  id: string;
  /** 游戏名称 */
  title: string;
  /** 一句话描述 */
  description: string;
  /** 展示用图标（emoji） */
  icon: string;
  /** 难度 */
  difficulty: Difficulty;
  /** 分类 */
  category: Category;
  /** 标签 */
  tags: string[];
  /** 最佳成绩的展示文案，如 "最佳分数" / "最快时间"，用于首页与游戏页统计 */
  bestScoreLabel: string;
  /** 成绩比较方向：true=越大越好（分数/轮数），false=越小越好（步数/时间） */
  higherIsBetter: boolean;
}

/** 完整游戏定义 */
export interface GameDefinition {
  meta: GameMeta;
  /** 游戏组件（无 props，自行管理状态），懒加载以按需分包 */
  component: LazyExoticComponent<ComponentType>;
}

/** 游戏状态钩子返回的存储接口 */
export interface StorageLike {
  get: (key: string) => number | null;
  set: (key: string, value: number) => void;
}
