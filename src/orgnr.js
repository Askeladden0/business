// Norske organisasjonsnummer er 9 siffer med mod-11-kontrollsiffer.
const WEIGHTS = [3, 2, 7, 6, 5, 4, 3, 2];

/** Fjerner mellomrom, punktum og bindestrek. Returnerer kun sifrene. */
export function normalizeOrgnr(input) {
  if (input === null || input === undefined) return '';
  return String(input).replace(/[\s.\-]/g, '');
}

/** True hvis strengen er et gyldig organisasjonsnummer (9 siffer + mod-11). */
export function isValidOrgnr(input) {
  const orgnr = normalizeOrgnr(input);
  if (!/^\d{9}$/.test(orgnr)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i += 1) sum += Number(orgnr[i]) * WEIGHTS[i];
  const remainder = sum % 11;
  const check = remainder === 0 ? 0 : 11 - remainder;
  // Rest 1 gir kontrollsiffer 10, som ikke finnes — nummeret er da ugyldig.
  if (check === 10) return false;
  return check === Number(orgnr[8]);
}

/** "912345678" -> "912 345 678" */
export function formatOrgnr(input) {
  const orgnr = normalizeOrgnr(input);
  if (!/^\d{9}$/.test(orgnr)) return String(input ?? '');
  return `${orgnr.slice(0, 3)} ${orgnr.slice(3, 6)} ${orgnr.slice(6)}`;
}

/**
 * Plukker organisasjonsnummer ut av fritekst eller CSV. Tåler kolonner,
 * semikolon, anførselstegn, overskriftsrad og formatering med mellomrom.
 * Returnerer { valid: string[], invalid: string[] } med unike treff.
 */
export function parseOrgnrList(text) {
  const valid = new Set();
  const invalid = new Set();
  if (!text) return { valid: [], invalid: [] };

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Del på vanlige skilletegn, men behold sifre som er delt med mellomrom
    // ved først å slå sammen "912 345 678" til ett token.
    const collapsed = line.replace(/(\d{3})\s(\d{3})\s(\d{3})/g, '$1$2$3');
    const tokens = collapsed.split(/[,;\t|]+/).map((t) => t.trim().replace(/^"|"$/g, ''));
    let matchedOnLine = false;
    for (const token of tokens) {
      const candidate = normalizeOrgnr(token);
      if (!/^\d{9}$/.test(candidate)) continue;
      matchedOnLine = true;
      if (isValidOrgnr(candidate)) valid.add(candidate);
      else invalid.add(candidate);
    }
    if (!matchedOnLine) {
      // En linje med sifre som ikke er 9 lange er sannsynligvis en skrivefeil
      // og bør rapporteres tilbake, ikke ignoreres i stillhet.
      // Nedre grense på 5 fanger opp avkortede organisasjonsnumre uten å
      // flagge årstall (4 siffer) i en kolonne ved siden av.
      const digits = collapsed.replace(/\D/g, '');
      if (digits.length >= 5 && digits.length <= 12) invalid.add(digits);
    }
  }
  return { valid: [...valid], invalid: [...invalid] };
}
