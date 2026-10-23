// The buy-decision rule, shared by the dashboard (window.Deal) and Node
// (the nightly summary), so both count the same cars as Chancen.
(function (root) {
  // A reference offer (pricing/calibration.json) sets the margin. It already
  // covers holding cost, so no Standkosten on top. Otherwise 15% margin plus
  // 95 days × €10 on the lot.
  function defaultTerms(calibration) {
    return calibration
      ? { margin: calibration.impliedMarginPct / 100, holdDays: 0, holdCost: 10 }
      : { margin: 0.15, holdDays: 95, holdCost: 10 };
  }

  // buy target = market/(1+margin) minus the cost of the car standing on the
  // lot until resale (Standtage × €/Tag), the standard dealer formula
  function withDeal(l, { margin, holdDays, holdCost }) {
    const holding = Math.round(holdDays * holdCost);
    const maxBuy = Math.max(0, Math.round(l.marketPrice / (1 + margin)) - holding);
    // a genuine buy is below the target, in the model's range, vetted and not
    // flagged for accident/defect/salvage by the labeling pass, and its listing
    // data is self-consistent (a title-corrected car needs a human check first)
    const isDealNow = l.asking != null && l.asking <= maxBuy && !l.extrapolated && !l.flagged &&
      !l.pendingLabel && !l.corrections?.length && !l.implausiblePrice;
    return { ...l, maxBuy, holding, isDealNow };
  }

  const api = { defaultTerms, withDeal };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Deal = api;
})(this);
