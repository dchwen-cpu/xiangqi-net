// rating.js —— Glicko-2 棋力评分（Glickman 标准算法）
// 用法：updatePlayer({rating,rd,vol}, [{rating,rd,score}]) → 返回更新后的 {rating,rd,vol}
//   score: 胜=1  和=0.5  负=0
// 单局对弈时 opponents 只有一个元素。

const SCALE = 173.7178;   // Glicko-2 内部尺度
const TAU   = 0.5;        // 系统常数：控制波动率变化幅度，0.3~1.2，越小越稳

function g(phi){ return 1 / Math.sqrt(1 + 3*phi*phi/(Math.PI*Math.PI)); }
function E(mu, muj, phij){ return 1 / (1 + Math.exp(-g(phij)*(mu-muj))); }

// player: {rating, rd, vol}   opponents: [{rating, rd, score}]
function updatePlayer(player, opponents){
  const mu  = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.vol;

  if(!opponents || !opponents.length){
    // 没有对局：RD 随时间增大（此处按一个周期处理）
    const phiStar = Math.sqrt(phi*phi + sigma*sigma);
    return { rating: player.rating, rd: Math.min(phiStar*SCALE, 350), vol: sigma };
  }

  // 第 2、3 步：v 和 Δ
  let vInv = 0, dSum = 0;
  for(const o of opponents){
    const muj  = (o.rating - 1500) / SCALE;
    const phij = o.rd / SCALE;
    const gj   = g(phij);
    const Ej   = E(mu, muj, phij);
    vInv += gj*gj * Ej * (1-Ej);
    dSum += gj * (o.score - Ej);
  }
  const v = 1 / vInv;
  const delta = v * dSum;

  // 第 5 步：迭代求新波动率 σ'（Illinois 算法）
  const a = Math.log(sigma*sigma);
  const f = (x) => {
    const ex = Math.exp(x);
    const t1 = ex*(delta*delta - phi*phi - v - ex) / (2*Math.pow(phi*phi+v+ex,2));
    const t2 = (x - a) / (TAU*TAU);
    return t1 - t2;
  };
  let A = a, B;
  if(delta*delta > phi*phi + v){
    B = Math.log(delta*delta - phi*phi - v);
  } else {
    let k = 1;
    while(f(a - k*TAU) < 0) k++;
    B = a - k*TAU;
  }
  let fA = f(A), fB = f(B);
  let iter = 0;
  while(Math.abs(B - A) > 1e-6 && iter++ < 100){
    const C = A + (A - B)*fA/(fB - fA);
    const fC = f(C);
    if(fC*fB <= 0){ A = B; fA = fB; } else { fA = fA/2; }
    B = C; fB = fC;
  }
  const sigmaNew = Math.exp(A/2);

  // 第 6、7 步：更新 RD 和 rating
  const phiStar = Math.sqrt(phi*phi + sigmaNew*sigmaNew);
  const phiNew  = 1 / Math.sqrt(1/(phiStar*phiStar) + 1/v);
  const muNew   = mu + phiNew*phiNew * dSum;

  return {
    rating: muNew*SCALE + 1500,
    rd:     Math.min(phiNew*SCALE, 350),   // RD 上限 350
    vol:    sigmaNew,
  };
}

module.exports = { updatePlayer };
