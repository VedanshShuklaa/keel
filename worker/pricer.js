// Digital-option fair-value pricer for DreamDEX Event Contracts.
// P(Up) = Phi( (S - K) / (sigma_s * S * sqrt(tau)) )

function erf(x) {
  // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// ticks: array of {t: seconds, price: number}, ascending by t.
// Returns per-second volatility from RMS log return between consecutive ticks.
function sigmaPerSecond(ticks) {
  if (ticks.length < 2) return null;
  let sumSq = 0;
  let n = 0;
  for (let i = 1; i < ticks.length; i++) {
    const dt = ticks[i].t - ticks[i - 1].t;
    if (dt <= 0) continue;
    const r = Math.log(ticks[i].price / ticks[i - 1].price);
    sumSq += (r * r) / dt;
    n++;
  }
  if (n === 0) return null;
  return Math.sqrt(sumSq / n);
}

// S: current price, K: strike (open price), tauSeconds: time remaining,
// sigmaS: per-second volatility. Returns P(Up) in [0,1].
function fairValue(S, K, tauSeconds, sigmaS) {
  if (tauSeconds <= 0) return S >= K ? 1 : 0;
  const denom = sigmaS * S * Math.sqrt(tauSeconds);
  // Zero volatility means the price cannot move again before expiry, so the
  // outcome is already determined. Return the same hard 0/1 the tau <= 0 branch
  // above returns; the earlier 0.5 here claimed maximum uncertainty in exactly
  // the case where there is none.
  if (denom <= 0) return S >= K ? 1 : 0;
  const d = (S - K) / denom;
  return normalCdf(d);
}

export { erf, normalCdf, sigmaPerSecond, fairValue };
