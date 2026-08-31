export const PLANS = {
  gratis: {
    id: 'gratis',
    navn: 'Gratis',
    prisNok: 0,
    maxWatches: 3,
    // Gratisplanen får kun daglig oppsummering. Det holder e-postvolumet nede
    // og gir en reell grunn til å oppgradere.
    tvungenDaglig: true,
    webhook: false,
    api: false,
    maxExtraRecipients: 0,
    beskrivelse: 'Prøv det på tre selskaper.',
    punkter: ['3 selskaper', 'Daglig oppsummering på e-post', 'Alle hendelsestyper'],
  },
  solo: {
    id: 'solo',
    navn: 'Solo',
    prisNok: 249,
    maxWatches: 50,
    tvungenDaglig: false,
    webhook: true,
    api: false,
    maxExtraRecipients: 2,
    beskrivelse: 'For deg som følger en kundeportefølje.',
    punkter: [
      '50 selskaper',
      'Varsel med én gang, ikke bare daglig',
      'Slack- eller webhook-varsling',
      'CSV-import',
      '3 mottakere',
    ],
  },
  byraa: {
    id: 'byraa',
    navn: 'Byrå',
    prisNok: 749,
    maxWatches: 1000,
    tvungenDaglig: false,
    webhook: true,
    api: true,
    maxExtraRecipients: 9,
    beskrivelse: 'For regnskapsbyrå og inkasso med mange kunder.',
    punkter: [
      '1000 selskaper',
      'Varsel med én gang',
      'Slack- eller webhook-varsling',
      'REST-API med API-nøkkel',
      '10 mottakere',
    ],
  },
};

export const PAID_PLAN_IDS = ['solo', 'byraa'];

export function getPlan(planId) {
  return PLANS[planId] || PLANS.gratis;
}

/** Plan som gjelder når abonnementet ikke er i orden, faller tilbake til gratis. */
export function effectivePlan(account) {
  if (!account) return PLANS.gratis;
  if (account.status === 'canceled') return PLANS.gratis;
  return getPlan(account.plan);
}

export function planFromPriceId(priceId, prices) {
  if (priceId && priceId === prices.solo) return 'solo';
  if (priceId && priceId === prices.byraa) return 'byraa';
  return null;
}

/** Effektiv leveringsmodus: gratisplanen tvinges til daglig oppsummering. */
export function effectiveDeliveryMode(account) {
  const plan = effectivePlan(account);
  if (plan.tvungenDaglig) return 'daglig';
  return account.delivery_mode === 'daglig' ? 'daglig' : 'straks';
}
