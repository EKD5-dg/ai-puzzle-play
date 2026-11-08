/**
 * 保龄球十局计分（纯函数）：strike/spare 的补投跨局取用、第 10 局三投规则。
 * 单独成模块以便 Node 测试直接用黄金表校验。
 */

export interface FrameRolls {
  rolls: number[];
}

/** 返回每局结束时的累计分；未完成/数据不足的局为 null */
export function frameTotals(frames: ReadonlyArray<FrameRolls | undefined>): Array<number | null> {
  const flat: number[] = [];
  const starts: number[] = [];
  for (let f = 0; f < 10; f++) {
    starts.push(flat.length);
    for (const v of frames[f]?.rolls ?? []) flat.push(v);
  }
  const totals: Array<number | null> = new Array(10).fill(null);
  let cum = 0;
  for (let f = 0; f < 10; f++) {
    const r = frames[f]?.rolls ?? [];
    if (r.length === 0) break;
    if (f === 9) {
      const complete = r.length === 3 || (r.length === 2 && r[0] !== 10 && r[0] + r[1] < 10);
      if (!complete) break;
      cum += r[0] + r[1] + (r[2] ?? 0);
      totals[9] = cum;
      break;
    }
    const i = starts[f];
    if (r[0] === 10) {
      const n1 = flat[i + 1];
      const n2 = flat[i + 2];
      if (n1 === undefined || n2 === undefined) break;
      cum += 10 + n1 + n2;
    } else if (r.length < 2) {
      break;
    } else if (r[0] + r[1] === 10) {
      const n1 = flat[i + 2];
      if (n1 === undefined) break;
      cum += 10 + n1;
    } else {
      cum += r[0] + r[1];
    }
    totals[f] = cum;
  }
  return totals;
}
