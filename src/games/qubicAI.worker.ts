/**
 * 立体井字的 AI 搜索 Worker：困难档一次要跑两万多个节点，
 * 放在主线程上会让渲染循环停摆、触摸与点击被延迟（低端手机上可达数百毫秒）。
 * 模块里只有纯计算，不碰 DOM，可以整体搬进 Worker。
 */
import { chooseMove } from './qubicAI';

interface Req {
  id: number;
  board: number[];
  level: number;
}

// 不依赖 webworker 的 lib 类型：结构化声明 self 上用得着的两个成员
const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<Req>) => void) | null;
  postMessage: (msg: { id: number; move: number; ms: number }) => void;
};

scope.onmessage = (ev: MessageEvent<Req>) => {
  const { id, board, level } = ev.data;
  const { move, ms } = chooseMove(board, level);
  scope.postMessage({ id, move, ms });
};
