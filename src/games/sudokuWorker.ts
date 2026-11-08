/** 数独生成 Worker：困难档回溯可达数百毫秒，放到 Worker 避免冻结主线程 */
import { generatePuzzle } from './sudokuCore';

interface Req {
  id: number;
  blanks: number;
}

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<Req>) => void) | null;
  postMessage: (msg: { id: number; puzzle: number[]; solution: number[]; blanks: number }) => void;
};

scope.onmessage = (ev: MessageEvent<Req>) => {
  const { id, blanks } = ev.data;
  const result = generatePuzzle(blanks);
  scope.postMessage({ id, ...result });
};
